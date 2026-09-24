import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { get, isUniqueViolation } from "../store.js";
import type { InstrumentRow } from "../store.js";
import { badRequest, missingFields } from "./helpers.js";
import type { Body } from "./helpers.js";

/** 离线交接: 按设备流水归位; 封签唯一约束保证同一封签并发确认只有一次成功。 */
export function registerHandoverRoutes(app: FastifyInstance): void {
  app.post("/handovers/confirm", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const missing = missingFields(body, ["seal_no", "instrument_id", "confirmed_by"]);
    if (missing.length > 0) return badRequest(reply, `缺少字段: ${missing.join(", ")}`);
    const instrument = get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", body.instrument_id);
    if (!instrument) return reply.code(404).send({ error: "instrument_not_found" });
    const id = randomUUID();
    try {
      app.db
        .prepare("INSERT INTO handovers(id, seal_no, instrument_id, confirmed_by, ledger_note) VALUES (?,?,?,?,?)")
        .run(id, body.seal_no, instrument.id, body.confirmed_by, body.ledger_note ?? "");
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: "seal_already_confirmed", seal_no: body.seal_no });
      throw error;
    }
    return reply.code(201).send(get(app.db, "SELECT * FROM handovers WHERE id = ?", id));
  });

  app.get("/handovers/:sealNo", async (request, reply) => {
    const { sealNo } = request.params as { sealNo: string };
    const handover = get(app.db, "SELECT * FROM handovers WHERE seal_no = ?", sealNo);
    if (!handover) return reply.code(404).send({ error: "handover_not_found" });
    return handover;
  });
}
