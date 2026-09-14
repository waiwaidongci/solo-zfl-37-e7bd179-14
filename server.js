import http from "node:http";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_FILE || join(__dirname, "data", "ink-stick-testing.json");
const bakPath = dbPath + ".bak";
const port = Number(process.env.PORT || 3037);
const TEST_MODE = process.env.TEST_MODE === "1";
const EXPIRE_SOON_DAYS = 30;

const SCOPES = ["松烟墨试磨", "油烟墨试磨", "漆烟墨试磨", "重点复磨"];
const stages = ["待试磨", "已接单", "已试磨", "重点观察"];
const statLabels = ["待试磨", "已接单", "已试磨", "重点观察"];
const fields = [["code", "墨锭编号", "text"], ["smokeSource", "烟料来源", "text"], ["glueRatio", "胶料比例", "text"], ["ageYears", "存放年限", "number"], ["storage", "存放位置", "text"]];
const extraFields = [["paper", "试磨纸张"], ["water", "加水量"], ["speed", "出墨速度"], ["colorLayer", "墨色层次"], ["sediment", "沉淀情况"], ["score", "评分"]];

const seed = {
  users: [
    { id: "u-admin", name: "文管事", roles: ["admin"] },
    { id: "u-reviewer", name: "审核·墨问", roles: ["reviewer"] },
    { id: "u-t1", name: "试验员·青松", roles: ["tester"], disabled: false },
    { id: "u-t2", name: "试验员·砚秋", roles: ["tester"], disabled: false }
  ],
  qualifications: [
    {
      id: "q-seed-1", testerId: "u-t1", version: 1, parentId: null,
      scopes: ["松烟墨试磨", "油烟墨试磨"],
      training: [{ at: "2026-01-10", course: "松烟/油烟基础试磨培训", hours: 16 }],
      validFrom: "2026-01-15", validUntil: "2027-01-14",
      status: "approved", enteredBy: "u-admin", reviewedBy: "u-reviewer",
      enteredAt: "2026-01-12T09:00:00.000Z", reviewedAt: "2026-01-14T09:00:00.000Z",
      supersededAt: null, rejectReason: null, suspensions: []
    }
  ],
  idem: {},
  items: [
    {
      code: "IS-001", scope: "松烟墨试磨", smokeSource: "黄山松烟", glueRatio: "7.5%", ageYears: 8, storage: "恒湿柜B", status: "已试磨",
      logs: [{ at: "2026-06-11", step: "试磨", note: "宣纸20滴水，出墨快，评分86", score: 86 }]
    },
    {
      code: "IS-002", scope: "油烟墨试磨", smokeSource: "桐油烟", glueRatio: "8%", ageYears: 3, storage: "试样盒C", status: "待试磨", logs: []
    }
  ]
};

/* ---------------- 存储：原子写、备份、恢复 ---------------- */

async function loadDb() {
  if (!existsSync(dbPath)) {
    if (existsSync(bakPath)) {
      // 崩溃窗口：主文件已改名/缺失但备份完好（上次落盘停在中途）
      const db = migrate(JSON.parse(await readFile(bakPath, "utf8")));
      await writeFile(dbPath, JSON.stringify(db, null, 2));
      await rm(dbPath + ".tmp", { force: true }).catch(() => {});
      db.__recovered = true;
      return db;
    }
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return migrate(structuredClone(seed));
  }
  let text;
  try {
    text = await readFile(dbPath, "utf8");
    return migrate(JSON.parse(text));
  } catch (error) {
    if (existsSync(bakPath)) {
      const backup = await readFile(bakPath, "utf8");
      const db = migrate(JSON.parse(backup));
      // 主文件损坏：用上一份完好备份恢复主文件
      await writeFile(dbPath, JSON.stringify(db, null, 2));
      db.__recovered = true;
      return db;
    }
    throw new Error("db_unreadable:" + error.message);
  }
}

function migrate(db) {
  db.users ||= structuredClone(seed.users);
  db.qualifications ||= [];
  db.audit ||= [];
  db.idem ||= {};
  db.items ||= [];
  for (const item of db.items) {
    item.scope ||= SCOPES[0];
    item.logs ||= [];
  }
  for (const q of db.qualifications) q.suspensions ||= [];
  return db;
}

let faultMode = null; // 测试故障注入：null | "prewrite" | "after_main_rename"
async function saveDb(db) {
  const payload = JSON.stringify(db, null, 2);
  const tmp = dbPath + ".tmp";
  if (TEST_MODE && faultMode === "prewrite") {
    faultMode = null;
    throw Object.assign(new Error("simulated_disk_failure"), { code: "ENOSPC", error: "ENOSPC" });
  }
  await writeFile(tmp, payload);
  // POSIX rename 原子替换：主文件 -> .bak（提交点之前的完好状态），不会出现两者皆空的窗口
  if (existsSync(dbPath)) await rename(dbPath, bakPath);
  if (TEST_MODE && faultMode === "after_main_rename") {
    faultMode = null;
    throw Object.assign(new Error("simulated_crash_mid_rename"), { code: "EIO", error: "EIO" });
  }
  // 提交点：tmp 原子替换为主文件
  await rename(tmp, dbPath);
  // 提交成功后把备份刷新到最新已提交态（尽力而为；此处失败不影响已提交的主文件）
  try { await writeFile(bakPath, payload); } catch {}
}

/* ---------------- 串行化：同一进程内所有写操作互斥 ---------------- */

let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(() => task());
  chain = run.catch(() => {});
  return run;
}

/* ---------------- 领域逻辑 ---------------- */

function todayOf(at) {
  return new Date(at).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / 86400000);
}

function isWithinSuspension(q, at) {
  const day = todayOf(at);
  return q.suspensions.some(s => day >= s.from && (!s.to || day <= s.to));
}
function hasSuspensionAt(q, day) {
  return q.suspensions.some(s =>
    day >= s.from && (!s.to || day <= s.to) && !(s.resumeDay && day >= s.resumeDay));
}

/** 资质版本在 at 时刻的状态：active / suspended / expired / pending / rejected / superseded */
function versionStatusAt(q, at) {
  const day = todayOf(at);
  if (q.status === "pending") return "pending";
  if (q.status === "rejected") return "rejected";
  if (q.status === "approved") {
    if (q.supersededAt && day >= q.supersededAt) return "superseded";
    if (day < q.validFrom) return "pending";
    if (day > q.validUntil) return "expired";
    if (hasSuspensionAt(q, day)) return "suspended";
    return "active";
  }
  return q.status;
}

/**
 * 续期草稿（有 parentId 的 pending/rejected）不影响现行准入：
 * 审核期间回退到最近的已批准版本判断；首次录入（无 parentId）仍按 pending/rejected 拒绝。
 */
function effectiveVersion(db, testerId) {
  const versions = db.qualifications
    .filter(q => q.testerId === testerId)
    .sort((a, b) => b.version - a.version);
  if (!versions.length) return { versions: [], latest: null, effective: null };
  const latest = versions[0];
  if ((latest.status === "pending" || latest.status === "rejected") && latest.parentId) {
    return { versions, latest, effective: versions.find(q => q.status === "approved") || latest };
  }
  return { versions, latest, effective: latest };
}

/** 试验员当前对外准入状态（聚合现行版本） */
function testerStatus(db, testerId, at) {
  const { effective } = effectiveVersion(db, testerId);
  if (!effective) return { state: "无资质", qualificationId: null };
  const status = versionStatusAt(effective, at);
  const map = {
    active: "有效",
    suspended: "已暂停",
    expired: "已过期",
    superseded: "已续期替换",
    pending: "待审核",
    rejected: "审核驳回"
  };
  return { state: map[status] || status, qualificationId: effective.id, versionStatus: status, version: effective.version };
}

/**
 * 准入判断。返回 { allowed, reason, qualificationId, version, snapshot }
 * 新动作一律按操作时刻(at)的现行资质判断；历史动作的判断以当时写入的快照为准。
 */
function evaluate(db, testerId, scope, at) {
  const user = db.users.find(u => u.id === testerId);
  const userDeny = (reason, message) => ({ allowed: false, reason, message, qualificationId: null, version: null, snapshot: null });
  if (!user) return userDeny("tester_not_found", "试验员不存在");
  if (!user.roles?.includes("tester")) return userDeny("not_a_tester", "该账号不是试验员");
  if (user.disabled) return userDeny("tester_disabled", "试验员账号已停用，禁止作业");

  const { versions, latest, effective } = effectiveVersion(db, testerId);
  if (!effective) return deny("no_qualification", "尚无资质记录，不能接单", null);

  const status = versionStatusAt(effective, at);
  const q = effective;
  if (status === "pending") return deny("qualification_pending", "资质正在审核中，尚未生效", q);
  if (status === "rejected") return deny("qualification_rejected", "资质审核已驳回：" + (q.rejectReason || "未说明"), q);
  if (status === "expired") return deny("qualification_expired", `资质已于 ${q.validUntil} 过期，请先续期`, q);
  if (status === "suspended") return deny("qualification_suspended", "资质处于暂停期，复核恢复后方可操作", q);
  if (status === "superseded") return deny("qualification_superseded", "资质版本已被替换", q);
  if (!q.scopes.includes(scope)) {
    return deny("scope_mismatch", `资质范围为【${q.scopes.join("、")}】，不含本次试磨范围【${scope}】，属超范围作业`, q);
  }
  const snapshot = makeSnapshot(q, at);
  return { allowed: true, reason: null, qualificationId: q.id, version: q.version, snapshot };

  function deny(reason, message, qv) {
    return {
      allowed: false, reason, message,
      qualificationId: (qv || latest || versions[0] || {}).id || null,
      version: (qv || latest || versions[0] || {}).version || null,
      snapshot: null
    };
  }
}

function makeSnapshot(q, at) {
  return {
    qualificationId: q.id, version: q.version, scopes: [...q.scopes],
    validFrom: q.validFrom, validUntil: q.validUntil,
    statusAtAction: versionStatusAt(q, at), evaluatedAt: at
  };
}

function audit(db, entry) {
  const row = { id: newId("a"), ...entry };
  db.audit.push(row);
  return row;
}

/* ---------------- HTTP 辅助 ---------------- */

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
function getUser(db, id) { return db.users.find(u => u.id === id); }
function requireActor(db, input) {
  const user = getUser(db, input.actorId);
  if (!user) throw httpError(400, "unknown_actor", "操作人不存在或未选择");
  return user;
}
function requireManager(db, input, action) {
  const user = requireActor(db, input);
  if (!user.roles.some(r => ["admin", "reviewer"].includes(r))) {
    throw httpError(403, "forbidden", "只有管理员或审核角色可以" + action + "，试验员无权操作");
  }
  return user;
}
function httpError(status, error, message) { return Object.assign(new Error(message || error), { status, error }); }

function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tests || []).length;
  return { ...item, logCount };
}

/* ---------------- 路由处理（均在锁内，读改写一次落盘） ---------------- */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/") return html(res, page());
  if (req.method === "GET" && p === "/api/scopes") return send(res, 200, SCOPES);

  // 测试钩子
  if (TEST_MODE && req.method === "POST" && p === "/__test/fail-next-write") {
    const input = await body(req).catch(() => ({}));
    faultMode = input.mode || "prewrite";
    return send(res, 200, { ok: true, mode: faultMode });
  }
  if (TEST_MODE && req.method === "POST" && p === "/__test/set-fixed-at") {
    const input = await body(req);
    global.__FIXED_AT__ = input.at || null;
    return send(res, 200, { ok: true, at: global.__FIXED_AT__ });
  }

  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutating) {
    return withLock(() => route(req, res, url));
  }
  return route(req, res, url);
}

async function route(req, res, url) {
  const p = url.pathname;
  const db = await loadDb();

  if (req.method === "GET" && p === "/api/items") return send(res, 200, db.items.map(summarize));
  if (req.method === "GET" && p === "/api/stats") return send(res, 200, computeStats(db.items));
  if (req.method === "GET" && p === "/api/users") return send(res, 200, db.users);
  if (req.method === "GET" && p === "/api/qualifications") {
    const testerId = url.searchParams.get("testerId");
    const list = db.qualifications
      .filter(q => !testerId || q.testerId === testerId)
      .sort((a, b) => b.version - a.version)
      .map(q => ({ ...q, testerName: getUser(db, q.testerId)?.name, currentStatus: versionStatusAt(q, nowIso()) }));
    return send(res, 200, list);
  }
  if (req.method === "GET" && p === "/api/tester-status") {
    const at = url.searchParams.get("at") || nowIso();
    const testers = db.users.filter(u => u.roles.includes("tester")).map(u => {
      const { latest, effective } = effectiveVersion(db, u.id);
      const st = effective ? versionStatusAt(effective, at) : "none";
      const pendingDraft = latest && (latest.status === "pending" || latest.status === "rejected") && latest.parentId;
      let expiringSoon = false;
      if (st === "active" && daysBetween(todayOf(at), effective.validUntil) <= EXPIRE_SOON_DAYS) expiringSoon = true;
      return {
        userId: u.id, name: u.name, disabled: !!u.disabled,
        state: testerStatus(db, u.id, at).state, versionStatus: st,
        qualificationId: effective?.id || null, version: effective?.version || null,
        scopes: effective && (st === "active" || st === "suspended") ? effective.scopes : [],
        validUntil: effective?.validUntil || null, expiringSoon,
        pendingRenewal: pendingDraft ? { version: latest.version, status: latest.status } : null
      };
    });
    return send(res, 200, testers);
  }
  if (req.method === "GET" && p === "/api/audit") {
    const testerId = url.searchParams.get("testerId");
    const list = [...db.audit]
      .filter(a => !testerId || a.testerId === testerId)
      .reverse();
    return send(res, 200, list);
  }

  /* ---- 墨锭建档：任何角色都只能建为「待试磨」，终态只能经接单/试磨产生 ---- */
  if (req.method === "POST" && p === "/api/items") {
    const input = await body(req);
    requireActor(db, input);
    if (input.status && input.status !== "待试磨") {
      throw httpError(400, "terminal_status_forbidden", "建档只能是「待试磨」，接单与试磨终态必须由本人持有效资质操作产生");
    }
    const item = {
      id: newId("IS"), code: input.code, scope: input.scope || SCOPES[0],
      smokeSource: input.smokeSource, glueRatio: input.glueRatio,
      ageYears: input.ageYears, storage: input.storage,
      status: "待试磨",
      logs: [{ at: nowIso(), step: "建档", note: "创建墨锭" }]
    };
    db.items.unshift(item);
    await persist(db, req, res, 201, item);
    return;
  }

  const patch = p.match(/^\/api\/items\/([^/]+)$/);
  if (patch && req.method === "PATCH") {
    const input = await body(req);
    const actor = requireActor(db, input);
    if (!actor.roles.some(r => ["admin", "reviewer"].includes(r))) throw httpError(403, "forbidden", "只有管理员可调整墨锭信息");
    const item = findItem(db, patch[1]);
    if (!item) return send(res, 404, { error: "item_not_found" });
    if (input.status && input.status !== item.status) {
      // 状态机只能由接单/试磨驱动，禁止通过通用更新接口改状态（含已试磨、重点观察等终态）
      throw httpError(400, "status_change_forbidden", "墨锭状态只能由接单、试磨流程产生，不能直接改写");
    }
    for (const key of ["scope", "smokeSource", "glueRatio", "ageYears", "storage", "code"]) {
      if (input[key] !== undefined) item[key] = input[key];
    }
    item.logs ||= [];
    item.logs.push({ at: nowIso(), step: "信息", note: actor.name + " 更新墨锭信息" });
    audit(db, { at: nowIso(), type: "item_info_patched", actorId: actor.id, actorName: actor.name, itemCode: item.code, detail: `管理员更新 ${item.code} 信息`, allowed: true });
    await persist(db, req, res, 200, item);
    return;
  }

  /* ---- 资质录入 ---- */
  if (req.method === "POST" && p === "/api/qualifications") {
    const input = await body(req);
    const actor = requireActor(db, input);
    if (!actor.roles.some(r => ["admin", "reviewer"].includes(r))) throw httpError(403, "forbidden", "只有管理员可录入资质");
    const tester = getUser(db, input.testerId);
    if (!tester || !tester.roles.includes("tester")) throw httpError(400, "bad_tester", "请选择有效试验员");
    const scopes = normalizeScopes(input.scopes);
    if (!scopes.length) throw httpError(400, "bad_scopes", "资质范围不能为空");
    if (!input.validUntil) throw httpError(400, "bad_validity", "请填写有效期");
    const existing = db.qualifications.filter(q => q.testerId === input.testerId && q.status === "pending");
    if (existing.length) throw httpError(409, "pending_exists", "该试验员已有待审核的资质申请，不能重复录入");
    const version = (db.qualifications.filter(q => q.testerId === input.testerId).reduce((m, q) => Math.max(m, q.version), 0)) + 1;
    const q = {
      id: newId("q"), testerId: input.testerId, version, parentId: null,
      scopes,
      training: Array.isArray(input.training) ? input.training : [{ at: nowIso().slice(0, 10), course: String(input.training || ""), hours: Number(input.trainingHours) || 0 }],
      validFrom: input.validFrom || todayOf(nowIso()), validUntil: input.validUntil,
      status: "pending", enteredBy: actor.id, reviewedBy: null,
      enteredAt: nowIso(), reviewedAt: null, supersededAt: null, rejectReason: null, suspensions: []
    };
    db.qualifications.push(q);
    audit(db, { at: nowIso(), type: "qualification_entered", actorId: actor.id, actorName: actor.name, testerId: tester.id, testerName: tester.name, qualificationId: q.id, version, detail: `录入资质 v${version}，范围：${scopes.join("、")}，有效期至 ${q.validUntil}`, allowed: true });
    await persist(db, req, res, 201, q);
    return;
  }

  /* ---- 资质审核（录入人不能是审核人；并发/重复只成功一次） ---- */
  const reviewMatch = p.match(/^\/api\/qualifications\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireActor(db, input);
    const q = db.qualifications.find(x => x.id === reviewMatch[1]);
    if (!q) throw httpError(404, "qualification_not_found", "资质不存在");
    if (q.enteredBy === actor.id) throw httpError(403, "reviewer_is_enterer", "审核人不能是录入人本人");
    if (!actor.roles.some(r => ["admin", "reviewer"].includes(r))) throw httpError(403, "forbidden", "无审核权限");
    const tester = getUser(db, q.testerId);
    // CAS：只有仍处于 pending 才能推进；锁保证并发审核只有一个进入并成功
    if (q.status !== "pending") {
      audit(db, { at: nowIso(), type: "review_duplicate", actorId: actor.id, actorName: actor.name, testerId: q.testerId, testerName: tester.name, qualificationId: q.id, version: q.version, detail: `重复/并发审核被拒绝：该资质已是「${q.status}」`, allowed: false });
      await persist(db, req, res, 409, { error: "already_reviewed", message: "该资质已审核，重复或并发审核不会再次生效", currentStatus: q.status, reviewedBy: q.reviewedBy });
      return;
    }
    const approve = input.decision !== "reject";
    if (approve) {
      q.status = "approved";
      q.reviewedBy = actor.id;
      q.reviewedAt = nowIso();
      // 续期通过：旧版本从新版本生效日起标记替换；历史时刻判断仍为 active（历史准入快照不受影响）
      if (q.parentId) {
        const parent = db.qualifications.find(x => x.id === q.parentId);
        if (parent) parent.supersededAt = q.validFrom;
      }
      audit(db, { at: nowIso(), type: "review_approved", actorId: actor.id, actorName: actor.name, testerId: q.testerId, testerName: tester.name, qualificationId: q.id, version: q.version, detail: `审核通过资质 v${q.version}` + (q.parentId ? "，旧版本归档保留" : ""), allowed: true });
    } else {
      q.status = "rejected";
      q.rejectReason = input.reason || "未说明";
      q.reviewedBy = actor.id;
      q.reviewedAt = nowIso();
      audit(db, { at: nowIso(), type: "review_rejected", actorId: actor.id, actorName: actor.name, testerId: q.testerId, testerName: tester.name, qualificationId: q.id, version: q.version, detail: `审核驳回：${q.rejectReason}`, allowed: false });
    }
    await persist(db, req, res, 200, q);
    return;
  }

  /* ---- 暂停 ---- */
  const suspendMatch = p.match(/^\/api\/qualifications\/([^/]+)\/suspend$/);
  if (suspendMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireManager(db, input, "暂停资质");
    const q = db.qualifications.find(x => x.id === suspendMatch[1]);
    if (!q) throw httpError(404, "qualification_not_found");
    const from = input.from || todayOf(nowIso());
    const to = input.to || null;
    if (to && to < from) throw httpError(400, "bad_range", "暂停结束日不能早于开始日");
    q.suspensions.push({ from, to, reason: input.reason || "", by: actor.id, at: nowIso() });
    audit(db, { at: nowIso(), type: "qualification_suspended", actorId: actor.id, actorName: actor.name, testerId: q.testerId, testerName: getUser(db, q.testerId).name, qualificationId: q.id, version: q.version, detail: `暂停资质 v${q.version}：${from}${to ? " 至 " + to : " 起"}（${input.reason || ""}）`, allowed: true });
    await persist(db, req, res, 200, q);
    return;
  }

  /* ---- 复核恢复 ---- */
  const resumeMatch = p.match(/^\/api\/qualifications\/([^/]+)\/resume$/);
  if (resumeMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireManager(db, input, "复核恢复资质");
    const q = db.qualifications.find(x => x.id === resumeMatch[1]);
    if (!q) throw httpError(404, "qualification_not_found");
    const day = input.day || todayOf(nowIso());
    const open = q.suspensions.find(s => !s.resumeDay && day >= s.from && (!s.to || day <= s.to));
    if (!open) throw httpError(409, "not_suspended", "当前不在暂停期内，无需恢复");
    // 复核恢复：从复核当日起不再拦截；暂停区间保留以备追溯
    open.to = day;
    open.resumedBy = actor.id;
    open.resumedAt = nowIso();
    open.resumeDay = day;
    audit(db, { at: nowIso(), type: "qualification_resumed", actorId: actor.id, actorName: actor.name, testerId: q.testerId, testerName: getUser(db, q.testerId).name, qualificationId: q.id, version: q.version, detail: `复核恢复资质 v${q.version}，暂停截至 ${day}`, allowed: true });
    await persist(db, req, res, 200, q);
    return;
  }

  /* ---- 续期：保留旧版本，新版本重新走审核 ---- */
  const renewMatch = p.match(/^\/api\/qualifications\/([^/]+)\/renew$/);
  if (renewMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireManager(db, input, "续期资质");
    const old = db.qualifications.find(x => x.id === renewMatch[1]);
    if (!old) throw httpError(404, "qualification_not_found");
    if (!input.validUntil) throw httpError(400, "bad_validity", "请填写新有效期");
    const pending = db.qualifications.find(q => q.testerId === old.testerId && q.status === "pending");
    if (pending) throw httpError(409, "pending_exists", "已有待审核版本，不能重复续期");
    const nextVersion = db.qualifications.filter(q => q.testerId === old.testerId).reduce((m, q) => Math.max(m, q.version), 0) + 1;
    const q = {
      id: newId("q"), testerId: old.testerId, version: nextVersion, parentId: old.id,
      scopes: input.scopes ? normalizeScopes(input.scopes) : [...old.scopes],
      training: input.training || old.training,
      validFrom: input.validFrom || todayOf(nowIso()), validUntil: input.validUntil,
      status: "pending", enteredBy: actor.id, reviewedBy: null,
      enteredAt: nowIso(), reviewedAt: null, supersededAt: null, rejectReason: null, suspensions: []
    };
    db.qualifications.push(q);
    audit(db, { at: nowIso(), type: "qualification_renewed", actorId: actor.id, actorName: actor.name, testerId: old.testerId, testerName: getUser(db, old.testerId).name, qualificationId: q.id, version: nextVersion, detail: `基于 v${old.version} 提交续期 v${nextVersion}，旧版本保留；审核通过前仍按旧版本判断`, allowed: true });
    await persist(db, req, res, 201, q);
    return;
  }

  /* ---- 账号停用/启用 ---- */
  const disableMatch = p.match(/^\/api\/users\/([^/]+)\/disable$/);
  if (disableMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireManager(db, input, "停用账号");
    const u = getUser(db, disableMatch[1]);
    if (!u) throw httpError(404, "user_not_found");
    u.disabled = true;
    audit(db, { at: nowIso(), type: "tester_disabled", actorId: actor.id, actorName: actor.name, testerId: u.id, testerName: u.name, detail: "停用试验员账号", allowed: true });
    await persist(db, req, res, 200, u);
    return;
  }
  const enableMatch = p.match(/^\/api\/users\/([^/]+)\/enable$/);
  if (enableMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireManager(db, input, "启用账号");
    const u = getUser(db, enableMatch[1]);
    if (!u) throw httpError(404, "user_not_found");
    u.disabled = false;
    audit(db, { at: nowIso(), type: "tester_enabled", actorId: actor.id, actorName: actor.name, testerId: u.id, testerName: u.name, detail: "启用试验员账号", allowed: true });
    await persist(db, req, res, 200, u);
    return;
  }

  /* ---- 接单：必须持有效且匹配资质，禁止他人代办 ---- */
  const acceptMatch = p.match(/^\/api\/items\/([^/]+)\/accept$/);
  if (acceptMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireActor(db, input);
    const item = findItem(db, acceptMatch[1]);
    if (!item) throw httpError(404, "item_not_found");
    const result = evaluate(db, actor.id, item.scope, nowIso());
    if (!result.allowed) {
      audit(db, { at: nowIso(), type: "accept_denied", actorId: actor.id, actorName: actor.name, testerId: actor.id, testerName: actor.name, itemCode: item.code, scope: item.scope, detail: `接单被拒：${result.message}`, allowed: false, reason: result.reason });
      await persist(db, req, res, 403, { allowed: false, error: result.reason, message: result.message });
      return;
    }
    item.status = "已接单";
    item.assigneeId = actor.id;
    item.assigneeName = actor.name;
    item.acceptedAt = nowIso();
    item.logs.push({ at: nowIso(), step: "接单", note: `${actor.name} 凭资质 v${result.version} 接单`, qualificationId: result.qualificationId, decision: result.snapshot });
    audit(db, { at: nowIso(), type: "accept_allowed", actorId: actor.id, actorName: actor.name, testerId: actor.id, testerName: actor.name, itemCode: item.code, scope: item.scope, detail: `接单成功：${item.code}（资质 v${result.version}）`, allowed: true, qualificationId: result.qualificationId, version: result.version, snapshot: result.snapshot });
    await persist(db, req, res, 200, item);
    return;
  }

  /* ---- 提交试磨：接单人本人 + 资质仍有效匹配（防中途失效） ---- */
  const submitMatch = p.match(/^\/api\/items\/([^/]+)\/action$/);
  if (submitMatch && req.method === "POST") {
    const input = await body(req);
    const actor = requireActor(db, input);
    const item = findItem(db, submitMatch[1]);
    if (!item) throw httpError(404, "item_not_found");
    if (!item.assigneeId) {
      await denySubmit("not_accepted", "该墨锭尚未接单，不能直接提交试磨");
      return;
    }
    if (item.assigneeId !== actor.id) {
      await denySubmit("proxy_forbidden", `接单人为【${item.assigneeName}】，他人不能代办提交`);
      return;
    }
    const result = evaluate(db, actor.id, item.scope, nowIso());
    if (!result.allowed) {
      await denySubmit(result.reason, result.message);
      return;
    }
    const score = Number(input.score || 0);
    item.tests ||= [];
    item.tests.push({ at: nowIso(), ...input, score, qualificationId: result.qualificationId, decision: result.snapshot });
    item.status = score >= 85 ? "已试磨" : "重点观察";
    item.logs.push({ at: nowIso(), step: "试磨", note: `${(input.paper || "试纸")}，评分${score}，资质 v${result.version}`, score, qualificationId: result.qualificationId, decision: result.snapshot });
    audit(db, { at: nowIso(), type: "submit_allowed", actorId: actor.id, actorName: actor.name, testerId: actor.id, testerName: actor.name, itemCode: item.code, scope: item.scope, detail: `提交试磨：${item.code}，评分${score}（资质 v${result.version}）`, allowed: true, qualificationId: result.qualificationId, version: result.version, snapshot: result.snapshot });
    await persist(db, req, res, 201, item);
    return;

    async function denySubmit(reason, message) {
      audit(db, { at: nowIso(), type: "submit_denied", actorId: actor.id, actorName: actor.name, testerId: actor.id, testerName: actor.name, itemCode: item.code, scope: item.scope, detail: `提交试磨被拒：${message}`, allowed: false, reason });
      await persist(db, req, res, 403, { allowed: false, error: reason, message });
    }
  }

  const log = p.match(/^\/api\/items\/([^/]+)\/logs$/);
  if (log && req.method === "POST") {
    const item = findItem(db, log[1]);
    if (!item) return send(res, 404, { error: "item_not_found" });
    const input = await body(req);
    item.logs ||= [];
    item.logs.push({ at: nowIso(), step: input.step || "记录", note: input.note || "" });
    await persist(db, req, res, 201, item);
    return;
  }

  send(res, 404, { error: "not_found" });
}

function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}
function normalizeScopes(value) {
  if (Array.isArray(value)) return value.filter(v => SCOPES.includes(v));
  if (typeof value === "string" && SCOPES.includes(value)) return [value];
  return [];
}

/** 幂等键 + 一次落盘：状态、操作记录、幂等记录在同一个 saveDb 内提交，磁盘失败则全部不生效 */
async function persist(db, req, res, status, payload) {
  const idemKey = req.headers["x-idempotency-key"];
  if (idemKey) {
    const hit = db.idem[idemKey];
    if (hit) {
      res.setHeader("Idempotent-Replay", "1");
      return send(res, hit.status, hit.body);
    }
    db.idem[idemKey] = { status, body: payload, at: nowIso() };
  }
  await saveDb(db);
  return send(res, status, payload);
}

/* ---------------- 时间：测试可用 at 头固定时钟 ---------------- */

function nowIso() { return nowOverride() || new Date().toISOString(); }
function nowOverride() { return global.__FIXED_AT__ || (TEST_MODE && process.env.FIXED_AT) || null; }

/* ---------------- 前端页面 ---------------- */

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室 · 资质准入台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --amber:#a8762a; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:18px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:24px; } h2,h3 { margin:0 0 12px; }
    nav { display:flex; gap:8px; flex-wrap:wrap; padding:14px 28px 0; }
    nav button { background:#e3e8df; color:var(--ink); }
    nav button.active { background:var(--accent); color:#fff; }
    main { padding:18px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button.amber { background:var(--amber); }
    button.mini { padding:5px 9px; font-size:12px; font-weight:400; }
    .layout { display:grid; grid-template-columns:380px 1fr; gap:18px; align-items:start; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:22px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; }
    .card { display:grid; gap:7px; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.ok { background:#e7efe1; border-color:#b7cfa3; color:#3c5a2e; }
    .pill.bad { background:#f6e4df; border-color:#d8a798; color:var(--warn); }
    .pill.amber { background:#f7ecd8; border-color:#d8bd8c; color:var(--amber); }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .reason { background:#f9eeeb; border:1px solid #dcc3ba; border-radius:6px; padding:8px 10px; color:var(--warn); font-size:13px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; font-size:13px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { text-align:left; border-bottom:1px solid var(--line); padding:7px 8px; vertical-align:top; }
    .deny { color:var(--warn); font-weight:700; }
    .hide { display:none; }
    @media (max-width:900px){
      header{display:block;padding:14px 16px;}
      nav{padding:12px 16px 0;} main{padding:14px 16px;}
      .layout{grid-template-columns:1fr;}
      .row .mini { flex:1; }
    }
  </style>
</head>
<body>
  <header>
    <div><h1>墨锭试磨室</h1><div class="meta">建档 · 试磨 · 试验员资质准入台</div></div>
    <div class="row">
      <label style="margin:0">当前操作人</label>
      <select id="actor" style="width:auto;min-width:180px"></select>
      <button class="secondary mini" id="reload">刷新</button>
    </div>
  </header>
  <nav>
    <button data-tab="grind" class="active">试磨作业</button>
    <button data-tab="access">资质准入台</button>
    <button data-tab="audit">操作记录</button>
  </nav>

  <main>
    <!-- 试磨作业 -->
    <section id="tab-grind">
      <div class="layout">
        <div>
          <form id="createForm"><h2>新增墨锭</h2>
            <label>试磨范围（准入匹配项）</label><select name="scope" id="scopeSelect"></select>
            <div id="fields"></div>
            <div style="margin-top:12px"><button>保存墨锭（建档为待试磨）</button></div>
          </form>
          <form id="actionForm" style="margin-top:14px"><h2>接单 / 提交试磨</h2>
            <label>选择墨锭</label><select name="id" id="itemSelect"></select>
            <div class="row" style="margin-top:8px">
              <button type="button" id="acceptBtn">凭资质接单</button>
            </div>
            <div id="extraFields"></div>
            <div style="margin-top:12px"><button>提交试磨</button></div>
          </form>
        </div>
        <div>
          <div class="stats" id="stats"></div>
          <div class="panel">
            <h2>墨锭列表</h2>
            <div class="grid" id="cards"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- 资质准入台 -->
    <section id="tab-access" class="hide">
      <div class="layout">
        <div>
          <form id="qForm" class="panel">
            <h2>录入资质</h2>
            <label>试验员</label><select name="testerId" id="testerSelect"></select>
            <label>资质范围（可多选）</label><div id="scopeChecks" class="row"></div>
            <label>培训记录</label><textarea name="trainingText" placeholder="培训课程、日期、学时"></textarea>
            <label>生效日期</label><input name="validFrom" type="date">
            <label>有效期至</label><input name="validUntil" type="date" required>
            <div style="margin-top:12px"><button>提交（进入待审核）</button></div>
          </form>
        </div>
        <div>
          <div class="panel" style="margin-bottom:14px">
            <h2>试验员准入总览</h2>
            <div class="meta" style="margin-bottom:8px">即将到期（${EXPIRE_SOON_DAYS}天内）、已停用、失败原因在此直接标出。</div>
            <div id="testerOverview" class="grid"></div>
          </div>
          <div class="panel">
            <h2>资质版本与审核</h2>
            <div class="meta" style="margin-bottom:8px">规则：审核人不能是录入人；每次续期生成新版本，旧版本保留，历史准入按当时版本快照判断。</div>
            <div id="qList"></div>
          </div>
        </div>
      </div>
    </section>

    <!-- 操作记录 -->
    <section id="tab-audit" class="hide">
      <div class="panel">
        <h2>操作记录（准入判断 / 审核 / 版本变更）</h2>
        <table>
          <thead><tr><th>时间</th><th>操作人</th><th>试验员</th><th>事项</th><th>结果</th></tr></thead>
          <tbody id="auditBody"></tbody>
        </table>
      </div>
    </section>
  </main>

  <script>
  (async () => {
    const SCOPES = ${JSON.stringify(SCOPES)};
    const STAGES = ${JSON.stringify(stages)};
    const FIELDS = ${JSON.stringify(fields)};
    const EXTRA_FIELDS = ${JSON.stringify(extraFields)};

    let users = [], items = [], actorId = localStorage.getItem('actorId');

    const $ = s => document.querySelector(s);
    async function api(path, options = {}) {
      if (options.body) options.headers = { ...(options.headers || {}), 'Content-Type': 'application/json' };
      const res = await fetch(path, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.message || data.error || '请求失败'), { data, status: res.status });
      return data;
    }

    /* ---- 操作人 ---- */
    function renderActor() {
      $('#actor').innerHTML = users.map(u => '<option value="' + u.id + '"' + (u.id === actorId ? ' selected' : '') + '>' + u.name + '（' + u.roles.join('/') + (u.disabled ? '·已停用' : '') + '）</option>').join('');
    }
    $('#actor').onchange = e => { actorId = e.target.value; localStorage.setItem('actorId', actorId); refreshAll(); };

    function withActor(payload) { return { ...payload, actorId }; }

    /* ---- 页签 ---- */
    document.querySelectorAll('nav button').forEach(btn => btn.onclick = () => {
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      for (const t of ['grind', 'access', 'audit']) $('#tab-' + t).classList.toggle('hide', t !== btn.dataset.tab);
      refreshAll();
    });

    /* ---- 试磨作业 ---- */
    function renderGrindForms() {
      $('#fields').innerHTML = FIELDS.map(([key, label, type]) => '<label>' + label + '</label><input name="' + key + '" type="' + type + '"' + (key === 'code' ? ' required' : '') + '>').join('');
      $('#extraFields').innerHTML = EXTRA_FIELDS.map(([key, label]) => '<label>' + label + '</label><input name="' + key + '">').join('');
    }
    function renderGrind() {
      $('#itemSelect').innerHTML = items.map(i => '<option value="' + (i.id || i.code) + '">' + i.code + ' · ' + i.scope + ' · ' + i.status + '</option>').join('');
      const stats = Object.fromEntries(STAGES.map(s => [s, 0]));
      items.forEach(i => { if (stats[i.status] !== undefined) stats[i.status]++; });
      $('#stats').innerHTML = Object.entries(stats).map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + v + '</strong></div>').join('');
      $('#cards').innerHTML = items.map(cardHtml).join('') || '<div class="meta">暂无墨锭</div>';
      $('#cards').querySelectorAll('[data-accept]').forEach(b => b.onclick = () => accept(b.dataset.accept));
    }
    function cardHtml(i) {
      const main = '<div class="meta">范围：<b>' + i.scope + '</b>｜烟料：' + (i.smokeSource || '') + '｜胶比：' + (i.glueRatio || '') + '</div>';
      const assign = i.assigneeName ? '<div class="meta">接单人：' + i.assigneeName + '</div>' : '';
      const logs = (i.logs || []).slice(-4).map(l => '<div>' + l.step + '：' + (l.note || '') + '</div>').join('');
      return '<article class="card"><h3>' + i.code + '</h3><span class="pill ' + (i.status === '待试磨' ? 'amber' : 'ok') + '">' + i.status + '</span>' + main + assign +
        '<div class="row"><button class="mini" data-accept="' + (i.id || i.code) + '">接单/查看</button></div>' +
        '<div class="logs meta">' + (logs || '暂无记录') + '</div></article>';
    }
    async function accept(key) {
      try {
        const r = await api('/api/items/' + key + '/accept', { method: 'POST', body: JSON.stringify(withActor({})) });
        $('#itemSelect').value = r.id || r.code;
        await loadItems();
      } catch (e) { showDeny(e); await loadItems(); }
    }
    $('#acceptBtn').onclick = () => accept($('#itemSelect').value);

    $('#createForm').onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData($('#createForm')).entries());
      await api('/api/items', { method: 'POST', body: JSON.stringify(withActor(data)) }).catch(showDeny);
      $('#createForm').reset(); renderStaticSelects(); await loadItems();
    };
    $('#actionForm').onsubmit = async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData($('#actionForm')).entries());
      const key = data.id; delete data.id;
      try {
        await api('/api/items/' + key + '/action', { method: 'POST', body: JSON.stringify(withActor(data)) });
      } catch (err) { showDeny(err); }
      $('#actionForm').reset(); renderStaticSelects(); await loadItems();
    };

    /* ---- 资质准入台 ---- */
    function renderAccessForm() {
      $('#testerSelect').innerHTML = users.filter(u => u.roles.includes('tester')).map(u => '<option value="' + u.id + '">' + u.name + '</option>').join('');
      $('#scopeChecks').innerHTML = SCOPES.map(s => '<label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" name="scopes" value="' + s + '" style="width:auto">' + s + '</label>').join('');
    }
    async function renderAccess() {
      const testers = await api('/api/tester-status');
      $('#testerOverview').innerHTML = testers.map(t => {
        const cls = t.disabled || ['已暂停', '已过期', '无资质', '审核驳回'].includes(t.state) ? 'bad' : (t.expiringSoon ? 'amber' : 'ok');
        let note = '';
        if (t.disabled) note = '<div class="reason">账号已停用，不能接单或提交</div>';
        else if (t.state === '已暂停') note = '<div class="reason">资质已暂停，需复核恢复</div>';
        else if (t.state === '已过期') note = '<div class="reason">资质已于 ' + t.validUntil + ' 过期</div>';
        else if (t.state === '无资质') note = '<div class="reason">无资质记录，准入将被拒绝</div>';
        else if (t.expiringSoon) note = '<div class="pill amber">即将到期：' + t.validUntil + '</div>';
        if (t.pendingRenewal) note += '<div class="pill amber" style="margin-top:4px">续期 v' + t.pendingRenewal.version + '（' + (t.pendingRenewal.status === 'pending' ? '待审核' : '已驳回') + '）；现行仍按 v' + t.version + ' 判断</div>';
        return '<article class="card"><h3>' + t.name + '</h3><span class="pill ' + cls + '">' + t.state + (t.version ? ' v' + t.version : '') + '</span>' +
          '<div class="meta">范围：' + (t.scopes.join('、') || '—') + '｜有效期至：' + (t.validUntil || '—') + '</div>' + note +
          '<div class="row"><button class="mini secondary" data-q="' + t.userId + '">管理/续期</button></div></article>';
      }).join('');
      $('#testerOverview').querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
        $('#testerSelect').value = b.dataset.q;
        document.querySelector('#qList').scrollIntoView({ behavior: 'smooth' });
      });

      const qs = await api('/api/qualifications');
      const actor = users.find(u => u.id === actorId);
      const isManager = actor && actor.roles.some(r => ['admin', 'reviewer'].includes(r));
      $('#qForm').style.display = isManager ? '' : 'none';
      $('#qList').innerHTML = qs.map(q => {
        const testerName = q.testerName || '';
        const statusPill = { active: ['ok', '有效'], suspended: ['bad', '暂停'], expired: ['bad', '过期'], pending: ['amber', '待审核'], rejected: ['bad', '驳回'], superseded: ['amber', '已替换'] }[q.currentStatus] || ['', q.currentStatus];
        const training = (q.training || []).map(t => (t.at || '') + ' ' + (t.course || t) + (t.hours ? '（' + t.hours + '学时）' : '')).join('；');
        const suspensions = (q.suspensions || []).map(s => '暂停 ' + s.from + '→' + (s.to || '至今') + (s.reason ? '：' + s.reason : '')).join('<br>');
        let actions = '';
        if (!isManager) {
          actions = '<div class="meta">管理动作（审核/暂停/恢复/续期）仅管理员或审核角色可执行</div>';
        } else if (q.status === 'pending') {
          actions = '<div class="row"><button class="mini" data-review="approve:' + q.id + '">审核通过</button><button class="mini danger" data-review="reject:' + q.id + '">驳回</button></div>';
        } else if (q.currentStatus === 'active' || q.currentStatus === 'suspended' || q.currentStatus === 'expired') {
          actions = '<div class="row">' +
            '<button class="mini amber" data-suspend="' + q.id + '">暂停</button>' +
            '<button class="mini secondary" data-resume="' + q.id + '">复核恢复</button>' +
            '<button class="mini" data-renew="' + q.id + '">续期（保留本版本）</button>' +
            '</div>';
        }
        return '<article class="card" style="margin-bottom:10px"><div class="row"><b>' + testerName + ' · v' + q.version + '</b><span class="pill ' + statusPill[0] + '">' + statusPill[1] + '</span></div>' +
          '<div class="meta">范围：' + q.scopes.join('、') + '</div>' +
          '<div class="meta">有效期：' + q.validFrom + ' 至 ' + q.validUntil + (q.supersededAt ? '（' + q.supersededAt + ' 起被新版本替换）' : '') + '</div>' +
          '<div class="meta">培训：' + training + '</div>' +
          (suspensions ? '<div class="meta">' + suspensions + '</div>' : '') +
          (q.rejectReason ? '<div class="reason">驳回原因：' + q.rejectReason + '</div>' : '') +
          '<div class="meta">录入：' + (users.find(u => u.id === q.enteredBy)?.name || q.enteredBy) + '｜审核：' + (q.reviewedBy ? users.find(u => u.id === q.reviewedBy)?.name : '—') + '</div>' +
          actions + '</article>';
      }).join('') || '<div class="meta">暂无资质</div>';

      $('#qList').querySelectorAll('[data-review]').forEach(b => b.onclick = async () => {
        const [decision, id] = b.dataset.review.split(':');
        try {
          if (decision === 'reject') {
            const reason = prompt('驳回原因');
            await api('/api/qualifications/' + id + '/review', { method: 'POST', body: JSON.stringify(withActor({ decision: 'reject', reason })) });
          } else {
            await api('/api/qualifications/' + id + '/review', { method: 'POST', body: JSON.stringify(withActor({ decision: 'approve' })) });
          }
        } catch (e) { alert(e.message); }
        await renderAccess();
      });
      $('#qList').querySelectorAll('[data-suspend]').forEach(b => b.onclick = async () => {
        const reason = prompt('暂停原因');
        await api('/api/qualifications/' + b.dataset.suspend + '/suspend', { method: 'POST', body: JSON.stringify(withActor({ reason })) }).catch(showDeny);
        await renderAccess();
      });
      $('#qList').querySelectorAll('[data-resume]').forEach(b => b.onclick = async () => {
        await api('/api/qualifications/' + b.dataset.resume + '/resume', { method: 'POST', body: JSON.stringify(withActor({})) }).catch(showDeny);
        await renderAccess();
      });
      $('#qList').querySelectorAll('[data-renew]').forEach(b => b.onclick = async () => {
        const validUntil = prompt('新有效期至（YYYY-MM-DD）');
        if (!validUntil) return;
        await api('/api/qualifications/' + b.dataset.renew + '/renew', { method: 'POST', body: JSON.stringify(withActor({ validUntil })) }).catch(showDeny);
        await renderAccess();
      });
    }

    $('#qForm').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData($('#qForm'));
      const payload = {
        testerId: fd.get('testerId'),
        scopes: [...fd.getAll('scopes')],
        trainingText: fd.get('trainingText'),
        training: [{ at: new Date().toISOString().slice(0, 10), course: fd.get('trainingText'), hours: 0 }],
        validFrom: fd.get('validFrom'), validUntil: fd.get('validUntil')
      };
      try { await api('/api/qualifications', { method: 'POST', body: JSON.stringify(withActor(payload)) }); $('#qForm').reset(); renderAccessForm(); }
      catch (err) { alert(err.message); }
      await renderAccess();
    };

    /* ---- 操作记录 ---- */
    async function renderAudit() {
      const list = await api('/api/audit');
      $('#auditBody').innerHTML = list.map(a => '<tr><td>' + a.at + '</td><td>' + (a.actorName || '') + '</td><td>' + (a.testerName || '') + '</td><td>' +
        (a.itemCode ? '[' + a.itemCode + '] ' : '') + a.detail + '</td><td>' +
        (a.allowed ? '<span class="pill ok">通过</span>' : '<span class="pill bad">拒绝</span>') + '</td></tr>').join('') ||
        '<tr><td colspan="5" class="meta">暂无记录</td></tr>';
    }

    /* ---- 通用 ---- */
    function showDeny(err) {
      const msg = err.data?.message || err.message;
      alert('准入失败：' + msg + (err.data?.error ? '（' + err.data.error + '）' : ''));
    }
    async function loadUsers() { users = await api('/api/users'); if (!users.find(u => u.id === actorId)) actorId = users[0]?.id; renderActor(); }
    async function loadItems() { items = await api('/api/items'); renderGrind(); }
    function renderStaticSelects() {
      $('#scopeSelect').innerHTML = SCOPES.map(s => '<option>' + s + '</option>').join('');
    }
    async function refreshAll() {
      const tab = document.querySelector('nav button.active').dataset.tab;
      if (tab === 'grind') await loadItems();
      if (tab === 'access') await renderAccess();
      if (tab === 'audit') await renderAudit();
    }
    $('#reload').onclick = refreshAll;

    renderStaticSelects();
    renderGrindForms();
    renderAccessForm();
    await loadUsers();
    await refreshAll();
  })();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    const status = error.status || 500;
    send(res, status, { error: error.error || error.code || "server_error", message: error.message });
  }
});

if (process.env.VITEST_WORKER_ID === undefined && !process.env.NO_LISTEN) {
  server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
}

export { server, loadDb, saveDb, evaluate, versionStatusAt, testerStatus, dbPath, bakPath };
