import { fail } from "../errors.js";
import { transaction, type Context } from "../runtime.js";
import { cancelDueTasks, recordEvent } from "./events.js";
import type { BaselineRiskRow, BaselineRow, ObservationRow } from "./types.js";

export interface CreateBaselineInput {
  code: string;
  name?: string;
  componentMapping?: Record<string, unknown>;
}

export function createBaseline(ctx: Context, input: CreateBaselineInput): BaselineRow {
  if (!input.code?.trim()) throw fail.validation("code 必填");
  const now = ctx.now();
  const id = ctx.newId("bln");
  ctx.db
    .prepare(
      `INSERT INTO baselines (id, code, name, component_mapping, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(id, input.code.trim(), input.name ?? null, JSON.stringify(input.componentMapping ?? {}), now, now);
  recordEvent(ctx, "baseline.created", "baseline", id, { code: input.code.trim() });
  return getBaseline(ctx, id);
}

export function getBaseline(ctx: Context, id: string): BaselineRow {
  const row = ctx.db.prepare("SELECT * FROM baselines WHERE id = ?").get(id) as BaselineRow | undefined;
  if (!row) throw fail.notFound("基线", id);
  return row;
}

export function listBaselines(ctx: Context): BaselineRow[] {
  return ctx.db.prepare("SELECT * FROM baselines ORDER BY created_at, id").all() as unknown as BaselineRow[];
}

/**
 * 签署基线：把候选观测裁定进基线版本，构件对应关系随版本发布。
 * 签署后观测的资格快照冻结（复制进 baseline_items），之后的
 * 证书撤销/维修结论迟到只追加风险，不再改动快照。
 */
export function signBaseline(
  ctx: Context,
  id: string,
  signer: string,
  observationIds?: string[],
): BaselineRow {
  if (!signer?.trim()) throw fail.validation("signer 必填");
  const now = ctx.now();
  return transaction(ctx.db, () => {
    const baseline = getBaseline(ctx, id);
    if (baseline.status !== "draft") throw fail.illegal("基线已签署", { id });
    let observations: ObservationRow[];
    if (observationIds && observationIds.length > 0) {
      observations = observationIds.map((obsId) => {
        const row = ctx.db.prepare("SELECT * FROM observations WHERE id = ?").get(obsId) as
          | ObservationRow
          | undefined;
        if (!row) throw fail.notFound("观测", obsId);
        return row;
      });
    } else {
      observations = ctx.db
        .prepare("SELECT * FROM observations WHERE status = 'candidate' AND baseline_id IS NULL ORDER BY observed_at")
        .all() as unknown as ObservationRow[];
    }
    if (observations.length === 0) throw fail.validation("没有可签署的候选观测");
    for (const obs of observations) {
      if (obs.status !== "candidate" || obs.baseline_id !== null) {
        throw fail.illegal("只有未签署的候选观测才能进入基线", {
          observationId: obs.id,
          status: obs.status,
          baselineId: obs.baseline_id,
        });
      }
    }
    for (const obs of observations) {
      ctx.db
        .prepare(
          "INSERT INTO baseline_items (baseline_id, observation_id, snapshot) VALUES (?, ?, ?)",
        )
        .run(id, obs.id, obs.qualification_snapshot ?? "null");
      ctx.db
        .prepare(
          "UPDATE observations SET baseline_id = ?, signed_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(id, now, now, obs.id);
      cancelDueTasks(ctx, "review", obs.id);
    }
    ctx.db
      .prepare("UPDATE baselines SET status = 'signed', signed_at = ?, signer = ?, updated_at = ? WHERE id = ?")
      .run(now, signer.trim(), now, id);
    recordEvent(ctx, "baseline.signed", "baseline", id, {
      signer: signer.trim(),
      observations: observations.map((o) => o.id),
    });
    return getBaseline(ctx, id);
  });
}

export function listBaselineItems(ctx: Context, baselineId: string): Array<Record<string, unknown>> {
  return ctx.db
    .prepare(
      `SELECT bi.observation_id, bi.snapshot, o.packet_id, o.observed_at, o.crew, o.work_area
       FROM baseline_items bi JOIN observations o ON o.id = bi.observation_id
       WHERE bi.baseline_id = ? ORDER BY o.observed_at`,
    )
    .all(baselineId) as Array<Record<string, unknown>>;
}

export function listBaselineRisks(ctx: Context, baselineId: string): BaselineRiskRow[] {
  return ctx.db
    .prepare("SELECT * FROM baseline_risks WHERE baseline_id = ? ORDER BY created_at, id")
    .all(baselineId) as unknown as BaselineRiskRow[];
}

export function acknowledgeRisk(ctx: Context, riskId: string, acknowledgedBy: string): BaselineRiskRow {
  if (!acknowledgedBy?.trim()) throw fail.validation("acknowledgedBy 必填");
  const now = ctx.now();
  const row = ctx.db.prepare("SELECT * FROM baseline_risks WHERE id = ?").get(riskId) as
    | BaselineRiskRow
    | undefined;
  if (!row) throw fail.notFound("基线风险", riskId);
  ctx.db.prepare("UPDATE baseline_risks SET acknowledged = 1 WHERE id = ?").run(riskId);
  recordEvent(ctx, "baseline.risk_acknowledged", "baseline", row.baseline_id, {
    riskId,
    acknowledgedBy: acknowledgedBy.trim(),
    at: now,
  });
  return ctx.db.prepare("SELECT * FROM baseline_risks WHERE id = ?").get(riskId) as unknown as BaselineRiskRow;
}
