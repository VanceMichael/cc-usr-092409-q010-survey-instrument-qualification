import { fail } from "../errors.js";
import { mapSqliteError, parseIso, transaction, type Context } from "../runtime.js";
import { cancelDueTasks, enqueueDueTask, recordEvent } from "./events.js";
import { getDevice } from "./devices.js";
import type { DeviceRow, LeaseRow } from "./types.js";

export interface RequestLeaseInput {
  code: string;
  crew: string;
  workArea: string;
  requiredAccuracy?: string;
  purpose: string;
  startsAt: string;
  endsAt: string;
  applicant: string;
  devices: Array<{ deviceId?: string; serialNumber?: string }>;
}

function resolveDevices(ctx: Context, refs: Array<{ deviceId?: string; serialNumber?: string }>): DeviceRow[] {
  if (!Array.isArray(refs) || refs.length === 0) throw fail.validation("租约至少包含一台设备");
  const seen = new Set<string>();
  return refs.map((ref) => {
    const device = ref.deviceId
      ? getDevice(ctx, ref.deviceId)
      : ref.serialNumber
        ? (() => {
            const row = ctx.db
              .prepare("SELECT id FROM devices WHERE serial_number = ?")
              .get(ref.serialNumber) as { id: string } | undefined;
            if (!row) throw fail.notFound("设备(序列号)", String(ref.serialNumber));
            return getDevice(ctx, row.id);
          })()
        : (() => {
            throw fail.validation("每台设备必须给出 deviceId 或 serialNumber");
          })();
    if (seen.has(device.id)) throw fail.validation(`设备重复: ${device.serial_number}`);
    seen.add(device.id);
    return device;
  });
}

/**
 * 借用申请：绑定班组、工作区、时间窗、用途与设备清单。
 * 重叠租约由数据库触发器原子拒绝；BEGIN IMMEDIATE 保证并发下只有一个申请落库。
 */
export function requestLease(ctx: Context, input: RequestLeaseInput): LeaseRow {
  const startsAt = parseIso(input.startsAt, "startsAt");
  const endsAt = parseIso(input.endsAt, "endsAt");
  if (endsAt <= startsAt) throw fail.validation("endsAt 必须晚于 startsAt");
  for (const field of ["code", "crew", "workArea", "purpose", "applicant"] as const) {
    if (!input[field]?.trim()) throw fail.validation(`${field} 必填`);
  }
  const devices = resolveDevices(ctx, input.devices);
  const now = ctx.now();
  const id = ctx.newId("les");
  try {
    return transaction(ctx.db, () => {
      ctx.db
        .prepare(
          `INSERT INTO leases
             (id, code, crew, work_area, required_accuracy, purpose, starts_at, ends_at, status, applicant, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
        )
        .run(
          id,
          input.code.trim(),
          input.crew.trim(),
          input.workArea.trim(),
          input.requiredAccuracy ?? null,
          input.purpose.trim(),
          startsAt,
          endsAt,
          input.applicant.trim(),
          now,
          now,
        );
      for (const device of devices) {
        ctx.db
          .prepare("INSERT INTO lease_items (lease_id, device_id) VALUES (?, ?)")
          .run(id, device.id);
      }
      recordEvent(ctx, "lease.requested", "lease", id, {
        crew: input.crew.trim(),
        workArea: input.workArea.trim(),
        startsAt,
        endsAt,
        devices: devices.map((d) => d.serial_number),
      });
      return getLease(ctx, id);
    });
  } catch (error) {
    throw mapSqliteError(error);
  }
}

export function getLease(ctx: Context, id: string): LeaseRow {
  const row = ctx.db.prepare("SELECT * FROM leases WHERE id = ?").get(id) as LeaseRow | undefined;
  if (!row) throw fail.notFound("租约", id);
  return row;
}

export function getLeaseDevices(ctx: Context, leaseId: string): DeviceRow[] {
  return ctx.db
    .prepare(
      `SELECT d.* FROM lease_items li JOIN devices d ON d.id = li.device_id
       WHERE li.lease_id = ? ORDER BY d.serial_number`,
    )
    .all(leaseId) as unknown as DeviceRow[];
}

export function listLeases(ctx: Context, status?: string): LeaseRow[] {
  if (status) {
    return ctx.db
      .prepare("SELECT * FROM leases WHERE status = ? ORDER BY created_at, id")
      .all(status) as unknown as LeaseRow[];
  }
  return ctx.db.prepare("SELECT * FROM leases ORDER BY created_at, id").all() as unknown as LeaseRow[];
}

/** 出借确认：必须由每台设备的当前保管人执行。 */
export function confirmLend(ctx: Context, leaseId: string, custodian: string, pickupPerson?: string): LeaseRow {
  if (!custodian?.trim()) throw fail.validation("custodian 必填");
  const now = ctx.now();
  try {
    return transaction(ctx.db, () => {
      const lease = getLease(ctx, leaseId);
      if (lease.status !== "requested") {
        throw fail.illegal(`租约状态 ${lease.status} 不能出借`, { leaseId });
      }
      const devices = getLeaseDevices(ctx, leaseId);
      for (const device of devices) {
        if (device.custodian !== custodian.trim()) {
          throw fail.illegal("出借确认人必须是设备当前保管人", {
            device: device.serial_number,
            custodian: device.custodian,
          });
        }
        if (device.status !== "active") {
          throw fail.illegal("设备不在可出借状态", {
            device: device.serial_number,
            status: device.status,
          });
        }
      }
      ctx.db
        .prepare(
          `UPDATE leases
           SET status = 'lent', custodian = ?, pickup_person = ?, lent_at = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(custodian.trim(), pickupPerson ?? null, now, now, leaseId);
      // 逾期归还任务：停服恢复后继续追踪
      enqueueDueTask(ctx, "overdue_return", "lease", leaseId, lease.ends_at, {
        code: lease.code,
        crew: lease.crew,
      });
      recordEvent(ctx, "lease.lent", "lease", leaseId, {
        custodian: custodian.trim(),
        pickupPerson: pickupPerson ?? null,
      });
      return getLease(ctx, leaseId);
    });
  } catch (error) {
    throw mapSqliteError(error);
  }
}

/** 归还确认：必须由领用人（申请人）执行。 */
export function confirmReturn(ctx: Context, leaseId: string, returnConfirmer: string): LeaseRow {
  if (!returnConfirmer?.trim()) throw fail.validation("returnConfirmer 必填");
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const lease = getLease(ctx, leaseId);
    if (lease.status !== "lent") throw fail.illegal(`租约状态 ${lease.status} 不能归还`, { leaseId });
    if (lease.applicant !== returnConfirmer.trim()) {
      throw fail.illegal("归还确认人必须是领用人", { applicant: lease.applicant });
    }
    ctx.db
      .prepare(
        `UPDATE leases
         SET status = 'returned', returned_at = ?, return_confirmer = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, returnConfirmer.trim(), now, leaseId);
    cancelDueTasks(ctx, "overdue_return", leaseId);
    recordEvent(ctx, "lease.returned", "lease", leaseId, {
      returnConfirmer: returnConfirmer.trim(),
      overdue: lease.overdue === 1,
    });
    return getLease(ctx, leaseId);
  });
}

export function rejectLease(ctx: Context, leaseId: string, reason: string): LeaseRow {
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const lease = getLease(ctx, leaseId);
    if (lease.status !== "requested") throw fail.illegal(`租约状态 ${lease.status} 不能驳回`, { leaseId });
    ctx.db
      .prepare("UPDATE leases SET status = 'rejected', version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, leaseId);
    recordEvent(ctx, "lease.rejected", "lease", leaseId, { reason });
    return getLease(ctx, leaseId);
  });
}

export function cancelLease(ctx: Context, leaseId: string): LeaseRow {
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const lease = getLease(ctx, leaseId);
    if (lease.status !== "requested") throw fail.illegal(`租约状态 ${lease.status} 不能取消`, { leaseId });
    ctx.db
      .prepare("UPDATE leases SET status = 'cancelled', version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, leaseId);
    recordEvent(ctx, "lease.cancelled", "lease", leaseId, {});
    return getLease(ctx, leaseId);
  });
}
