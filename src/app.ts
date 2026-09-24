import Fastify from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.js";
import { applyMigrations } from "./migrate.js";
import { recoverPendingWork } from "./recovery.js";
import { registerBaselineRoutes } from "./routes/baselines.js";
import { registerHandoverRoutes } from "./routes/handovers.js";
import { registerLeaseRoutes } from "./routes/leases.js";
import { registerObservationRoutes } from "./routes/observations.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { all, get } from "./store.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DatabaseSync;
  }
}

export function buildApp() {
  const app = Fastify({ logger: false });
  const database = openDatabase();
  applyMigrations(database);
  app.decorate("db", database);
  app.addHook("onClose", async () => {
    database.close();
  });

  // 停服恢复: 继续逾期归还、证书到期与复核任务
  const recovery = recoverPendingWork(database);
  database
    .prepare(
      `INSERT INTO service_state(key, value, updated_at) VALUES ('last_recovery', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(JSON.stringify(recovery));

  app.get("/health", async () => {
    app.db.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  app.get("/recovery/status", async () => {
    const row = get<{ value: string }>(app.db, "SELECT value FROM service_state WHERE key = 'last_recovery'");
    return row ? JSON.parse(row.value) : {};
  });

  app.get("/tasks", async (request) => {
    const { status } = request.query as { status?: string };
    return status
      ? all(app.db, "SELECT * FROM tasks WHERE status = ? ORDER BY created_at", status)
      : all(app.db, "SELECT * FROM tasks ORDER BY created_at");
  });

  registerRegistryRoutes(app);
  registerLeaseRoutes(app);
  registerObservationRoutes(app);
  registerBaselineRoutes(app);
  registerHandoverRoutes(app);
  return app;
}
