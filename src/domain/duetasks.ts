import type { Context } from "../runtime.js";
import { enqueueDueTask, recordEvent } from "./events.js";
import type { DueTaskRow } from "./types.js";

const REVIEW_SLA_MS = 24 * 60 * 60 * 1000;

/**
 * 对账：为逾期归还、证书到期、待复核补齐持久化任务。
 * 幂等（同一引用只有一个活动任务），停服恢复后调用即可续跑。
 */
export function reconcileDueTasks(ctx: Context): { enqueued: number } {
  const now = ctx.now();
  let enqueued = 0;
  const lentLeases = ctx.db
    .prepare("SELECT id, ends_at, code, crew FROM leases WHERE status = 'lent'")
    .all() as Array<{ id: string; ends_at: string; code: string; crew: string }>;
  for (const lease of lentLeases) {
    if (enqueueDueTask(ctx, "overdue_return", "lease", lease.id, lease.ends_at, {
      code: lease.code,
      crew: lease.crew,
    })) enqueued += 1;
  }
  const validCerts = ctx.db
    .prepare("SELECT id, valid_until, device_id FROM calibration_certificates WHERE status = 'valid'")
    .all() as Array<{ id: string; valid_until: string; device_id: string }>;
  for (const cert of validCerts) {
    if (enqueueDueTask(ctx, "certificate_expiry", "certificate", cert.id, cert.valid_until, {
      deviceId: cert.device_id,
    })) enqueued += 1;
  }
  const reviewObs = ctx.db
    .prepare("SELECT id, packet_id, updated_at FROM observations WHERE status = 'review' AND baseline_id IS NULL")
    .all() as Array<{ id: string; packet_id: string; updated_at: string }>;
  for (const obs of reviewObs) {
    const dueAt = new Date(
      Math.min(Date.parse(obs.updated_at) + REVIEW_SLA_MS, Date.parse(now) + REVIEW_SLA_MS),
    ).toISOString();
    if (enqueueDueTask(ctx, "review", "observation", obs.id, dueAt, { packetId: obs.packet_id })) {
      enqueued += 1;
    }
  }
  return { enqueued };
}

/** 崩溃恢复：claimed 但未完成的任务重新置为 pending。 */
export function recoverStaleTasks(ctx: Context): number {
  const result = ctx.db
    .prepare("UPDATE due_tasks SET status = 'pending', updated_at = ? WHERE status = 'claimed'")
    .run(ctx.now());
  return Number(result.changes);
}

function processTask(ctx: Context, task: DueTaskRow): void {
  const now = ctx.now();
  if (task.type === "overdue_return") {
    const lease = ctx.db.prepare("SELECT * FROM leases WHERE id = ?").get(task.ref_id) as
      | { id: string; status: string; ends_at: string; overdue: number; code: string }
      | undefined;
    if (lease && lease.status === "lent" && lease.ends_at < now && lease.overdue === 0) {
      ctx.db
        .prepare("UPDATE leases SET overdue = 1, version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, lease.id);
      recordEvent(ctx, "lease.overdue", "lease", lease.id, { code: lease.code, endsAt: lease.ends_at });
    }
    return;
  }
  if (task.type === "certificate_expiry") {
    const cert = ctx.db
      .prepare("SELECT * FROM calibration_certificates WHERE id = ?")
      .get(task.ref_id) as
      | { id: string; status: string; valid_until: string; certificate_no: string; device_id: string }
      | undefined;
    if (cert && cert.status === "valid" && cert.valid_until < now) {
      ctx.db
        .prepare(
          "UPDATE calibration_certificates SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, cert.id);
      recordEvent(ctx, "certificate.expired", "certificate", cert.id, {
        certificateNo: cert.certificate_no,
        validUntil: cert.valid_until,
      });
    }
    return;
  }
  if (task.type === "review") {
    const obs = ctx.db.prepare("SELECT * FROM observations WHERE id = ?").get(task.ref_id) as
      | { id: string; status: string; baseline_id: string | null; packet_id: string }
      | undefined;
    if (obs && obs.status === "review" && obs.baseline_id === null) {
      recordEvent(ctx, "observation.review_overdue", "observation", obs.id, {
        packetId: obs.packet_id,
      });
    }
    return;
  }
  throw new Error(`未知任务类型: ${task.type}`);
}

export interface RunDueResult {
  claimed: number;
  completed: number;
  failed: number;
  errors: Array<{ taskId: string; type: string; error: string }>;
}

/** 执行到期任务：逐条原子认领，失败回到 pending 等待重试。 */
export function runDueTasks(ctx: Context, limit = 50): RunDueResult {
  const now = ctx.now();
  const due = ctx.db
    .prepare(
      "SELECT * FROM due_tasks WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT ?",
    )
    .all(now, limit) as unknown as DueTaskRow[];
  const result: RunDueResult = { claimed: 0, completed: 0, failed: 0, errors: [] };
  for (const task of due) {
    const claim = ctx.db
      .prepare(
        `UPDATE due_tasks SET status = 'claimed', claimed_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, now, task.id);
    if (Number(claim.changes) === 0) continue; // 已被其他执行者认领
    result.claimed += 1;
    try {
      processTask(ctx, { ...task, attempts: task.attempts + 1 });
      ctx.db
        .prepare("UPDATE due_tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, task.id);
      result.completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.db
        .prepare("UPDATE due_tasks SET status = 'pending', last_error = ?, updated_at = ? WHERE id = ?")
        .run(message, now, task.id);
      result.failed += 1;
      result.errors.push({ taskId: task.id, type: task.type, error: message });
    }
  }
  return result;
}

export function listDueTasks(ctx: Context, status?: string): DueTaskRow[] {
  if (status) {
    return ctx.db
      .prepare("SELECT * FROM due_tasks WHERE status = ? ORDER BY due_at")
      .all(status) as unknown as DueTaskRow[];
  }
  return ctx.db.prepare("SELECT * FROM due_tasks ORDER BY due_at").all() as unknown as DueTaskRow[];
}
