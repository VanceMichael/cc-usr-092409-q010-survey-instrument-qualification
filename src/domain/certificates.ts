import { fail } from "../errors.js";
import { parseIso, requireAccuracy, transaction, type Context } from "../runtime.js";
import { enqueueDueTask, recordEvent } from "./events.js";
import { getDevice } from "./devices.js";
import { reevaluateAfterCertificateRevoked } from "./reevaluate.js";
import type { CertificateRow } from "./types.js";

export interface IssueCertificateInput {
  certificateNo: string;
  deviceId?: string;
  serialNumber?: string;
  issuedAt: string;
  validFrom: string;
  validUntil: string;
  accuracyClass: string;
}

export function issueCertificate(ctx: Context, input: IssueCertificateInput): CertificateRow {
  const accuracy = requireAccuracy(input.accuracyClass, "accuracyClass");
  const issuedAt = parseIso(input.issuedAt, "issuedAt");
  const validFrom = parseIso(input.validFrom, "validFrom");
  const validUntil = parseIso(input.validUntil, "validUntil");
  if (validUntil <= validFrom) throw fail.validation("validUntil 必须晚于 validFrom");
  if (!input.certificateNo?.trim()) throw fail.validation("certificateNo 必填");
  const device = input.deviceId
    ? getDevice(ctx, input.deviceId)
    : input.serialNumber
      ? (() => {
          const row = ctx.db
            .prepare("SELECT * FROM devices WHERE serial_number = ?")
            .get(input.serialNumber) as { id: string } | undefined;
          if (!row) throw fail.notFound("设备(序列号)", String(input.serialNumber));
          return getDevice(ctx, row.id);
        })()
      : (() => {
          throw fail.validation("必须给出 deviceId 或 serialNumber");
        })();
  const now = ctx.now();
  const id = ctx.newId("crt");
  return transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO calibration_certificates
           (id, certificate_no, device_id, issued_at, valid_from, valid_until, accuracy_class, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)`,
      )
      .run(id, input.certificateNo.trim(), device.id, issuedAt, validFrom, validUntil, accuracy, now, now);
    recordEvent(ctx, "certificate.issued", "certificate", id, {
      deviceId: device.id,
      validFrom,
      validUntil,
    });
    // 证书到期任务：停服恢复后继续到期处理
    enqueueDueTask(ctx, "certificate_expiry", "certificate", id, validUntil, {
      deviceId: device.id,
    });
    return getCertificate(ctx, id);
  });
}

export function getCertificate(ctx: Context, id: string): CertificateRow {
  const row = ctx.db
    .prepare("SELECT * FROM calibration_certificates WHERE id = ?")
    .get(id) as CertificateRow | undefined;
  if (!row) throw fail.notFound("校准证书", id);
  return row;
}

export function listCertificates(ctx: Context, deviceId?: string): CertificateRow[] {
  if (deviceId) {
    return ctx.db
      .prepare("SELECT * FROM calibration_certificates WHERE device_id = ? ORDER BY valid_from")
      .all(deviceId) as unknown as CertificateRow[];
  }
  return ctx.db
    .prepare("SELECT * FROM calibration_certificates ORDER BY created_at, id")
    .all() as unknown as CertificateRow[];
}

export interface RevokeResult {
  certificate: CertificateRow;
  reevaluated: number;
  risksAppended: number;
}

/** 撤销证书：只重评尚未签署进基线的观测；已签署基线保留快照并追加风险。 */
export function revokeCertificate(ctx: Context, id: string, reason: string): RevokeResult {
  if (!reason?.trim()) throw fail.validation("撤销原因必填");
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const cert = getCertificate(ctx, id);
    if (cert.status === "revoked") throw fail.illegal("证书已撤销", { id });
    ctx.db
      .prepare(
        `UPDATE calibration_certificates
         SET status = 'revoked', revoked_at = ?, revoke_reason = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, reason.trim(), now, id);
    recordEvent(ctx, "certificate.revoked", "certificate", id, {
      deviceId: cert.device_id,
      reason: reason.trim(),
    });
    const outcome = reevaluateAfterCertificateRevoked(ctx, id);
    return { certificate: getCertificate(ctx, id), ...outcome };
  });
}
