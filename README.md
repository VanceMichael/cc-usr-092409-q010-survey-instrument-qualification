# 廊桥测绘基线仲裁库

工程以 Fastify 和 TypeScript 提供测绘基线管理的后端入口，使用 Node.js 22 的内置 SQLite API 访问 `data/bridge_baselines.sqlite3`。可通过 `DATABASE_PATH`、`HOST`、`PORT` 调整本地运行位置。

```bash
npm ci
npm run db:migrate
npm test
npm run build
npm start
```

接口、连接、迁移和启动验证分别位于 `src`、`scripts`、`migrations` 与 `test`，应用不连接远程对象存储或消息系统。应用启动时会幂等应用 `migrations` 中的迁移，并执行一次停服恢复。

## 仪器资格与借用链

- 设备登记：`POST /instruments` 登记序列号、类型与保管人；`POST /component-sets` 登记组件组合；`POST /certificates` 登记校准证书（适用精度与有效期）；`POST /maintenance` 与 `POST /maintenance/:id/close` 记录维修锁定与结论。
- 借用链：`POST /leases` 绑定班组、工作区、时间窗与用途，重叠租约在同一事务内原子拒绝；`POST /leases/:id/confirm-lend` 由保管人确认出借，`POST /leases/:id/confirm-return` 由领用人确认归还。
- 观测导入：`POST /observations/import` 冻结设备、证书与租约版本；合格数据进入候选解，过期、越区或组件不匹配的数据进入待复核而不被删除；`POST /observations/:id/adjudicate` 裁定采用、降级或隔离。
- 资格重评：`POST /certificates/:id/revoke` 与维修结论关闭只重评尚未裁定的观测；`POST /baselines/:id/sign` 签署后的基线保留原资格快照，后续资格变化仅追加风险（`GET /baselines/:id` 可见）。
- 离线交接：`POST /handovers/confirm` 按设备流水归位，同一封签并发确认只有一次成功。
- 停服恢复：启动时继续处理逾期归还、证书到期与复核任务，结果见 `GET /recovery/status` 与 `GET /tasks`。
- 追溯：`GET /observations/:id/explanation` 解释一次观测为何采用、降级或隔离，并追到设备保管人、校准依据与后续处置。
