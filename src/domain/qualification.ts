import { parseAccuracyMm, type Context } from "../runtime.js";
import type {
  CertificateRow,
  CombinationItemRow,
  CombinationRow,
  DeviceRow,
  LeaseRow,
} from "./types.js";

export interface QualifyDevice {
  deviceId: string;
  role: string;
}

export interface QualifyInput {
  observedAt: string;
  crew: string;
  workArea: string;
  requiredAccuracy: string | null;
  combinationId: string | null;
  devices: QualifyDevice[];
  /** import：检查设备当前状态；reevaluate：只应用可追溯事实（维修区间/证书撤销/租约区间）。 */
  mode: "import" | "reevaluate";
}

export interface RuleCheck {
  rule: string;
  ok: boolean;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface QualifyEvidence {
  devices: Array<{
    id: string;
    serialNumber: string;
    kind: string;
    role: string;
    status: string;
    custodian: string;
    accuracyClass: string;
    version: number;
  }>;
  combination: {
    id: string;
    code: string;
    accuracyClass: string;
    version: number;
  } | null;
  certificates: Array<{
    id: string;
    certificateNo: string;
    deviceId: string;
    validFrom: string;
    validUntil: string;
    accuracyClass: string;
    version: number;
  }>;
  lease: {
    id: string;
    code: string;
    crew: string;
    workArea: string;
    startsAt: string;
    endsAt: string;
    lentAt: string | null;
    returnedAt: string | null;
    custodian: string | null;
    applicant: string;
    version: number;
  } | null;
}

export interface QualifyResult {
  decision: "adopted" | "downgraded";
  failures: string[];
  checks: RuleCheck[];
  evidence: QualifyEvidence;
}

function leaseEvidence(lease: LeaseRow): NonNullable<QualifyEvidence["lease"]> {
  return {
    id: lease.id,
    code: lease.code,
    crew: lease.crew,
    workArea: lease.work_area,
    startsAt: lease.starts_at,
    endsAt: lease.ends_at,
    lentAt: lease.lent_at,
    returnedAt: lease.returned_at,
    custodian: lease.custodian,
    applicant: lease.applicant,
    version: lease.version,
  };
}

/**
 * 资格规则引擎：对一次观测在 observedAt 时刻的设备/证书/租约/组合资格求值。
 * 规则轨迹（checks）与证据（evidence）随观测冻结，供解释查询回放。
 */
export function qualify(ctx: Context, input: QualifyInput): QualifyResult {
  const t = input.observedAt;
  const checks: RuleCheck[] = [];
  const evidence: QualifyEvidence = { devices: [], combination: null, certificates: [], lease: null };
  const requiredMm = parseAccuracyMm(input.requiredAccuracy);
  const push = (rule: string, ok: boolean, reason: string | null, detail: Record<string, unknown> = {}) =>
    checks.push({ rule, ok, reason: ok ? null : reason, detail });

  // ---- 设备级规则 ----
  const devices: DeviceRow[] = [];
  for (const ref of input.devices) {
    const device = ctx.db.prepare("SELECT * FROM devices WHERE id = ?").get(ref.deviceId) as
      | DeviceRow
      | undefined;
    if (!device) {
      push("device_registered", false, "unknown_device", { deviceId: ref.deviceId, role: ref.role });
      continue;
    }
    devices.push(device);
    evidence.devices.push({
      id: device.id,
      serialNumber: device.serial_number,
      kind: device.kind,
      role: ref.role,
      status: device.status,
      custodian: device.custodian,
      accuracyClass: device.accuracy_class,
      version: device.version,
    });

    if (input.mode === "import") {
      push(
        "device_active",
        device.status === "active",
        "device_not_active",
        { serialNumber: device.serial_number, status: device.status },
      );
    }

    // 维修锁定区间 [opened_at, closed_at)：迟到结论/追溯开工单在重评时同样生效
    const lock = ctx.db
      .prepare(
        `SELECT id, opened_at, closed_at FROM maintenance_events
         WHERE device_id = ? AND opened_at <= ? AND (closed_at IS NULL OR ? < closed_at)
         ORDER BY opened_at LIMIT 1`,
      )
      .get(device.id, t, t) as { id: string } | undefined;
    push("maintenance_lock", !lock, "maintenance_locked", {
      serialNumber: device.serial_number,
      maintenanceId: lock?.id ?? null,
    });

    // 校准证书：观测时刻在有效期内，且未被撤销（撤销可追溯）
    if (device.calibration_required === 1) {
      const certs = ctx.db
        .prepare(
          `SELECT * FROM calibration_certificates
           WHERE device_id = ? AND valid_from <= ? AND ? <= valid_until
           ORDER BY valid_from DESC`,
        )
        .all(device.id, t, t) as unknown as CertificateRow[];
      const usable = certs.filter((c) => c.status !== "revoked");
      const cert = usable[0] ?? null;
      if (!cert) {
        let reason = "certificate_revoked";
        if (certs.length === 0) {
          const anyCert = ctx.db
            .prepare("SELECT 1 AS x FROM calibration_certificates WHERE device_id = ? LIMIT 1")
            .get(device.id);
          reason = anyCert ? "certificate_expired" : "certificate_missing";
        }
        push("certificate_valid", false, reason, {
          serialNumber: device.serial_number,
          revokedOnly: certs.length > 0,
        });
      } else {
        evidence.certificates.push({
          id: cert.id,
          certificateNo: cert.certificate_no,
          deviceId: cert.device_id,
          validFrom: cert.valid_from,
          validUntil: cert.valid_until,
          accuracyClass: cert.accuracy_class,
          version: cert.version,
        });
        push("certificate_valid", true, null, { certificateNo: cert.certificate_no });
        if (requiredMm !== null) {
          const certMm = parseAccuracyMm(cert.accuracy_class);
          push(
            "certificate_accuracy",
            certMm !== null && certMm <= requiredMm,
            "accuracy_insufficient",
            { certificateNo: cert.certificate_no, certificateAccuracy: cert.accuracy_class, required: input.requiredAccuracy },
          );
        }
      }
    }

    if (requiredMm !== null) {
      const deviceMm = parseAccuracyMm(device.accuracy_class);
      push(
        "device_accuracy",
        deviceMm !== null && deviceMm <= requiredMm,
        "accuracy_insufficient",
        { serialNumber: device.serial_number, deviceAccuracy: device.accuracy_class, required: input.requiredAccuracy },
      );
    }
  }

  // ---- 组件组合规则 ----
  if (input.combinationId) {
    const combo = ctx.db.prepare("SELECT * FROM combinations WHERE id = ?").get(input.combinationId) as
      | CombinationRow
      | undefined;
    if (!combo || combo.status !== "active") {
      push("combination_active", false, "combination_mismatch", {
        combinationId: input.combinationId,
        status: combo?.status ?? "missing",
      });
    } else {
      evidence.combination = {
        id: combo.id,
        code: combo.code,
        accuracyClass: combo.accuracy_class,
        version: combo.version,
      };
      push("combination_active", true, null, { code: combo.code });
      const items = ctx.db
        .prepare("SELECT * FROM combination_items WHERE combination_id = ?")
        .all(combo.id) as unknown as CombinationItemRow[];
      const expected = new Map(items.map((i) => [i.role, i.device_id]));
      const actual = new Map(input.devices.map((d) => [d.role, d.deviceId]));
      const mismatched =
        expected.size !== actual.size ||
        [...expected.entries()].some(([role, deviceId]) => actual.get(role) !== deviceId);
      push("combination_match", !mismatched, "component_mismatch", {
        code: combo.code,
        expected: Object.fromEntries(expected),
        actual: Object.fromEntries(actual),
      });
      if (requiredMm !== null) {
        const comboMm = parseAccuracyMm(combo.accuracy_class);
        push(
          "combination_accuracy",
          comboMm !== null && comboMm <= requiredMm,
          "accuracy_insufficient",
          { code: combo.code, combinationAccuracy: combo.accuracy_class, required: input.requiredAccuracy },
        );
      }
    }
  }

  // ---- 租约规则：同一租约须覆盖全部观测设备 ----
  if (devices.length > 0) {
    const placeholders = devices.map(() => "?").join(", ");
    const candidates = ctx.db
      .prepare(
        `SELECT l.* FROM leases l
         WHERE l.status IN ('lent','returned')
           AND (SELECT COUNT(DISTINCT li.device_id) FROM lease_items li
                 WHERE li.lease_id = l.id AND li.device_id IN (${placeholders})) = ?
         ORDER BY l.starts_at DESC`,
      )
      .all(...devices.map((d) => d.id), devices.length) as unknown as LeaseRow[];
    if (candidates.length === 0) {
      push("lease_covering", false, "no_lease", {
        devices: devices.map((d) => d.serial_number),
      });
    } else {
      const inWindow = candidates.filter(
        (l) => l.starts_at <= t && t < l.ends_at && l.lent_at !== null && l.lent_at <= t &&
          (l.returned_at === null || t < l.returned_at),
      );
      if (inWindow.length === 0) {
        const overdue = candidates.some(
          (l) => l.ends_at <= t && (l.returned_at === null || t < l.returned_at),
        );
        push("lease_window", false, overdue ? "lease_overdue" : "lease_not_active", {
          observedAt: t,
          leases: candidates.map((l) => ({ code: l.code, startsAt: l.starts_at, endsAt: l.ends_at, lentAt: l.lent_at, returnedAt: l.returned_at })),
        });
      } else {
        const exact = inWindow.find((l) => l.crew === input.crew && l.work_area === input.workArea);
        const lease = exact ?? inWindow[0];
        evidence.lease = leaseEvidence(lease);
        push("lease_window", true, null, { code: lease.code });
        push("lease_crew", lease.crew === input.crew, "crew_mismatch", {
          leaseCrew: lease.crew,
          observationCrew: input.crew,
          leaseCode: lease.code,
        });
        push("lease_area", lease.work_area === input.workArea, "work_area_mismatch", {
          leaseWorkArea: lease.work_area,
          observationWorkArea: input.workArea,
          leaseCode: lease.code,
        });
      }
    }
  }

  const failures = checks.filter((c) => !c.ok).map((c) => c.reason as string);
  return {
    decision: failures.length === 0 ? "adopted" : "downgraded",
    failures,
    checks,
    evidence,
  };
}
