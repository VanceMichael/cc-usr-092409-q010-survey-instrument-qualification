# 廊桥测绘基线仲裁库

工程以 Fastify 和 TypeScript 提供测绘基线管理的后端入口，使用 Node.js 22 的内置 SQLite API 访问 `data/bridge_baselines.sqlite3`。可通过 `DATABASE_PATH`、`HOST`、`PORT` 调整本地运行位置。

```bash
npm ci
npm run db:migrate
npm test
npm run build
npm start
```

接口、连接、迁移和启动验证分别位于 `src`、`scripts`、`migrations` 与 `test`，应用不连接远程对象存储或消息系统。

## 仪器资格与借用链

多家测绘单位轮换使用全站仪与棱镜时，本服务负责回答一个问题：**一次观测凭什么进入基线**。领域约定见 `docs/领域约定.md`。

### 设备与证书

| 接口 | 说明 |
| --- | --- |
| `POST /devices` | 登记设备：序列号、类型、适用精度（如 `2.0mm`）、保管人 |
| `GET /devices` / `GET /devices/:id` | 设备查询 |
| `POST /combinations` | 登记组件组合（全站仪+棱镜的角色配对与组合精度） |
| `GET /combinations` | 组合查询 |
| `POST /certificates` | 签发校准证书（有效期、承诺精度），自动登记到期任务 |
| `GET /certificates?deviceId=` | 证书查询 |
| `POST /certificates/:id/revoke` | 撤销证书：重评未签署观测，已签署基线追加风险 |
| `POST /maintenance/open` / `POST /maintenance/:id/close` | 维修开工/结案（结案可补录迟到结论，触发同样的重评与风险追加） |

### 借用链

| 接口 | 说明 |
| --- | --- |
| `POST /leases` | 借用申请：班组、工作区、时间窗、用途、设备清单；重叠租约原子拒绝（409 `OVERLAPPING_LEASE`） |
| `POST /leases/:id/lend` | 保管人确认出借 |
| `POST /leases/:id/return` | 领用人确认归还 |
| `POST /leases/:id/reject` / `POST /leases/:id/cancel` | 驳回/取消申请 |
| `GET /leases?status=` / `GET /leases/:id` | 租约查询 |

### 观测与基线

| 接口 | 说明 |
| --- | --- |
| `POST /observations` | 观测导入：冻结设备/证书/租约/组合版本快照；合格进候选解，过期/越区/组件不匹配等待复核，不完整采集包隔离，均不删除 |
| `GET /observations?status=` / `GET /observations/:id` | 观测查询 |
| `GET /observations/:id/explain` | 解释采用/降级/隔离：规则轨迹、冻结版本、保管人、校准依据、后续处置 |
| `POST /observations/:id/review` | 复核裁定：`released` 解除回候选 / `isolated` 隔离保留 |
| `POST /baselines` / `POST /baselines/:id/sign` | 建立基线版本并签署候选观测（构件对应关系随版本发布） |
| `GET /baselines/:id` | 基线明细（含观测与风险） |
| `POST /risks/:id/acknowledge` | 确认基线风险 |

### 离线交接与停服恢复

| 接口 | 说明 |
| --- | --- |
| `POST /handoffs` | 登记离线交接：按设备流水归位，封签号唯一 |
| `POST /handoffs/:id/confirm` | 封签确认：同一封签并发确认只有一次成功（409 `SEAL_ALREADY_CONFIRMED`） |
| `GET /devices/:id/handoffs` | 设备交接流水 |
| `GET /due-tasks?status=` | 逾期归还/证书到期/复核任务查询 |
| `POST /recovery/run` | 手动触发恢复扫描（服务启动时自动执行一次，之后每 30 秒扫描） |

`scripts/smoke.ts` 提供一条完整的端到端示例（登记→出借→导入→签署→撤销→解释）：

```bash
node --experimental-sqlite --import tsx scripts/smoke.ts
```
