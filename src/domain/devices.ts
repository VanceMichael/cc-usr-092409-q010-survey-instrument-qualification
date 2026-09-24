import { fail } from "../errors.js";
import { requireAccuracy, transaction, type Context } from "../runtime.js";
import { recordEvent } from "./events.js";
import type { CombinationItemRow, CombinationRow, DeviceRow } from "./types.js";

export interface RegisterDeviceInput {
  serialNumber: string;
  kind: string;
  model?: string;
  accuracyClass: string;
  calibrationRequired?: boolean;
  custodian: string;
}

export function registerDevice(ctx: Context, input: RegisterDeviceInput): DeviceRow {
  const accuracy = requireAccuracy(input.accuracyClass, "accuracyClass");
  if (!input.serialNumber?.trim()) throw fail.validation("serialNumber 必填");
  if (!input.kind?.trim()) throw fail.validation("kind 必填");
  if (!input.custodian?.trim()) throw fail.validation("custodian 必填");
  const now = ctx.now();
  const id = ctx.newId("dev");
  ctx.db
    .prepare(
      `INSERT INTO devices (id, serial_number, kind, model, accuracy_class, calibration_required, status, custodian, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .run(
      id,
      input.serialNumber.trim(),
      input.kind.trim(),
      input.model ?? null,
      accuracy,
      input.calibrationRequired === false ? 0 : 1,
      input.custodian.trim(),
      now,
      now,
    );
  recordEvent(ctx, "device.registered", "device", id, {
    serialNumber: input.serialNumber.trim(),
    custodian: input.custodian.trim(),
  });
  return getDevice(ctx, id);
}

export function getDevice(ctx: Context, id: string): DeviceRow {
  const row = ctx.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
  if (!row) throw fail.notFound("设备", id);
  return row;
}

export function getDeviceBySerial(ctx: Context, serialNumber: string): DeviceRow {
  const row = ctx.db
    .prepare("SELECT * FROM devices WHERE serial_number = ?")
    .get(serialNumber) as DeviceRow | undefined;
  if (!row) throw fail.notFound("设备(序列号)", serialNumber);
  return row;
}

export function listDevices(ctx: Context): DeviceRow[] {
  return ctx.db.prepare("SELECT * FROM devices ORDER BY created_at, id").all() as unknown as DeviceRow[];
}

export interface CreateCombinationInput {
  code: string;
  name?: string;
  accuracyClass: string;
  items: Array<{ deviceId?: string; serialNumber?: string; role: string }>;
}

export function createCombination(ctx: Context, input: CreateCombinationInput): CombinationRow {
  const accuracy = requireAccuracy(input.accuracyClass, "accuracyClass");
  if (!input.code?.trim()) throw fail.validation("code 必填");
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw fail.validation("组合至少包含一个组件");
  }
  const now = ctx.now();
  const id = ctx.newId("cmb");
  return transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO combinations (id, code, name, accuracy_class, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.code.trim(), input.name ?? null, accuracy, now, now);
    const roles = new Set<string>();
    for (const item of input.items) {
      if (!item.role?.trim()) throw fail.validation("组件 role 必填");
      const role = item.role.trim();
      if (roles.has(role)) throw fail.validation(`组件角色重复: ${role}`);
      roles.add(role);
      const device = item.deviceId
        ? getDevice(ctx, item.deviceId)
        : item.serialNumber
          ? getDeviceBySerial(ctx, item.serialNumber)
          : (() => {
              throw fail.validation("组件必须给出 deviceId 或 serialNumber");
            })();
      ctx.db
        .prepare("INSERT INTO combination_items (combination_id, device_id, role) VALUES (?, ?, ?)")
        .run(id, device.id, role);
    }
    recordEvent(ctx, "combination.created", "combination", id, {
      code: input.code.trim(),
      roles: [...roles],
    });
    return getCombination(ctx, id);
  });
}

export function getCombination(ctx: Context, id: string): CombinationRow {
  const row = ctx.db.prepare("SELECT * FROM combinations WHERE id = ?").get(id) as
    | CombinationRow
    | undefined;
  if (!row) throw fail.notFound("组件组合", id);
  return row;
}

export function getCombinationItems(ctx: Context, combinationId: string): CombinationItemRow[] {
  return ctx.db
    .prepare("SELECT * FROM combination_items WHERE combination_id = ? ORDER BY role")
    .all(combinationId) as unknown as CombinationItemRow[];
}

export function listCombinations(ctx: Context): Array<CombinationRow & { items: CombinationItemRow[] }> {
  const combos = ctx.db
    .prepare("SELECT * FROM combinations ORDER BY created_at, id")
    .all() as unknown as CombinationRow[];
  return combos.map((combo) => ({ ...combo, items: getCombinationItems(ctx, combo.id) }));
}
