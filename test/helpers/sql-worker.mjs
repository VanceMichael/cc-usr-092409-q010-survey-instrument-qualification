import { workerData, parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

// 并发原语验证 worker：裸 SQL 模拟两个会话同时提交。
const { dbPath, action } = workerData;
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 8000;");
let result;
try {
  if (action.kind === "confirm-handoff") {
    const r = db
      .prepare(
        "UPDATE device_handoffs SET status='confirmed', confirmed_by=?, confirmed_at=? WHERE id=? AND status='pending'",
      )
      .run(action.by, new Date().toISOString(), action.id);
    result = { ok: Number(r.changes) === 1 };
  } else if (action.kind === "insert-lease") {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO leases (id, code, crew, work_area, purpose, starts_at, ends_at, status, applicant, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'requested',?,?,?)`,
      ).run(action.leaseId, action.code, "班组", "工作区", "用途", action.startsAt, action.endsAt, "tester", now, now);
      db.prepare("INSERT INTO lease_items (lease_id, device_id) VALUES (?,?)").run(action.leaseId, action.deviceId);
      db.exec("COMMIT");
      result = { ok: true };
    } catch (error) {
      db.exec("ROLLBACK");
      result = { ok: false, error: String(error) };
    }
  } else {
    result = { ok: false, error: "unknown action" };
  }
} catch (error) {
  result = { ok: false, error: String(error) };
}
parentPort.postMessage(result);
