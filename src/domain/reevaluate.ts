import type { Context } from "../runtime.js";
import { cancelDueTasks, enqueueDueTask, recordEvent } from "./events.js";
import { getObservation, getObservationDevices } from "./observations.js";
import { qualify } from "./qualification.js";
import type { CertificateRow, MaintenanceRow, ObservationRow } from "./types.js";

const REVIEW_SLA_MS = 24 * 60 * 60 * 1000;

/**
 * 重评单条未签署观测：用当前可追溯事实（维修区间、证书撤销、租约区间）
 * 重新求值；冻结的导入快照与规则轨迹保持不变，结果写入 current_trace。
 */
function reevaluateOne(ctx: Context, observationId: string, trigger: Record<string, unknown>): boolean {
  const row = getObservation(ctx, observationId);
  const devices = getObservationDevices(ctx, observationId).map((d) => ({
    deviceId: d.device_id,
    role: d.role,
  }));
  const result = qualify(ctx, {
    observedAt: row.observed_at,
    crew: row.crew,
    workArea: row.work_area,
    requiredAccuracy: row.required_accuracy,
    combinationId: row.combination_id,
    devices,
    mode: "reevaluate",
  });
  const status = result.failures.length === 0 ? "candidate" : "review";
  const decision = result.failures.length === 0 ? "adopted" : "downgraded";
  const now = ctx.now();
  const changed = status !== row.status;
  ctx.db
    .prepare(
      `UPDATE observations
       SET status = ?, decision = ?, failure_reasons = ?, current_trace = ?,
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      decision,
      JSON.stringify(result.failures),
      JSON.stringify({ at: now, mode: "reevaluate", trigger, checks: result.checks }),
      now,
      observationId,
    );
  if (status === "review") {
    enqueueDueTask(ctx, "review", "observation", observationId, new Date(Date.parse(now) + REVIEW_SLA_MS).toISOString(), {
      packetId: row.packet_id,
    });
  } else {
    cancelDueTasks(ctx, "review", observationId);
  }
  recordEvent(ctx, "observation.reevaluated", "observation", observationId, {
    trigger,
    before: { status: row.status, decision: row.decision },
    after: { status, decision, failures: result.failures },
  });
  return changed;
}

interface ReevalOutcome {
  reevaluated: number;
  risksAppended: number;
}

function appendBaselineRisk(
  ctx: Context,
  baselineId: string,
  source: string,
  refId: string,
  observationId: string,
  summary: string,
  detail: Record<string, unknown>,
): boolean {
  const result = ctx.db
    .prepare(
      `INSERT OR IGNORE INTO baseline_risks (id, baseline_id, source, ref_id, observation_id, summary, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.newId("rsk"), baselineId, source, refId, observationId, summary, JSON.stringify(detail), ctx.now());
  return Number(result.changes) > 0;
}

/** 重评范围：未签署（baseline_id IS NULL）且未隔离的观测。 */
function unsignedObservations(ctx: Context, deviceId: string, from: string, to: string): ObservationRow[] {
  return ctx.db
    .prepare(
      `SELECT o.* FROM observations o
       JOIN observation_devices od ON od.observation_id = o.id
       WHERE od.device_id = ?
         AND o.baseline_id IS NULL
         AND o.status IN ('candidate','review')
         AND ? <= o.observed_at AND o.observed_at <= ?`,
    )
    .all(deviceId, from, to) as unknown as ObservationRow[];
}

/** 已签署观测：所在基线保留原资格快照，追加风险。 */
function signedObservations(ctx: Context, deviceId: string, from: string, to: string): ObservationRow[] {
  return ctx.db
    .prepare(
      `SELECT o.* FROM observations o
       JOIN observation_devices od ON od.observation_id = o.id
       WHERE od.device_id = ?
         AND o.baseline_id IS NOT NULL
         AND ? <= o.observed_at AND o.observed_at <= ?`,
    )
    .all(deviceId, from, to) as unknown as ObservationRow[];
}

/** 证书撤销（可追溯）：只重评未签署观测；已签署基线追加风险。 */
export function reevaluateAfterCertificateRevoked(ctx: Context, certificateId: string): ReevalOutcome {
  const cert = ctx.db
    .prepare("SELECT * FROM calibration_certificates WHERE id = ?")
    .get(certificateId) as unknown as CertificateRow;
  const trigger = { type: "certificate_revoked", certificateId, certificateNo: cert.certificate_no };
  let reevaluated = 0;
  for (const obs of unsignedObservations(ctx, cert.device_id, cert.valid_from, cert.valid_until)) {
    if (reevaluateOne(ctx, obs.id, trigger)) reevaluated += 1;
  }
  let risksAppended = 0;
  for (const obs of signedObservations(ctx, cert.device_id, cert.valid_from, cert.valid_until)) {
    const appended = appendBaselineRisk(
      ctx,
      obs.baseline_id as string,
      "certificate_revoked",
      certificateId,
      obs.id,
      `校准证书 ${cert.certificate_no} 已撤销，观测 ${obs.packet_id} 的资格快照保留但存在风险`,
      { certificateNo: cert.certificate_no, packetId: obs.packet_id, observedAt: obs.observed_at },
    );
    if (appended) {
      risksAppended += 1;
      recordEvent(ctx, "baseline.risk_appended", "baseline", obs.baseline_id as string, {
        source: "certificate_revoked",
        refId: certificateId,
        observationId: obs.id,
      });
    }
  }
  return { reevaluated, risksAppended };
}

/** 维修结论（可能迟到）：只重评未签署观测；已签署基线追加风险。 */
export function reevaluateAfterMaintenance(ctx: Context, maintenanceId: string): ReevalOutcome {
  const m = ctx.db.prepare("SELECT * FROM maintenance_events WHERE id = ?").get(maintenanceId) as unknown as MaintenanceRow;
  const to = m.closed_at ?? ctx.now();
  const trigger = { type: "maintenance_conclusion", maintenanceId, conclusion: m.conclusion };
  let reevaluated = 0;
  for (const obs of unsignedObservations(ctx, m.device_id, m.opened_at, to)) {
    if (reevaluateOne(ctx, obs.id, trigger)) reevaluated += 1;
  }
  let risksAppended = 0;
  for (const obs of signedObservations(ctx, m.device_id, m.opened_at, to)) {
    const appended = appendBaselineRisk(
      ctx,
      obs.baseline_id as string,
      "maintenance_conclusion",
      maintenanceId,
      obs.id,
      `设备维修结论（${m.conclusion ?? "结案"}）覆盖观测 ${obs.packet_id}，资格快照保留但存在风险`,
      { maintenanceId, packetId: obs.packet_id, observedAt: obs.observed_at },
    );
    if (appended) {
      risksAppended += 1;
      recordEvent(ctx, "baseline.risk_appended", "baseline", obs.baseline_id as string, {
        source: "maintenance_conclusion",
        refId: maintenanceId,
        observationId: obs.id,
      });
    }
  }
  return { reevaluated, risksAppended };
}
