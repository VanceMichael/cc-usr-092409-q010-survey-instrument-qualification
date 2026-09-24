import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { reevaluateObservations } from "../evaluation.js";
import { all, get, isUniqueViolation, nowIso, toIso, tx } from "../store.js";
import type { CertificateRow, InstrumentRow } from "../store.js";
import { badRequest, missingFields } from "./helpers.js";
import type { Body } from "./helpers.js";

/** 设备登记: 序列号、组件组合、校准证书、维修状态。 */
export function registerRegistryRoutes(app: FastifyInstance): void {
  app.post("/instruments", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const missing = missingFields(body, ["serial_no", "kind", "custodian"]);
    if (missing.length > 0) return badRequest(reply, `缺少字段: ${missing.join(", ")}`);
    const id = randomUUID();
    try {
      app.db
        .prepare("INSERT INTO instruments(id, serial_no, kind, custodian) VALUES (?,?,?,?)")
        .run(id, body.serial_no, body.kind, body.custodian);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "instrument_exists", serial_no: body.serial_no });
      throw error;
    }
    return reply.code(201).send(get(app.db, "SELECT * FROM instruments WHERE id = ?", id));
  });

  app.get("/instruments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const instrument = get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", id);
    if (!instrument) return reply.code(404).send({ error: "instrument_not_found" });
    return {
      ...instrument,
      certificates: all(app.db, "SELECT * FROM certificates WHERE instrument_id = ? ORDER BY valid_until DESC", id),
      maintenance_records: all(app.db, "SELECT * FROM maintenance_records WHERE instrument_id = ? ORDER BY opened_at DESC", id),
      leases: all(app.db, "SELECT * FROM leases WHERE instrument_id = ? ORDER BY window_start DESC", id),
    };
  });

  app.post("/component-sets", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    if (!body.name || !Array.isArray(body.members) || body.members.length === 0) {
      return badRequest(reply, "需要 name 与非空 members(设备序列号数组)");
    }
    const instruments = (body.members as string[]).map((serial) =>
      get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE serial_no = ?", serial),
    );
    const missingIndex = instruments.findIndex((instrument) => !instrument);
    if (missingIndex >= 0) {
      return reply.code(404).send({ error: "instrument_not_found", serial_no: (body.members as string[])[missingIndex] });
    }
    const id = randomUUID();
    try {
      tx(app.db, () => {
        app.db.prepare("INSERT INTO component_sets(id, name) VALUES (?,?)").run(id, body.name);
        for (const instrument of instruments as InstrumentRow[]) {
          app.db.prepare("INSERT INTO component_set_members(set_id, instrument_id) VALUES (?,?)").run(id, instrument.id);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "component_set_exists", name: body.name });
      throw error;
    }
    return reply.code(201).send({ id, name: body.name, members: body.members });
  });

  app.post("/certificates", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const missing = missingFields(body, ["instrument_id", "cert_no", "precision_class", "valid_from", "valid_until"]);
    if (missing.length > 0) return badRequest(reply, `缺少字段: ${missing.join(", ")}`);
    const instrument = get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", body.instrument_id);
    if (!instrument) return reply.code(404).send({ error: "instrument_not_found" });
    const validFrom = toIso(body.valid_from);
    const validUntil = toIso(body.valid_until);
    if (!validFrom || !validUntil || validFrom >= validUntil) return badRequest(reply, "证书有效期不合法");
    const id = randomUUID();
    try {
      app.db
        .prepare("INSERT INTO certificates(id, cert_no, instrument_id, precision_class, valid_from, valid_until) VALUES (?,?,?,?,?,?)")
        .run(id, body.cert_no, instrument.id, body.precision_class, validFrom, validUntil);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "certificate_exists", cert_no: body.cert_no });
      throw error;
    }
    return reply.code(201).send(get(app.db, "SELECT * FROM certificates WHERE id = ?", id));
  });

  // 证书撤销: 只重评尚未裁定的观测; 已签署基线保留快照并追加风险
  app.post("/certificates/:id/revoke", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Body;
    const certificate = get<CertificateRow>(app.db, "SELECT * FROM certificates WHERE id = ?", id);
    if (!certificate) return reply.code(404).send({ error: "certificate_not_found" });
    if (certificate.status === "revoked") return reply.code(409).send({ error: "certificate_already_revoked" });
    const reevaluated = tx(app.db, () => {
      app.db
        .prepare("UPDATE certificates SET status = 'revoked', revoked_reason = ?, version = version + 1 WHERE id = ?")
        .run(body.reason ?? "", id);
      const affected = all<{ id: string }>(app.db, "SELECT id FROM observations WHERE certificate_id = ?", id);
      return reevaluateObservations(
        app.db,
        affected.map((row) => row.id),
        `certificate_revoked:${certificate.cert_no}`,
      );
    });
    return { revoked: true, certificate_id: id, observations_reevaluated: reevaluated };
  });

  app.post("/maintenance", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const missing = missingFields(body, ["instrument_id", "opened_at"]);
    if (missing.length > 0) return badRequest(reply, `缺少字段: ${missing.join(", ")}`);
    const instrument = get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", body.instrument_id);
    if (!instrument) return reply.code(404).send({ error: "instrument_not_found" });
    const openedAt = toIso(body.opened_at);
    if (!openedAt) return badRequest(reply, "opened_at 不合法");
    const id = randomUUID();
    tx(app.db, () => {
      app.db
        .prepare("INSERT INTO maintenance_records(id, instrument_id, opened_at, note) VALUES (?,?,?,?)")
        .run(id, instrument.id, openedAt, body.note ?? "");
      app.db.prepare("UPDATE instruments SET status = 'maintenance', version = version + 1 WHERE id = ?").run(instrument.id);
    });
    return reply.code(201).send(get(app.db, "SELECT * FROM maintenance_records WHERE id = ?", id));
  });

  // 维修结论可能迟到: 关闭时只重评维修窗口内尚未裁定的观测
  app.post("/maintenance/:id/close", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Body;
    const record = get<{ id: string; instrument_id: string; opened_at: string; closed_at: string | null }>(
      app.db,
      "SELECT * FROM maintenance_records WHERE id = ?",
      id,
    );
    if (!record) return reply.code(404).send({ error: "maintenance_not_found" });
    if (record.closed_at) return reply.code(409).send({ error: "maintenance_already_closed" });
    const closedAt = toIso(body.closed_at) ?? nowIso();
    const conclusionOk = body.conclusion_ok === true ? 1 : 0;
    const reevaluated = tx(app.db, () => {
      app.db
        .prepare("UPDATE maintenance_records SET closed_at = ?, conclusion = ?, conclusion_ok = ? WHERE id = ?")
        .run(closedAt, body.conclusion ?? "", conclusionOk, id);
      app.db.prepare("UPDATE instruments SET status = 'available', version = version + 1 WHERE id = ?").run(record.instrument_id);
      const affected = all<{ id: string }>(
        app.db,
        "SELECT id FROM observations WHERE instrument_id = ? AND observed_at >= ? AND observed_at <= ?",
        record.instrument_id,
        record.opened_at,
        closedAt,
      );
      return reevaluateObservations(
        app.db,
        affected.map((row) => row.id),
        `maintenance_concluded:${id}`,
      );
    });
    return { closed: true, maintenance_id: id, observations_reevaluated: reevaluated };
  });
}
