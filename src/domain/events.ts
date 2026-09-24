import type { Context } from "../runtime.js";

/** 追加领域事件（审计时间线）。 */
export function recordEvent(
  ctx: Context,
  type: string,
  subjectType: string,
  subjectId: string,
  detail: Record<string, unknown> = {},
): void {
  ctx.db
    .prepare(
      "INSERT INTO domain_events (id, at, type, subject_type, subject_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(ctx.newId("evt"), ctx.now(), type, subjectType, subjectId, JSON.stringify(detail));
}

/**
 * 登记停服恢复任务。同一 (type, ref_id) 只允许一个活动任务，
 * 已存在时静默跳过（幂等），返回是否新建。
 */
export function enqueueDueTask(
  ctx: Context,
  type: string,
  refType: string,
  refId: string,
  dueAt: string,
  payload: Record<string, unknown> = {},
): boolean {
  const existing = ctx.db
    .prepare(
      "SELECT id FROM due_tasks WHERE type = ? AND ref_id = ? AND status IN ('pending','claimed')",
    )
    .get(type, refId) as { id: string } | undefined;
  if (existing) return false;
  const now = ctx.now();
  ctx.db
    .prepare(
      `INSERT INTO due_tasks (id, type, ref_type, ref_id, due_at, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(ctx.newId("task"), type, refType, refId, dueAt, JSON.stringify(payload), now, now);
  return true;
}

/** 取消某引用的活动任务（如租约已归还、复核已完成）。 */
export function cancelDueTasks(ctx: Context, type: string, refId: string): number {
  const now = ctx.now();
  const result = ctx.db
    .prepare(
      `UPDATE due_tasks SET status = 'cancelled', updated_at = ?
       WHERE type = ? AND ref_id = ? AND status IN ('pending','claimed')`,
    )
    .run(now, type, refId);
  return Number(result.changes);
}
