import { fail } from "../errors.js";
import { mapSqliteError, parseIso, transaction, type Context } from "../runtime.js";
import { cancelDueTasks, enqueueDueTask, recordEvent } from "./events.js";
import { qualify, type QualifyResult } from "./qualification.js";
import type { ObservationDeviceRow, ObservationRow } from "./types.js";

/** 复核任务在观测进入待复核后 24h 到期（停服恢复后继续）。 */
const REVIEW_SLA_MS = 24 * 60 * 60 * 1000;

export interface ImportObservationInput {
  packetId: string;
  observedAt: string;
  crew: string;
  workArea: string;
  requiredAccuracy?: string;
  combinationId?: string;
  summary?: string;
  sequenceNo?: string;
  easting?: number;
  northing?: number;
  elevation?: number;
  devices: Array<{ deviceId?: string; serialNumber?: string; role: string }>;
}

function isComplete(input: ImportObservationInput): boolean {
  return Boolean(
    input.summary?.trim() &&
      input.sequenceNo?.trim() &&
      typeof input.easting === "number" &&
      typeof input.northing === "number" &&
      input.devices.length > 0,
  );
}

function reviewTaskDueAt(now: string): string {
  return new Date(Date.parse(now) + REVIEW_SLA_MS).toISOString();
}

/**
 * 观测导入：原始采集包不可覆盖（packetId 唯一），导入即冻结
 * 设备/证书/租约/组合版本快照与规则轨迹。合格进候选解，
 * 过期/越区/组件不匹配等待复核，绝不删除。
 */
export function importObservation(ctx: Context, input: ImportObservationInput): ObservationRow {
  const observedAt = parseIso(input.observedAt, "observedAt");
  for (const field of ["packetId", "crew", "workArea"] as const) {
    if (!input[field]?.trim()) throw fail.validation(`${field} 必填`);
  }
  if (!Array.isArray(input.devices) || input.devices.length === 0) {
    throw fail.validation("devices 至少一条（观测使用的设备与角色）");
  }
  const complete = isComplete(input);
  const now = ctx.now();
  const id = ctx.newId("obs");

  try {
    return transaction(ctx.db, () => {
    // 解析设备引用；无法解析的序列号记为资格失败但不丢数据
    const resolved: Array<{ deviceId: string; role: string }> = [];
    const unknownSerials: string[] = [];
    for (const ref of input.devices) {
      if (!ref.role?.trim()) throw fail.validation("每台设备必须给出 role");
      let deviceId: string | null = null;
      if (ref.deviceId) {
        const row = ctx.db.prepare("SELECT id FROM devices WHERE id = ?").get(ref.deviceId) as
          | { id: string }
          | undefined;
        deviceId = row?.id ?? null;
        if (!deviceId) unknownSerials.push(ref.deviceId);
      } else if (ref.serialNumber) {
        const row = ctx.db
          .prepare("SELECT id FROM devices WHERE serial_number = ?")
          .get(ref.serialNumber) as { id: string } | undefined;
        deviceId = row?.id ?? null;
        if (!deviceId) unknownSerials.push(ref.serialNumber);
      } else {
        throw fail.validation("每台设备必须给出 deviceId 或 serialNumber");
      }
      if (deviceId) resolved.push({ deviceId, role: ref.role.trim() });
    }

    let result: QualifyResult | null = null;
    let status: string;
    let decision: string;
    let failures: string[];
    if (!complete) {
      // 隔离：摘要、序号、坐标不完整，不参与仲裁，等待补全后裁定
      status = "quarantined";
      decision = "isolated";
      failures = ["packet_incomplete"];
    } else {
      result = qualify(ctx, {
        observedAt,
        crew: input.crew.trim(),
        workArea: input.workArea.trim(),
        requiredAccuracy: input.requiredAccuracy ?? null,
        combinationId: input.combinationId ?? null,
        devices: resolved,
        mode: "import",
      });
      failures = [...result.failures];
      for (const serial of unknownSerials) failures.push("unknown_device");
      if (failures.length === 0) {
        status = "candidate";
        decision = "adopted";
      } else {
        status = "review";
        decision = "downgraded";
      }
    }

    const snapshot = result ? JSON.stringify(result.evidence) : null;
    const trace = result
      ? JSON.stringify({ at: observedAt, mode: "import", checks: result.checks, unknownSerials })
      : JSON.stringify({ at: observedAt, mode: "import", checks: [], unknownSerials, note: "采集包不完整，未参与资格判定" });

    ctx.db
      .prepare(
        `INSERT INTO observations
           (id, packet_id, observed_at, crew, work_area, required_accuracy, combination_id,
            summary, sequence_no, easting, northing, elevation, complete,
            status, decision, failure_reasons, qualification_snapshot, rule_trace, current_trace,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.packetId.trim(),
        observedAt,
        input.crew.trim(),
        input.workArea.trim(),
        input.requiredAccuracy ?? null,
        input.combinationId ?? null,
        input.summary ?? null,
        input.sequenceNo ?? null,
        input.easting ?? null,
        input.northing ?? null,
        input.elevation ?? null,
        complete ? 1 : 0,
        status,
        decision,
        JSON.stringify(failures),
        snapshot,
        trace,
        trace,
        now,
        now,
      );
    for (const ref of resolved) {
      ctx.db
        .prepare("INSERT INTO observation_devices (observation_id, device_id, role) VALUES (?, ?, ?)")
        .run(id, ref.deviceId, ref.role);
    }
    if (status === "review") {
      enqueueDueTask(ctx, "review", "observation", id, reviewTaskDueAt(now), {
        packetId: input.packetId.trim(),
      });
    }
    recordEvent(ctx, "observation.imported", "observation", id, {
      packetId: input.packetId.trim(),
      status,
      decision,
      failures,
    });
    return getObservation(ctx, id);
  });
  } catch (error) {
    throw mapSqliteError(error);
  }
}

export function getObservation(ctx: Context, id: string): ObservationRow {
  const row = ctx.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as
    | ObservationRow
    | undefined;
  if (!row) throw fail.notFound("观测", id);
  return row;
}

export function getObservationDevices(ctx: Context, observationId: string): ObservationDeviceRow[] {
  return ctx.db
    .prepare("SELECT * FROM observation_devices WHERE observation_id = ? ORDER BY role")
    .all(observationId) as unknown as ObservationDeviceRow[];
}

export function listObservations(ctx: Context, status?: string): ObservationRow[] {
  if (status) {
    return ctx.db
      .prepare("SELECT * FROM observations WHERE status = ? ORDER BY observed_at, id")
      .all(status) as unknown as ObservationRow[];
  }
  return ctx.db.prepare("SELECT * FROM observations ORDER BY observed_at, id").all() as unknown as ObservationRow[];
}

export interface ReviewInput {
  disposition: "released" | "isolated";
  reviewedBy: string;
  note?: string;
}

/**
 * 复核裁定：released 解除隔离/降级进入候选解；isolated 隔离保留（不删除）。
 * 隔离数据只有在摘要、序号和坐标完整后才能解除隔离参与仲裁。
 */
export function reviewObservation(ctx: Context, id: string, input: ReviewInput): ObservationRow {
  if (!input.reviewedBy?.trim()) throw fail.validation("reviewedBy 必填");
  if (input.disposition !== "released" && input.disposition !== "isolated") {
    throw fail.validation("disposition 必须是 released 或 isolated");
  }
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const row = getObservation(ctx, id);
    if (row.baseline_id) throw fail.illegal("观测已签署进基线，资格快照已冻结，不能裁定", { id });
    if (row.status !== "review" && row.status !== "quarantined") {
      throw fail.illegal(`观测状态 ${row.status} 不需要复核裁定`, { id });
    }
    let status: string;
    let decision: string;
    if (input.disposition === "released") {
      if (row.complete !== 1) {
        throw fail.illegal("摘要、序号或坐标不完整，不能解除隔离参与仲裁", { id });
      }
      status = "candidate";
      decision = "adopted";
    } else {
      status = "quarantined";
      decision = "isolated";
    }
    ctx.db
      .prepare(
        `UPDATE observations
         SET status = ?, decision = ?, review_disposition = ?, reviewed_by = ?, reviewed_at = ?,
             review_note = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, decision, input.disposition, input.reviewedBy.trim(), now, input.note ?? null, now, id);
    cancelDueTasks(ctx, "review", id);
    recordEvent(ctx, "observation.reviewed", "observation", id, {
      disposition: input.disposition,
      reviewedBy: input.reviewedBy.trim(),
      note: input.note ?? null,
    });
    return getObservation(ctx, id);
  });
}
