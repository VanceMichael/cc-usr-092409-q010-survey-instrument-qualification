import { fail } from "../errors.js";
import { mapSqliteError, transaction, type Context } from "../runtime.js";
import { recordEvent } from "./events.js";
import { getDevice } from "./devices.js";
import type { HandoffRow } from "./types.js";

export interface RecordHandoffInput {
  deviceId?: string;
  serialNumber?: string;
  sealCode: string;
  direction: "outbound" | "inbound";
  fromParty: string;
  toParty: string;
  leaseId?: string;
  note?: string;
}

/**
 * 离线交接登记：按设备流水归位（每台设备单调递增的 sequence_no），
 * 封签号全局唯一。并发登记由 BEGIN IMMEDIATE 串行化。
 */
export function recordHandoff(ctx: Context, input: RecordHandoffInput): HandoffRow {
  if (!input.sealCode?.trim()) throw fail.validation("sealCode 必填");
  if (input.direction !== "outbound" && input.direction !== "inbound") {
    throw fail.validation("direction 必须是 outbound 或 inbound");
  }
  if (!input.fromParty?.trim()) throw fail.validation("fromParty 必填");
  if (!input.toParty?.trim()) throw fail.validation("toParty 必填");
  const device = input.deviceId
    ? getDevice(ctx, input.deviceId)
    : input.serialNumber
      ? (() => {
          const row = ctx.db
            .prepare("SELECT id FROM devices WHERE serial_number = ?")
            .get(input.serialNumber) as { id: string } | undefined;
          if (!row) throw fail.notFound("设备(序列号)", String(input.serialNumber));
          return getDevice(ctx, row.id);
        })()
      : (() => {
          throw fail.validation("必须给出 deviceId 或 serialNumber");
        })();
  const now = ctx.now();
  const id = ctx.newId("hnd");
  try {
    return transaction(ctx.db, () => {
      const seq = device.handoff_seq + 1;
      ctx.db
        .prepare(
          `INSERT INTO device_handoffs
             (id, device_id, sequence_no, seal_code, direction, from_party, to_party, lease_id, note, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          id,
          device.id,
          seq,
          input.sealCode.trim(),
          input.direction,
          input.fromParty.trim(),
          input.toParty.trim(),
          input.leaseId ?? null,
          input.note ?? null,
          now,
        );
      ctx.db
        .prepare("UPDATE devices SET handoff_seq = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(seq, now, device.id);
      recordEvent(ctx, "handoff.recorded", "handoff", id, {
        deviceId: device.id,
        sequenceNo: seq,
        sealCode: input.sealCode.trim(),
        direction: input.direction,
      });
      return getHandoff(ctx, id);
    });
  } catch (error) {
    throw mapSqliteError(error);
  }
}

export function getHandoff(ctx: Context, id: string): HandoffRow {
  const row = ctx.db.prepare("SELECT * FROM device_handoffs WHERE id = ?").get(id) as
    | HandoffRow
    | undefined;
  if (!row) throw fail.notFound("交接单", id);
  return row;
}

/**
 * 封签确认：同一封签并发确认只能一次成功。
 * 单语句条件更新（pending → confirmed）是原子的，并发下只有一个请求
 * 的 changes = 1，其余得到 SEAL_ALREADY_CONFIRMED。
 */
export function confirmHandoff(ctx: Context, handoffId: string, confirmedBy: string): HandoffRow {
  if (!confirmedBy?.trim()) throw fail.validation("confirmedBy 必填");
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const existing = getHandoff(ctx, handoffId);
    const result = ctx.db
      .prepare(
        `UPDATE device_handoffs
         SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(confirmedBy.trim(), now, handoffId);
    if (Number(result.changes) === 0) {
      throw fail.seal(`封签 ${existing.seal_code} 已确认，不能重复确认`);
    }
    recordEvent(ctx, "handoff.confirmed", "handoff", handoffId, {
      sealCode: existing.seal_code,
      confirmedBy: confirmedBy.trim(),
    });
    return getHandoff(ctx, handoffId);
  });
}

/** 设备交接流水：归位查询按 sequence_no 排序。 */
export function listHandoffs(ctx: Context, deviceId: string): HandoffRow[] {
  return ctx.db
    .prepare("SELECT * FROM device_handoffs WHERE device_id = ? ORDER BY sequence_no")
    .all(deviceId) as unknown as HandoffRow[];
}
