# 墨锭试磨室（含试验员资质准入台）

运行：

```bash
npm start          # http://localhost:3037
npm test           # 端到端测试（准入成功/拒绝/并发/失效/写盘失败/重启恢复）
```

数据保存在 `data/ink-stick-testing.json`（可用 `DB_FILE` 覆盖）。

## 资质准入规则

- 管理员录入资质范围（松烟/油烟/漆烟/重点复磨）、培训记录、有效期，资质进入「待审核」。
- **审核人不能是录入人**；同一资质重复或并发审核只成功一次（进程内写互斥 + pending 状态 CAS + 幂等键）。
- 试验员**接单**与**提交试磨**时实时校验：必须账号启用、资质有效（在有效期内、未暂停）、试磨范围在资质范围内；接单人本人才能提交（他人代办拒绝）。
- 过期、停用（账号停用或资质暂停）、超范围、待审核/驳回、代办一律拒绝，并在「操作记录」写明原因。
- 资质支持暂停、复核恢复（复核当日起放行）、续期：续期生成新版本重新审核，**旧版本永久保留**；历史接单/试磨日志内嵌当时资质版本快照，历史准入按当时版本判断，续期审核期间仍按旧版本放行。
- 页面展示即将到期（30 天内）、已停用/暂停、准入失败原因；响应式布局，手机可用。

## 一致性与恢复

- 所有写操作串行化，状态变更与审计记录在**同一次落盘**中提交，失败则整笔不留痕。
- 落盘采用 `tmp → 备份主文件 → rename 提交 → 刷新 .bak`：POSIX rename 原子，崩溃只会停在旧状态或新状态，不存在半条状态；重启时主文件缺失或损坏均自动从 `.bak` 恢复到最近一次已提交状态。

## 主要接口

| 接口 | 说明 |
| --- | --- |
| `POST /api/qualifications` | 录入资质（body 带 `actorId`） |
| `POST /api/qualifications/:id/review` | 审核 `{decision:"approve|reject"}`，录入人审核返回 403 |
| `POST /api/qualifications/:id/suspend` `/resume` `/renew` | 暂停 / 复核恢复 / 续期 |
| `POST /api/items/:code/accept` | 凭资质接单 |
| `POST /api/items/:code/action` | 接单人本人提交试磨 |
| `GET /api/tester-status` | 准入总览（含 `expiringSoon`、`pendingRenewal`） |
| `GET /api/qualifications` `/api/audit` | 资质版本与操作记录 |

写请求支持 `X-Idempotency-Key`，同键重试返回首次结果（响应头 `Idempotent-Replay: 1`）。
