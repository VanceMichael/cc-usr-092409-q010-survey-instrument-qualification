import { fail } from "../errors.js";
import { parseIso, transaction, type Context } from "../runtime.js";
import { recordEvent } from "./events.js";
import { getDevice } from "./devices.js";
import { reevaluateAfterMaintenance } from "./reevaluate.js";
import type { MaintenanceRow } from "./types.js";

export interface OpenMaintenanceInput {
  deviceId?: string;
  serialNumber?: string;
  openedAt: string;
  reason?: string;
}

function resolveDeviceId(ctx: Context, input: { deviceId?: string; serialNumber?: string }): string {
  if (input.deviceId) return getDevice(ctx, input.deviceId).id;
  if (input.serialNumber) {
    const row = ctx.db
      .prepare("SELECT id FROM devices WHERE serial_number = ?")
      .get(input.serialNumber) as { id: string } | undefined;
    if (!row) throw fail.notFound("设备(序列号)", input.serialNumber);
    return row.id;
  }
  throw fail.validation("必须给出 deviceId 或 serialNumber");
}

/** 开启维修：设备进入维修锁定，锁定期间的观测导入会被降级。 */
export function openMaintenance(ctx: Context, input: OpenMaintenanceInput): MaintenanceRow {
  const deviceId = resolveDeviceId(ctx, input);
  const openedAt = parseIso(input.openedAt, "openedAt");
  const now = ctx.now();
  const id = ctx.newId("mnt");
  return transaction(ctx.db, () => {
    const device = getDevice(ctx, deviceId);
    if (device.status === "retired") throw fail.illegal("设备已退役，不能开维修单", { deviceId });
    const open = ctx.db
      .prepare("SELECT id FROM maintenance_events WHERE device_id = ? AND status = 'open'")
      .get(deviceId) as { id: string } | undefined;
    if (open) throw fail.conflict("设备已有未结维修单", { deviceId, maintenanceId: open.id });
    ctx.db
      .prepare(
        `INSERT INTO maintenance_events (id, device_id, opened_at, status, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, deviceId, openedAt, now, now);
    ctx.db
      .prepare("UPDATE devices SET status = 'maintenance', version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, deviceId);
    recordEvent(ctx, "maintenance.opened", "maintenance", id, {
      deviceId,
      openedAt,
      reason: input.reason ?? null,
    });
    return getMaintenance(ctx, id);
  });
}

export interface CloseMaintenanceInput {
  closedAt: string;
  conclusion: string;
}

export interface CloseMaintenanceResult {
  maintenance: MaintenanceRow;
  reevaluated: number;
  risksAppended: number;
}

/**
 * 维修结论（可能迟到：closedAt 早于当前时间）。
 * 只重评尚未签署进基线的观测；已签署基线保留原资格快照并追加风险。
 */
export function closeMaintenance(
  ctx: Context,
  id: string,
  input: CloseMaintenanceInput,
): CloseMaintenanceResult {
  const closedAt = parseIso(input.closedAt, "closedAt");
  if (!input.conclusion?.trim()) throw fail.validation("维修结论必填");
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const row = getMaintenance(ctx, id);
    if (row.status !== "open") throw fail.illegal("维修单已结案", { id });
    if (closedAt < row.opened_at) throw fail.validation("closedAt 不能早于 openedAt");
    ctx.db
      .prepare(
        `UPDATE maintenance_events
         SET status = 'closed', closed_at = ?, conclusion = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(closedAt, input.conclusion.trim(), now, id);
    const device = getDevice(ctx, row.device_id);
    if (device.status === "maintenance") {
      ctx.db
        .prepare("UPDATE devices SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now, row.device_id);
    }
    recordEvent(ctx, "maintenance.closed", "maintenance", id, {
      deviceId: row.device_id,
      closedAt,
      conclusion: input.conclusion.trim(),
      late: closedAt < now,
    });
    const outcome = reevaluateAfterMaintenance(ctx, id);
    return { maintenance: getMaintenance(ctx, id), ...outcome };
  });
}

export function getMaintenance(ctx: Context, id: string): MaintenanceRow {
  const row = ctx.db
    .prepare("SELECT * FROM maintenance_events WHERE id = ?")
    .get(id) as MaintenanceRow | undefined;
  if (!row) throw fail.notFound("维修单", id);
  return row;
}

export function listMaintenance(ctx: Context, deviceId?: string): MaintenanceRow[] {
  if (deviceId) {
    return ctx.db
      .prepare("SELECT * FROM maintenance_events WHERE device_id = ? ORDER BY opened_at")
      .all(deviceId) as unknown as MaintenanceRow[];
  }
  return ctx.db.prepare("SELECT * FROM maintenance_events ORDER BY created_at, id").all() as unknown as MaintenanceRow[];
}
