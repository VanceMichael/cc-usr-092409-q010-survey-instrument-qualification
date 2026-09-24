import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { addEvent, all, buildQualificationSnapshot, get, nowIso, tx } from "../store.js";
import type { ObservationRow } from "../store.js";
import { badRequest } from "./helpers.js";
import type { Body } from "./helpers.js";

/** 基线签署: 冻结成员观测的资格快照; 签署后资格变化只追加风险, 不改判。 */
export function registerBaselineRoutes(app: FastifyInstance): void {
  app.post("/baselines", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    if (!body.name) return badRequest(reply, "缺少字段: name");
    const id = randomUUID();
    app.db.prepare("INSERT INTO baselines(id, name) VALUES (?,?)").run(id, body.name);
    return reply.code(201).send(get(app.db, "SELECT * FROM baselines WHERE id = ?", id));
  });

  app.post("/baselines/:id/sign", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Body;
    if (!body.signed_by || !Array.isArray(body.observation_ids) || body.observation_ids.length === 0) {
      return badRequest(reply, "需要 signed_by 与非空 observation_ids");
    }
    const baseline = get<{ id: string; signed_at: string | null }>(app.db, "SELECT * FROM baselines WHERE id = ?", id);
    if (!baseline) return reply.code(404).send({ error: "baseline_not_found" });
    if (baseline.signed_at) return reply.code(409).send({ error: "baseline_already_signed" });
    const rejection = tx(app.db, () => {
      const observationIds = body.observation_ids as string[];
      for (const observationId of observationIds) {
        const observation = get<ObservationRow>(app.db, "SELECT * FROM observations WHERE id = ?", observationId);
        if (!observation) return { error: "observation_not_found", observation_id: observationId };
        if (observation.status !== "candidate" && observation.status !== "adopted") {
          return { error: "observation_not_qualified", observation_id: observationId, status: observation.status };
        }
        const alreadySigned = get<{ ok: number }>(
          app.db,
          `SELECT 1 AS ok FROM baseline_members bm JOIN baselines b ON b.id = bm.baseline_id
           WHERE bm.observation_id = ? AND b.signed_at IS NOT NULL`,
          observationId,
        );
        if (alreadySigned) return { error: "observation_already_signed", observation_id: observationId };
      }
      const signedAt = nowIso();
      for (const observationId of observationIds) {
        const observation = get<ObservationRow>(app.db, "SELECT * FROM observations WHERE id = ?", observationId);
        if (!observation) continue;
        const snapshot = buildQualificationSnapshot(app.db, observation);
        app.db
          .prepare("INSERT INTO baseline_members(baseline_id, observation_id, qualification_snapshot) VALUES (?,?,?)")
          .run(id, observationId, JSON.stringify(snapshot));
        app.db
          .prepare("UPDATE observations SET status = 'adopted', adjudicated_at = ?, adjudicated_by = ? WHERE id = ?")
          .run(signedAt, body.signed_by, observationId);
        addEvent(app.db, observationId, "signed_into_baseline", `基线 ${id} 由 ${body.signed_by} 签署`);
      }
      app.db.prepare("UPDATE baselines SET signed_at = ?, signed_by = ? WHERE id = ?").run(signedAt, body.signed_by, id);
      return null;
    });
    if (rejection) return reply.code(409).send(rejection);
    return { baseline_id: id, signed: (body.observation_ids as string[]).length };
  });

  app.get("/baselines/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const baseline = get<Record<string, unknown>>(app.db, "SELECT * FROM baselines WHERE id = ?", id);
    if (!baseline) return reply.code(404).send({ error: "baseline_not_found" });
    const members = all(
      app.db,
      `SELECT bm.observation_id, bm.qualification_snapshot, o.status FROM baseline_members bm
       JOIN observations o ON o.id = bm.observation_id WHERE bm.baseline_id = ?`,
      id,
    );
    const risks = all(
      app.db,
      "SELECT observation_id, risk, detail, created_at FROM baseline_risks WHERE baseline_id = ? ORDER BY id",
      id,
    );
    return { ...baseline, members, risks };
  });
}
