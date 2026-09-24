import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { evaluateObservation } from "../evaluation.js";
import { addEvent, all, buildQualificationSnapshot, completeTask, ensureTask, get, nowIso, toIso, tx } from "../store.js";
import type { InstrumentRow, ObservationRow } from "../store.js";
import { badRequest, missingFields } from "./helpers.js";
import type { Body } from "./helpers.js";

const DECISION_LABELS: Record<string, string> = {
  candidate: "候选解",
  pending_review: "待复核",
  adopted: "采用",
  downgraded: "降级",
  quarantined: "隔离",
};

export function registerObservationRoutes(app: FastifyInstance): void {
  // 观测导入: 冻结设备、证书与租约版本; 合格进候选解, 问题数据进待复核而不删除
  app.post("/observations/import", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const missing = missingFields(body, ["observed_at", "zone", "required_precision", "payload"]);
    if (!body.instrument_id && !body.instrument_serial) missing.push("instrument_id|instrument_serial");
    if (missing.length > 0) return badRequest(reply, `缺少字段: ${missing.join(", ")}`);
    const instrument = body.instrument_id
      ? get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE id = ?", body.instrument_id)
      : get<InstrumentRow>(app.db, "SELECT * FROM instruments WHERE serial_no = ?", body.instrument_serial);
    if (!instrument) return reply.code(404).send({ error: "instrument_not_found" });
    const observedAt = toIso(body.observed_at);
    if (!observedAt) return badRequest(reply, "observed_at 不合法");
    const payload = typeof body.payload === "string" ? body.payload : JSON.stringify(body.payload);
    const created = tx(app.db, () => {
      const evaluation = evaluateObservation(app.db, {
        instrumentId: instrument.id,
        componentSetId: body.component_set_id ?? null,
        observedAt,
        zone: body.zone,
        requiredPrecision: body.required_precision,
      });
      const id = randomUUID();
      app.db
        .prepare(
          `INSERT INTO observations(id, instrument_id, component_set_id, observed_at, zone, required_precision, payload,
             status, decision_reasons, instrument_version, certificate_id, certificate_version, lease_id, lease_version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          instrument.id,
          body.component_set_id ?? null,
          observedAt,
          body.zone,
          body.required_precision,
          payload,
          evaluation.status,
          JSON.stringify(evaluation.reasons),
          instrument.version,
          evaluation.certificate?.id ?? null,
          evaluation.certificate?.version ?? null,
          evaluation.lease?.id ?? null,
          evaluation.lease?.version ?? null,
        );
      addEvent(
        app.db,
        id,
        "imported",
        `导入冻结 设备v${instrument.version}` +
          (evaluation.certificate ? ` 证书${evaluation.certificate.cert_no}v${evaluation.certificate.version}` : " 无证书") +
          (evaluation.lease ? ` 租约${evaluation.lease.id}v${evaluation.lease.version}` : " 无租约") +
          (evaluation.reasons.length > 0 ? ` 原因:${evaluation.reasons.join(",")}` : " 资格合格"),
      );
      if (evaluation.status === "pending_review") {
        ensureTask(app.db, `review:${id}`, "review", id, `观测 ${id} 待复核`);
      }
      return { id, evaluation };
    });
    return reply.code(201).send({
      id: created.id,
      status: created.evaluation.status,
      reasons: created.evaluation.reasons,
      certificate_id: created.evaluation.certificate?.id ?? null,
      lease_id: created.evaluation.lease?.id ?? null,
    });
  });

  app.get("/observations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const observation = get<ObservationRow>(app.db, "SELECT * FROM observations WHERE id = ?", id);
    if (!observation) return reply.code(404).send({ error: "observation_not_found" });
    return observation;
  });

  // 复核裁定: 采用 / 降级 / 隔离; 已裁定的观测不再变更
  app.post("/observations/:id/adjudicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Body;
    if (!["adopted", "downgraded", "quarantined"].includes(body.decision)) {
      return badRequest(reply, "decision 必须是 adopted|downgraded|quarantined");
    }
    if (!body.reviewer) return badRequest(reply, "缺少字段: reviewer");
    const observation = get<ObservationRow>(app.db, "SELECT * FROM observations WHERE id = ?", id);
    if (!observation) return reply.code(404).send({ error: "observation_not_found" });
    if (observation.status !== "candidate" && observation.status !== "pending_review") {
      return reply.code(409).send({ error: "already_adjudicated", status: observation.status });
    }
    tx(app.db, () => {
      app.db
        .prepare("UPDATE observations SET status = ?, adjudicated_at = ?, adjudicated_by = ? WHERE id = ?")
        .run(body.decision, nowIso(), body.reviewer, id);
      addEvent(app.db, id, `adjudicated:${body.decision}`, body.note ?? "");
      completeTask(app.db, `review:${id}`, nowIso());
    });
    return get(app.db, "SELECT * FROM observations WHERE id = ?", id);
  });

  // 解释一次观测为何采用、降级或隔离, 并追到保管人、校准依据与后续处置
  app.get("/observations/:id/explanation", async (request, reply) => {
    const { id } = request.params as { id: string };
    const observation = get<ObservationRow>(app.db, "SELECT * FROM observations WHERE id = ?", id);
    if (!observation) return reply.code(404).send({ error: "observation_not_found" });
    const snapshot = buildQualificationSnapshot(app.db, observation);
    const events = all(app.db, "SELECT event, detail, created_at FROM observation_events WHERE observation_id = ? ORDER BY id", id);
    const memberships = all<{ baseline_id: string; name: string; signed_at: string | null; signed_by: string | null }>(
      app.db,
      `SELECT bm.baseline_id, b.name, b.signed_at, b.signed_by FROM baseline_members bm
       JOIN baselines b ON b.id = bm.baseline_id WHERE bm.observation_id = ?`,
      id,
    );
    const baselines = memberships.map((membership) => ({
      ...membership,
      risks: all(
        app.db,
        "SELECT risk, detail, created_at FROM baseline_risks WHERE baseline_id = ? AND observation_id = ? ORDER BY id",
        membership.baseline_id,
        id,
      ),
    }));
    const tasks = all(
      app.db,
      "SELECT id, type, status, detail, created_at, done_at FROM tasks WHERE ref_id = ? ORDER BY created_at",
      id,
    );
    return {
      observation_id: observation.id,
      status: observation.status,
      decision: DECISION_LABELS[observation.status] ?? observation.status,
      decision_reasons: JSON.parse(observation.decision_reasons),
      custodian: snapshot.instrument?.custodian ?? null,
      calibration_basis: snapshot.certificate
        ? `${snapshot.certificate.cert_no}(${snapshot.certificate.precision_class}, ${snapshot.certificate.valid_from}~${snapshot.certificate.valid_until})`
        : null,
      qualification_snapshot: snapshot,
      adjudication: { adjudicated_by: observation.adjudicated_by, adjudicated_at: observation.adjudicated_at },
      events,
      baselines,
      disposition_tasks: tasks,
      observed_at: observation.observed_at,
      zone: observation.zone,
      imported_at: observation.imported_at,
    };
  });
}
