import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { all, completeTask, get, nowIso, toIso, tx } from "../store.js";
import type { InstrumentRow, LeaseRow } from "../store.js";
import { badRequest, missingFields } from "./helpers.js";
import type { Body } from "./helpers.js";

/** 借用链: 申请绑定班组/工作区/时间窗/用途, 保管人确认出借, 领用人确认归还, 重叠租约原子拒绝。 */
export function registerLeaseRoutes(app: FastifyInstance): void {
  app.post("/leases", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const missing = missingFields(body, ["instrument_id", "crew", "borrower", "zone", "purpose", "window_start", "window_end"]);
    if (missing.length > 0) return badRequest(reply, `缺少字段: ${missing.join(", ")}`);
    const instrument = get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", body.instrument_id);
    if (!instrument) return reply.code(404).send({ error: "instrument_not_found" });
    const windowStart = toIso(body.window_start);
    const windowEnd = toIso(body.window_end);
    if (!windowStart || !windowEnd || windowStart >= windowEnd) return badRequest(reply, "借用时间窗不合法");
    const id = randomUUID();
    // 检查与写入在同一事务: 重叠租约原子拒绝
    const conflict = tx(app.db, () => {
      const overlap = get<{ id: string }>(
        app.db,
        `SELECT id FROM leases
         WHERE instrument_id = ? AND state IN ('requested','lent','overdue')
           AND window_start < ? AND window_end > ?
         LIMIT 1`,
        instrument.id,
        windowEnd,
        windowStart,
      );
      if (overlap) return overlap.id;
      app.db
        .prepare(
          `INSERT INTO leases(id, instrument_id, crew, borrower, zone, purpose, window_start, window_end)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(id, instrument.id, body.crew, body.borrower, body.zone, body.purpose, windowStart, windowEnd);
      return null;
    });
    if (conflict) return reply.code(409).send({ error: "lease_overlap", conflicting_lease_id: conflict });
    return reply.code(201).send(get(app.db, "SELECT * FROM leases WHERE id = ?", id));
  });

  app.get("/leases", async (request) => {
    const query = request.query as { instrument_id?: string; state?: string };
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.instrument_id) {
      clauses.push("instrument_id = ?");
      params.push(query.instrument_id);
    }
    if (query.state) {
      clauses.push("state = ?");
      params.push(query.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return all(app.db, `SELECT * FROM leases ${where} ORDER BY window_start DESC`, ...params);
  });

  // 出借由保管人确认
  app.post("/leases/:id/confirm-lend", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Body;
    if (!body.confirmed_by) return badRequest(reply, "缺少字段: confirmed_by");
    const lease = get<LeaseRow>(app.db, "SELECT * FROM leases WHERE id = ?", id);
    if (!lease) return reply.code(404).send({ error: "lease_not_found" });
    if (lease.state !== "requested") return reply.code(409).send({ error: "lease_not_requested", state: lease.state });
    const instrument = get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", lease.instrument_id);
    if (!instrument || instrument.custodian !== body.confirmed_by) {
      return reply.code(403).send({ error: "custodian_required", custodian: instrument?.custodian ?? null });
    }
    app.db
      .prepare("UPDATE leases SET state = 'lent', lent_confirmed_by = ?, lent_at = ?, version = version + 1 WHERE id = ?")
      .run(body.confirmed_by, nowIso(), id);
    return get(app.db, "SELECT * FROM leases WHERE id = ?", id);
  });

  // 归还由领用人确认; 逾期租约允许归还并结清逾期任务
  app.post("/leases/:id/confirm-return", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Body;
    if (!body.confirmed_by) return badRequest(reply, "缺少字段: confirmed_by");
    const lease = get<LeaseRow>(app.db, "SELECT * FROM leases WHERE id = ?", id);
    if (!lease) return reply.code(404).send({ error: "lease_not_found" });
    if (lease.state !== "lent" && lease.state !== "overdue") {
      return reply.code(409).send({ error: "lease_not_lent", state: lease.state });
    }
    if (lease.borrower !== body.confirmed_by) {
      return reply.code(403).send({ error: "borrower_required", borrower: lease.borrower });
    }
    const returnedAt = toIso(body.returned_at) ?? nowIso();
    tx(app.db, () => {
      app.db
        .prepare("UPDATE leases SET state = 'returned', returned_confirmed_by = ?, returned_at = ?, version = version + 1 WHERE id = ?")
        .run(body.confirmed_by, returnedAt, id);
      completeTask(app.db, `overdue:${id}`, returnedAt);
    });
    return get(app.db, "SELECT * FROM leases WHERE id = ?", id);
  });
}
