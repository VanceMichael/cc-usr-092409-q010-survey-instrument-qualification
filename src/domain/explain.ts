import { fail } from "../errors.js";
import type { Context } from "../runtime.js";
import type {
  CertificateRow,
  DeviceRow,
  DomainEventRow,
  DueTaskRow,
  LeaseRow,
  ObservationRow,
} from "./types.js";

const DECISION_LABEL: Record<string, string> = {
  adopted: "采用",
  downgraded: "降级",
  isolated: "隔离",
};

const REASON_LABEL: Record<string, string> = {
  packet_incomplete: "采集包不完整（缺摘要/序号/坐标）",
  unknown_device: "设备未登记",
  device_not_active: "设备当前不可用（维修中或已退役）",
  maintenance_locked: "观测时刻处于维修锁定区间",
  certificate_expired: "校准证书过期或未覆盖观测时刻",
  certificate_missing: "设备从未登记校准证书",
  certificate_revoked: "校准证书已撤销",
  accuracy_insufficient: "精度等级不满足观测要求",
  combination_mismatch: "组件组合不存在或已停用",
  component_mismatch: "实际组件与登记组合不匹配",
  no_lease: "没有覆盖全部设备的有效租约",
  lease_not_active: "观测时刻不在租约出借区间",
  lease_overdue: "租约逾期未还期间的观测",
  crew_mismatch: "观测班组与租约班组不一致（设备借给另一班组）",
  work_area_mismatch: "观测工作区越出租约工作区",
};

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * 解释一次观测为何采用、降级或隔离：
 * 冻结的资格快照与规则轨迹、设备保管人、校准依据、复核与后续处置。
 */
export function explainObservation(ctx: Context, id: string): Record<string, unknown> {
  const obs = ctx.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as
    | ObservationRow
    | undefined;
  if (!obs) throw fail.notFound("观测", id);

  const snapshot = parseJson<{
    devices?: Array<{ id: string; serialNumber: string; role: string; custodian: string; version: number }>;
    combination?: { id: string; code: string; version: number } | null;
    certificates?: Array<{ id: string; certificateNo: string; deviceId: string; version: number }>;
    lease?: { id: string; code: string; custodian: string | null; applicant: string; version: number } | null;
  }>(obs.qualification_snapshot, {});

  // 设备与保管人（当前登记信息 + 冻结版本对照）
  const devices = (snapshot.devices ?? []).map((entry) => {
    const current = ctx.db.prepare("SELECT * FROM devices WHERE id = ?").get(entry.id) as
      | DeviceRow
      | undefined;
    return {
      ...entry,
      current: current
        ? {
            serialNumber: current.serial_number,
            status: current.status,
            custodian: current.custodian,
            version: current.version,
            versionDrift: current.version !== entry.version,
          }
        : null,
    };
  });

  // 校准依据：冻结证书 + 当前状态
  const certificates = (snapshot.certificates ?? []).map((entry) => {
    const current = ctx.db
      .prepare("SELECT * FROM calibration_certificates WHERE id = ?")
      .get(entry.id) as CertificateRow | undefined;
    return {
      ...entry,
      current: current
        ? {
            certificateNo: current.certificate_no,
            status: current.status,
            validFrom: current.valid_from,
            validUntil: current.valid_until,
            revokedAt: current.revoked_at,
            revokeReason: current.revoke_reason,
            version: current.version,
            versionDrift: current.version !== entry.version,
          }
        : null,
    };
  });

  // 租约与保管人/领用人
  let lease: Record<string, unknown> | null = null;
  if (snapshot.lease) {
    const current = ctx.db.prepare("SELECT * FROM leases WHERE id = ?").get(snapshot.lease.id) as
      | LeaseRow
      | undefined;
    lease = {
      ...snapshot.lease,
      current: current
        ? {
            code: current.code,
            status: current.status,
            crew: current.crew,
            workArea: current.work_area,
            custodian: current.custodian,
            applicant: current.applicant,
            lentAt: current.lent_at,
            returnedAt: current.returned_at,
            overdue: current.overdue === 1,
            version: current.version,
            versionDrift: current.version !== snapshot.lease.version,
          }
        : null,
    };
  }

  // 后续处置：复核裁定、基线签署、风险、待办任务
  const baseline = obs.baseline_id
    ? (ctx.db.prepare("SELECT * FROM baselines WHERE id = ?").get(obs.baseline_id) as
        | { id: string; code: string; status: string; signed_at: string | null; signer: string | null }
        | undefined)
    : undefined;
  const risks = obs.baseline_id
    ? (ctx.db
        .prepare("SELECT * FROM baseline_risks WHERE baseline_id = ? AND observation_id = ?")
        .all(obs.baseline_id, obs.id) as Array<Record<string, unknown>>)
    : [];
  const tasks = ctx.db
    .prepare("SELECT * FROM due_tasks WHERE ref_id = ? AND type = 'review' ORDER BY created_at DESC LIMIT 5")
    .all(obs.id) as unknown as DueTaskRow[];
  const events = ctx.db
    .prepare(
      "SELECT * FROM domain_events WHERE subject_type = 'observation' AND subject_id = ? ORDER BY at, id",
    )
    .all(obs.id) as unknown as DomainEventRow[];

  const failures = parseJson<string[]>(obs.failure_reasons, []);
  return {
    observation: {
      id: obs.id,
      packetId: obs.packet_id,
      observedAt: obs.observed_at,
      crew: obs.crew,
      workArea: obs.work_area,
      requiredAccuracy: obs.required_accuracy,
      combinationId: obs.combination_id,
      summary: obs.summary,
      sequenceNo: obs.sequence_no,
      coordinates:
        obs.easting === null || obs.northing === null
          ? null
          : { easting: obs.easting, northing: obs.northing, elevation: obs.elevation },
      complete: obs.complete === 1,
      version: obs.version,
    },
    disposition: {
      status: obs.status,
      decision: obs.decision,
      label: DECISION_LABEL[obs.decision] ?? obs.decision,
      failureReasons: failures,
      failureLabels: failures.map((f) => REASON_LABEL[f] ?? f),
      adjudicated: obs.baseline_id !== null,
    },
    frozenAtImport: {
      qualificationSnapshot: snapshot,
      ruleTrace: parseJson(obs.rule_trace, null),
    },
    latestEvaluation: parseJson(obs.current_trace, null),
    lineage: {
      devices,
      combination: snapshot.combination ?? null,
      certificates,
      lease,
    },
    review: obs.review_disposition
      ? {
          disposition: obs.review_disposition,
          reviewedBy: obs.reviewed_by,
          reviewedAt: obs.reviewed_at,
          note: obs.review_note,
        }
      : null,
    followUp: {
      baseline: baseline
        ? {
            id: baseline.id,
            code: baseline.code,
            status: baseline.status,
            signedAt: baseline.signed_at,
            signer: baseline.signer,
          }
        : null,
      risks,
      pendingTasks: tasks
        .filter((t) => t.status === "pending" || t.status === "claimed")
        .map((t) => ({ id: t.id, type: t.type, dueAt: t.due_at, status: t.status })),
    },
    timeline: events.map((e) => ({
      at: e.at,
      type: e.type,
      detail: parseJson(e.detail, {}),
    })),
  };
}
