import type { DatabaseSync } from "node:sqlite";
import { addEvent, all, ensureTask, get } from "./store.js";
import type { CertificateRow, LeaseRow, ObservationRow } from "./store.js";

/** 适用精度等级, 数值越小精度越高; 证书等级不大于观测要求等级即为满足。 */
export const PRECISION_RANK: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  一等: 1,
  二等: 2,
  三等: 3,
  四等: 4,
};

export interface EvaluationInput {
  instrumentId: string;
  componentSetId: string | null;
  observedAt: string;
  zone: string;
  requiredPrecision: string;
}

export interface EvaluationResult {
  status: "candidate" | "pending_review";
  reasons: string[];
  certificate: CertificateRow | null;
  lease: LeaseRow | null;
}

/**
 * 按观测时刻评估仪器资格: 维修锁定、校准证书、适用精度、租约窗口与工作区、组件组合。
 * 全部合格进入候选解, 任一不满足进入待复核(数据保留, 不删除)。
 */
export function evaluateObservation(db: DatabaseSync, input: EvaluationInput): EvaluationResult {
  const reasons = new Set<string>();

  const maintenanceLocks = all<{ closed_at: string | null; conclusion_ok: number | null }>(
    db,
    `SELECT closed_at, conclusion_ok FROM maintenance_records
     WHERE instrument_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at >= ?)`,
    input.instrumentId,
    input.observedAt,
    input.observedAt,
  );
  for (const record of maintenanceLocks) {
    if (record.conclusion_ok === 1) continue;
    reasons.add(record.closed_at === null ? "maintenance_lock" : "maintenance_failed");
  }

  const certificate = get<CertificateRow>(
    db,
    `SELECT * FROM certificates WHERE instrument_id = ? AND valid_from <= ? AND valid_until >= ?
     ORDER BY valid_until DESC LIMIT 1`,
    input.instrumentId,
    input.observedAt,
    input.observedAt,
  );
  if (!certificate) {
    const anyCertificate = get<{ id: string }>(db, "SELECT id FROM certificates WHERE instrument_id = ? LIMIT 1", input.instrumentId);
    reasons.add(anyCertificate ? "certificate_expired" : "certificate_missing");
  } else if (certificate.status === "revoked") {
    reasons.add("certificate_revoked");
  } else if (certificate.status === "expired") {
    reasons.add("certificate_expired");
  }

  const requiredRank = PRECISION_RANK[input.requiredPrecision];
  const certificateRank = certificate ? PRECISION_RANK[certificate.precision_class] : undefined;
  if (requiredRank === undefined || (certificate && certificateRank === undefined)) {
    reasons.add("precision_unknown");
  } else if (certificate && certificateRank !== undefined && certificateRank > requiredRank) {
    reasons.add("precision_insufficient");
  }

  const lease = get<LeaseRow>(
    db,
    `SELECT * FROM leases
     WHERE instrument_id = ? AND window_start <= ? AND window_end >= ?
       AND (returned_at IS NULL OR returned_at >= ?)
     ORDER BY window_start DESC LIMIT 1`,
    input.instrumentId,
    input.observedAt,
    input.observedAt,
    input.observedAt,
  );
  if (!lease) {
    reasons.add("lease_missing");
  } else {
    if (lease.zone !== input.zone) reasons.add("zone_mismatch");
    if (lease.state === "requested") reasons.add("lease_not_lent");
  }

  if (input.componentSetId) {
    const componentSet = get<{ id: string }>(db, "SELECT id FROM component_sets WHERE id = ?", input.componentSetId);
    if (!componentSet) {
      reasons.add("component_unknown");
    } else {
      const membership = get<{ ok: number }>(
        db,
        "SELECT 1 AS ok FROM component_set_members WHERE set_id = ? AND instrument_id = ?",
        input.componentSetId,
        input.instrumentId,
      );
      if (!membership) reasons.add("component_mismatch");
    }
  }

  const list = [...reasons];
  return {
    status: list.length === 0 ? "candidate" : "pending_review",
    reasons: list,
    certificate: certificate ?? null,
    lease: lease ?? null,
  };
}

/**
 * 证书撤销、证书到期或维修结论迟到时重评观测。
 * 只重评尚未裁定的观测(候选/待复核); 已签署基线中的观测保留原资格快照, 仅向基线追加风险。
 */
export function reevaluateObservations(db: DatabaseSync, observationIds: string[], trigger: string): number {
  let touched = 0;
  for (const id of observationIds) {
    const observation = get<ObservationRow>(db, "SELECT * FROM observations WHERE id = ?", id);
    if (!observation) continue;
    if (observation.status === "adopted") {
      const memberships = all<{ baseline_id: string }>(
        db,
        `SELECT bm.baseline_id FROM baseline_members bm JOIN baselines b ON b.id = bm.baseline_id
         WHERE bm.observation_id = ? AND b.signed_at IS NOT NULL`,
        id,
      );
      for (const membership of memberships) {
        db.prepare("INSERT INTO baseline_risks(baseline_id, observation_id, risk, detail) VALUES (?,?,?,?)").run(
          membership.baseline_id,
          id,
          trigger,
          "签署后仪器资格发生变化, 基线保留原资格快照",
        );
        addEvent(db, id, "risk_appended", `基线 ${membership.baseline_id} 追加风险: ${trigger}`);
        touched += 1;
      }
      continue;
    }
    if (observation.status !== "candidate" && observation.status !== "pending_review") continue;
    const evaluation = evaluateObservation(db, {
      instrumentId: observation.instrument_id,
      componentSetId: observation.component_set_id,
      observedAt: observation.observed_at,
      zone: observation.zone,
      requiredPrecision: observation.required_precision,
    });
    const reasonsJson = JSON.stringify(evaluation.reasons);
    if (evaluation.status !== observation.status || reasonsJson !== observation.decision_reasons) {
      db.prepare("UPDATE observations SET status = ?, decision_reasons = ? WHERE id = ?").run(evaluation.status, reasonsJson, id);
      touched += 1;
    }
    addEvent(
      db,
      id,
      "reevaluated",
      `${trigger} → ${evaluation.status}${evaluation.reasons.length > 0 ? ` (${evaluation.reasons.join(",")})` : ""}`,
    );
    if (evaluation.status === "pending_review") {
      ensureTask(db, `review:${id}`, "review", id, `观测 ${id} 待复核`);
    }
  }
  return touched;
}
