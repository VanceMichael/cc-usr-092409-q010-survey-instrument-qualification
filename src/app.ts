import Fastify, { type FastifyInstance } from "fastify";

import { openDatabase } from "./database.js";
import { DomainError } from "./errors.js";
import { runMigrations } from "./migrate.js";
import { registerRoutes } from "./routes.js";
import { createContext, type Context } from "./runtime.js";
import { reconcileDueTasks, recoverStaleTasks, runDueTasks } from "./domain/duetasks.js";

export interface AppOptions {
  databasePath?: string;
  now?: () => string;
  /** 到期任务扫描间隔毫秒；0 表示关闭定时器（测试用手动触发）。 */
  recoveryIntervalMs?: number;
}

export interface AppWithContext extends FastifyInstance {
  ctx: Context;
}

export function buildApp(options: AppOptions = {}): AppWithContext {
  const database = openDatabase(options.databasePath);
  runMigrations(database);
  const ctx = createContext(database, options.now);

  const app = Fastify({ logger: false }) as unknown as AppWithContext;
  app.ctx = ctx;

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof DomainError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details ?? null } });
    }
    if (error instanceof Error && error.message.includes("OVERLAPPING_LEASE")) {
      return reply.status(409).send({
        error: { code: "OVERLAPPING_LEASE", message: "同一设备的时间窗与既有租约重叠，已原子拒绝", details: null },
      });
    }
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return reply.status(409).send({
        error: { code: "CONFLICT", message: "唯一性约束冲突（记录已存在，原始数据不可覆盖）", details: null },
      });
    }
    const statusCode =
      error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 500 ? "INTERNAL" : "REQUEST_ERROR",
        message: error instanceof Error ? error.message : String(error),
        details: null,
      },
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "路由不存在", details: null } }),
  );

  app.get("/health", async () => {
    database.prepare("SELECT 1").get();
    return { status: "ok" };
  });

  registerRoutes(app, ctx);

  // 停服恢复：启动即续跑逾期归还、证书到期与复核任务，之后按间隔扫描
  const startupRecovery = () => {
    recoverStaleTasks(ctx);
    reconcileDueTasks(ctx);
    runDueTasks(ctx);
  };
  startupRecovery();
  const intervalMs = options.recoveryIntervalMs ?? 30_000;
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          try {
            startupRecovery();
          } catch {
            // 下一轮继续；错误已由 runDueTasks 记录到任务本身
          }
        }, intervalMs)
      : null;
  timer?.unref();

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    database.close();
  });

  return app;
}
