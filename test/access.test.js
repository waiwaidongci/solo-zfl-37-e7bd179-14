import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let server, base, dbFile, serverDir, counter = 0;

async function startServer() {
  const port = 4100 + (counter++);
  const dir = join(root, "data", `test-${process.pid}-${port}`);
  await rm(dir, { recursive: true, force: true });
  dbFile = join(dir, "db.json");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "server.js")], {
      env: { ...process.env, PORT: String(port), DB_FILE: dbFile, TEST_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", d => {
      if (String(d).includes("listening")) resolve({ child, base: `http://127.0.0.1:${port}`, dir });
    });
    child.stderr.on("data", d => process.stderr.write(d));
    child.on("exit", code => { if (code) reject(new Error("server exited " + code)); });
  });
}

async function stopServer(s) {
  s.child.kill("SIGKILL");
  await rm(s.dir, { recursive: true, force: true }).catch(() => {});
}

async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json", ...(opts.headers || {}) } : (opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

const ADMIN = "u-admin", REVIEWER = "u-reviewer", T1 = "u-t1", T2 = "u-t2";

function iso(offsetDays = 0, hour = 12) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10) + `T${String(hour).padStart(2, "0")}:00:00.000Z`;
}
function day(offsetDays = 0) { return iso(offsetDays).slice(0, 10); }

async function createItem(code, scope) {
  const r = await api("/api/items", { method: "POST", body: { actorId: ADMIN, code, scope, smokeSource: "测试烟料", status: "待试磨" } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
async function enterQualification(testerId, scopes, validUntil, extra = {}) {
  const r = await api("/api/qualifications", {
    method: "POST",
    body: { actorId: ADMIN, testerId, scopes, validFrom: extra.validFrom || day(-5), validUntil, training: [{ at: day(-10), course: "入职培训", hours: 8 }], ...extra }
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

test.beforeEach(async () => { ({ child: server, base, dir: serverDir } = await startServer()); });
test.afterEach(async () => { await stopServer({ child: server, dir: serverDir }); });

/* ------------------------------------------------------------------ */
test("准入成功：有效且范围匹配的资质可接单并提交，快照随动作落盘", async () => {
  const item = await createItem("T-OK-1", "松烟墨试磨"); // T1 的种子资质含松烟，有效期至 2027
  const acc = await api(`/api/items/${item.code}/accept`, { method: "POST", body: { actorId: T1 } });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  assert.equal(acc.json.assigneeId, T1);
  const snap = acc.json.logs.at(-1).decision;
  assert.equal(snap.qualificationId, "q-seed-1");
  assert.equal(snap.version, 1);
  assert.equal(snap.statusAtAction, "active");

  const sub = await api(`/api/items/${item.code}/action`, { method: "POST", body: { actorId: T1, paper: "宣纸", score: 90 } });
  assert.equal(sub.status, 201);
  assert.equal(sub.json.status, "已试磨");
  assert.equal(sub.json.tests.at(-1).qualificationId, "q-seed-1");

  const audit = await api("/api/audit");
  assert.ok(audit.json.some(a => a.type === "accept_allowed" && a.allowed));
  assert.ok(audit.json.some(a => a.type === "submit_allowed" && a.allowed));
});

/* ------------------------------------------------------------------ */
test("拒绝：无资质 / 待审核 / 超范围 / 代办 / 停用 / 过期", async () => {
  // T2 无资质
  const i1 = await createItem("T-DENY-1", "油烟墨试磨");
  let r = await api(`/api/items/${i1.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "no_qualification");

  // 待审核期间不允许
  const q = await enterQualification(T2, ["油烟墨试磨"], day(100));
  r = await api(`/api/items/${i1.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "qualification_pending");

  // 录入人不能是审核人
  r = await api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: ADMIN, decision: "approve" } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "reviewer_is_enterer");

  // 审核通过
  r = await api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });
  assert.equal(r.status, 200);

  // 超范围：油烟资质接松烟单
  const i2 = await createItem("T-DENY-2", "松烟墨试磨");
  r = await api(`/api/items/${i2.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "scope_mismatch");
  assert.match(r.json.message, /超范围/);

  // 代办：T2 接自己的单后，T1 不能代为提交
  r = await api(`/api/items/${i1.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 200);
  r = await api(`/api/items/${i1.code}/action`, { method: "POST", body: { actorId: T1, paper: "x", score: 88 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "proxy_forbidden");

  // 未接单直接提交
  r = await api(`/api/items/${i2.code}/action`, { method: "POST", body: { actorId: T1, paper: "x", score: 88 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "not_accepted");

  // 账号停用
  r = await api(`/api/users/${T2}/disable`, { method: "POST", body: { actorId: ADMIN } });
  assert.equal(r.status, 200);
  r = await api(`/api/items/${i1.code}/action`, { method: "POST", body: { actorId: T2, paper: "x", score: 88 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "tester_disabled");

  // 过期：新建试验员场景——录入一份已过期资质
  await api(`/api/users/${T2}/enable`, { method: "POST", body: { actorId: ADMIN } });
  // T1 资质仍有效；过期用直接造一份新资质给 T2 的另一种方式：审核通过一份 validUntil 在过去的资质
  const qExp = await enterQualification(T2, ["油烟墨试磨"], day(-1), { validFrom: day(-30) });
  await api(`/api/qualifications/${qExp.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });
  r = await api(`/api/items/${i1.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "qualification_expired");

  // 所有拒绝都有操作记录与原因
  const denied = (await api("/api/audit")).json.filter(a => !a.allowed);
  for (const type of ["accept_denied", "submit_denied"]) {
    assert.ok(denied.some(a => a.type === type), "缺少 " + type);
  }
  assert.ok(denied.every(a => typeof a.detail === "string" && a.detail.length > 0));
});

/* ------------------------------------------------------------------ */
test("并发/重复审核只成功一次", async () => {
  const q = await enterQualification(T2, ["油烟墨试磨"], day(90));
  const results = await Promise.all([
    api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } }),
    api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } }),
    api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } })
  ]);
  const oks = results.filter(r => r.status === 200);
  const conflicts = results.filter(r => r.status === 409);
  assert.equal(oks.length, 1, "只有一次审核成功");
  assert.equal(conflicts.length, 2);
  assert.deepEqual(oks[0].json.reviewedBy, REVIEWER);

  // 落盘状态唯一
  const qs = await api("/api/qualifications?testerId=" + T2);
  assert.equal(qs.json.filter(x => x.status === "approved").length, 1);
  const audit = await api("/api/audit");
  assert.equal(audit.json.filter(a => a.type === "review_approved").length, 1);
  assert.equal(audit.json.filter(a => a.type === "review_duplicate").length, 2);

  // 相同幂等键重试：返回首次结果，不产生第二条状态
  const q2 = await enterQualification(T2, ["漆烟墨试磨"], day(90));
  const key = "idem-review-" + q2.id;
  const [a, b] = await Promise.all([
    api(`/api/qualifications/${q2.id}/review`, { method: "POST", headers: { "X-Idempotency-Key": key }, body: { actorId: REVIEWER, decision: "approve" } }),
    api(`/api/qualifications/${q2.id}/review`, { method: "POST", headers: { "X-Idempotency-Key": key }, body: { actorId: REVIEWER, decision: "approve" } })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get("idempotent-replay"), "1");
  const audit2 = await api("/api/audit");
  assert.equal(audit2.json.filter(x => x.type === "review_approved").length, 2);
});

/* ------------------------------------------------------------------ */
test("失效：暂停拦截 → 复核恢复放行；过期拒绝", async () => {
  const item = await createItem("T-SUS-1", "松烟墨试磨"); // T1 种子资质
  const qid = "q-seed-1";

  let r = await api(`/api/qualifications/${qid}/suspend`, { method: "POST", body: { actorId: ADMIN, reason: "例行调查" } });
  assert.equal(r.status, 200);
  r = await api(`/api/items/${item.code}/accept`, { method: "POST", body: { actorId: T1 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "qualification_suspended");

  // 总览显示已暂停
  const ov = await api("/api/tester-status");
  const t1 = ov.json.find(t => t.userId === T1);
  assert.equal(t1.state, "已暂停");

  r = await api(`/api/qualifications/${qid}/resume`, { method: "POST", body: { actorId: REVIEWER } });
  assert.equal(r.status, 200);
  r = await api(`/api/items/${item.code}/accept`, { method: "POST", body: { actorId: T1 } });
  assert.equal(r.status, 200, "复核恢复后应可接单");

  // 过期：固定时钟跳到 2028 年，种子资质 2027 到期
  await api("/__test/set-fixed-at", { method: "POST", body: { at: "2028-01-01T12:00:00.000Z" } });
  r = await api(`/api/items/${item.code}/action`, { method: "POST", body: { actorId: T1, paper: "x", score: 90 } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "qualification_expired");
});

/* ------------------------------------------------------------------ */
test("续期保留旧版本，历史准入按当时资质判断；即将到期有提示", async () => {
  // T2 录入短期资质并通过
  const q1 = await enterQualification(T2, ["油烟墨试磨"], day(10), { validFrom: day(-30) });
  await api(`/api/qualifications/${q1.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });

  // 即将到期提示
  let ov = await api("/api/tester-status");
  let t2 = ov.json.find(t => t.userId === T2);
  assert.equal(t2.expiringSoon, true);

  const item = await createItem("T-REN-1", "油烟墨试磨");
  let r = await api(`/api/items/${item.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 200);
  const oldVersionAtAction = r.json.logs.at(-1).decision.version;
  assert.equal(oldVersionAtAction, 1);

  // 续期：旧版本保留，新版本待审核期间仍按旧版本放行
  const q2 = await api(`/api/qualifications/${q1.id}/renew`, { method: "POST", body: { actorId: ADMIN, validUntil: day(400) } });
  assert.equal(q2.status, 201);
  assert.equal(q2.json.version, 2);
  assert.equal(q2.json.parentId, q1.id);
  ov = await api("/api/tester-status");
  t2 = ov.json.find(t => t.userId === T2);
  assert.equal(t2.version, 1, "续期待审核期间仍按 v1 判断");
  assert.ok(t2.pendingRenewal);

  // 审核通过新版本
  r = await api(`/api/qualifications/${q2.json.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });
  assert.equal(r.status, 200);

  // 旧版本仍在库、被标记 supersededAt，但版本内容未改
  const qs = await api("/api/qualifications?testerId=" + T2);
  const v1 = qs.json.find(x => x.version === 1), v2 = qs.json.find(x => x.version === 2);
  assert.ok(v1 && v2, "新旧版本都保留");
  assert.equal(v1.status, "approved");
  assert.equal(v1.supersededAt, v2.validFrom);

  // 历史动作快照仍指向 v1（历史准入按当时资质），新动作按 v2
  const item2 = await createItem("T-REN-2", "油烟墨试磨");
  r = await api(`/api/items/${item2.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.logs.at(-1).decision.version, 2);

  // 旧单据日志里的 v1 快照未被新版本污染
  const items = await api("/api/items");
  const oldItem = items.json.find(i => i.code === item.code);
  assert.equal(oldItem.logs.find(l => l.step === "接单").decision.version, 1);
  assert.deepEqual(oldItem.logs.find(l => l.step === "接单").decision.validUntil, q1.validUntil);
});

/* ------------------------------------------------------------------ */
test("写盘失败：状态与操作记录一致，不留半条状态", async () => {
  const q = await enterQualification(T2, ["油烟墨试磨"], day(100));
  // 让下一次落盘（即本次审核）失败
  await api("/__test/fail-next-write", { method: "POST", body: { mode: "prewrite" } });
  const r = await api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "ENOSPC");

  // 磁盘失败后：资质仍为 pending，没有审核通过记录，也没有重复/拒绝残留
  const qs = await api("/api/qualifications?testerId=" + T2);
  const fresh = qs.json.find(x => x.id === q.id);
  assert.equal(fresh.status, "pending");
  assert.equal(fresh.reviewedBy, null);
  const audit = await api("/api/audit");
  assert.ok(!audit.json.some(a => a.type === "review_approved"), "不得写入审核成功记录");
  // 录入记录是上一次成功落盘的，仍在；失败的审核没有留下任何痕迹
  assert.equal(audit.json.filter(a => a.qualificationId === q.id && a.type.startsWith("review")).length, 0);

  // 失败后服务仍可正常工作，重试审核成功
  const retry = await api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });
  assert.equal(retry.status, 200);
});

/* ------------------------------------------------------------------ */
test("崩溃在 rename 中途：重启后从 .bak 恢复，数据完好无半状态", async () => {
  // 先制造若干已落盘状态
  const q = await enterQualification(T2, ["油烟墨试磨"], day(100));
  await api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });

  // 在主文件已改名为 .bak、新主文件尚未 rename 时崩溃
  await api("/__test/fail-next-write", { method: "POST", body: { mode: "after_main_rename" } });
  const r = await api(`/api/qualifications/${q.id}/suspend`, { method: "POST", body: { actorId: ADMIN, reason: "x" } });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "EIO");

  // 此时主文件缺失、.bak 与 .tmp 残留
  assert.ok(!existsSync(dbFile), "主文件应在崩溃窗口缺失");
  assert.ok(existsSync(dbFile + ".bak"));

  // 重启
  server.kill("SIGKILL");
  await new Promise(res => setTimeout(res, 150));
  ({ child: server, base } = await new Promise((resolve, reject) => {
    const port = Number(new URL(base).port);
    const child = spawn(process.execPath, [join(root, "server.js")], {
      env: { ...process.env, PORT: String(port), DB_FILE: dbFile, TEST_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", d => String(d).includes("listening") && resolve({ child, base: `http://127.0.0.1:${port}` }));
    child.on("exit", code => { if (code) reject(new Error("exit " + code)); });
  }));

  // 恢复到暂停前的状态：v1 已审核、无暂停、无半条 suspend 审计
  const qs = await api("/api/qualifications?testerId=" + T2);
  const fresh = qs.json.find(x => x.id === q.id);
  assert.equal(fresh.status, "approved");
  assert.equal((fresh.suspensions || []).length, 0);
  const audit = await api("/api/audit");
  assert.ok(!audit.json.some(a => a.type === "qualification_suspended"));

  // 恢复后可继续正常操作
  const item = await createItem("T-CRASH-1", "油烟墨试磨");
  const acc = await api(`/api/items/${item.code}/accept`, { method: "POST", body: { actorId: T2 } });
  assert.equal(acc.status, 200);
});

/* ------------------------------------------------------------------ */
test("主文件损坏：重启从 .bak 恢复最近一次完好状态", async () => {
  const q = await enterQualification(T2, ["漆烟墨试磨"], day(120));
  await api(`/api/qualifications/${q.id}/review`, { method: "POST", body: { actorId: REVIEWER, decision: "approve" } });

  server.kill("SIGKILL");
  await new Promise(res => setTimeout(res, 150));
  // 主文件写坏
  await writeFile(dbFile, "{ 这不是合法JSON");

  const port = Number(new URL(base).port);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "server.js")], {
      env: { ...process.env, PORT: String(port), DB_FILE: dbFile, TEST_MODE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", d => String(d).includes("listening") && resolve(child));
    child.on("exit", code => { if (code) reject(new Error("exit " + code)); });
  }).then(child => { server = child; });

  const qs = await api("/api/qualifications?testerId=" + T2);
  const fresh = qs.json.find(x => x.id === q.id);
  assert.equal(fresh.status, "approved", "损坏主文件应被 .bak 完好状态替换");
  // 主文件已被修复为合法 JSON
  JSON.parse(await readFile(dbFile, "utf8"));
});

/* ------------------------------------------------------------------ */
test("页面含准入台关键要素（到期/停用/失败原因/移动端视口）", async () => {
  const res = await fetch(base + "/");
  const html = await res.text();
  for (const token of ["资质准入台", "操作记录", "即将到期", "准入失败", "viewport", "审核人不能是录入人", "续期"]) {
    assert.ok(html.includes(token), "页面缺少：" + token);
  }
});
