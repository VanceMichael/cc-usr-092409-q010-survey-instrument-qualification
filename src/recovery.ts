import type { DatabaseSync } from "node:sqlite";
import { reevaluateObservations } from "./evaluation.js";
import { all, ensureTask, nowIso, tx } from "./store.js";

export interface RecoverySummary {
  ran_at: string;
  leases_marked_overdue: number;
  certificates_expired: number;
  review_tasks_open: number;
}

/**
 * 停服恢复: 启动时以持久化状态为准, 幂等地继续三类工作——
 * 逾期未归还的租约、已到期的校准证书(并重评受影响观测)、待复核观测的复核任务。
 */
export function recoverPendingWork(db: DatabaseSync, now = nowIso()): RecoverySummary {
  return tx(db, () => {
    const summary: RecoverySummary = {
      ran_at: now,
      leases_marked_overdue: 0,
      certificates_expired: 0,
      review_tasks_open: 0,
    };

    const overdueLeases = all<{ id: string }>(db, "SELECT id FROM leases WHERE state = 'lent' AND window_end < ?", now);
    for (const lease of overdueLeases) {
      db.prepare("UPDATE leases SET state = 'overdue', version = version + 1 WHERE id = ?").run(lease.id);
      ensureTask(db, `overdue:${lease.id}`, "overdue_return", lease.id, `租约 ${lease.id} 超过归还期限仍未归还`);
      summary.leases_marked_overdue += 1;
    }

    const expiredCertificates = all<{ id: string; cert_no: string }>(
      db,
      "SELECT id, cert_no FROM certificates WHERE status = 'valid' AND valid_until < ?",
      now,
    );
    for (const certificate of expiredCertificates) {
      db.prepare("UPDATE certificates SET status = 'expired', version = version + 1 WHERE id = ?").run(certificate.id);
      ensureTask(db, `certexp:${certificate.id}`, "cert_expiry", certificate.id, `校准证书 ${certificate.cert_no} 已到期`);
      const affected = all<{ id: string }>(db, "SELECT id FROM observations WHERE certificate_id = ?", certificate.id);
      reevaluateObservations(
        db,
        affected.map((row) => row.id),
        `certificate_expired:${certificate.cert_no}`,
      );
      summary.certificates_expired += 1;
    }

    const pendingReview = all<{ id: string }>(db, "SELECT id FROM observations WHERE status = 'pending_review'");
    for (const row of pendingReview) {
      ensureTask(db, `review:${row.id}`, "review", row.id, `观测 ${row.id} 待复核`);
      summary.review_tasks_open += 1;
    }

    return summary;
  });
}
