import assert from "node:assert/strict";
import test from "node:test";

import { createBaseline, getBaseline, listBaselineRisks, signBaseline } from "../src/domain/baselines.js";
import { revokeCertificate } from "../src/domain/certificates.js";
import { closeMaintenance, openMaintenance } from "../src/domain/maintenance.js";
import { getObservation, importObservation } from "../src/domain/observations.js";
import { makeApp, goodObservation, seedKit } from "./helpers/rig.js";

test("证书撤销：未签署观测被重评降级，已签署基线保留快照并追加风险", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const signed = importObservation(rig.ctx, goodObservation("P-SIGNED", "2026-03-10T08:00:00Z", ids.combinationId));
  const unsigned = importObservation(rig.ctx, goodObservation("P-UNSIGNED", "2026-03-11T08:00:00Z", ids.combinationId));
  assert.equal(signed.status, "candidate");
  assert.equal(unsigned.status, "candidate");

  const baseline = createBaseline(rig.ctx, { code: "BL-1", componentMapping: { pier: "P7" } });
  signBaseline(rig.ctx, baseline.id, "总工", [signed.id]);
  const snapshotBefore = getObservation(rig.ctx, signed.id).qualification_snapshot;

  rig.setNow("2026-04-01T00:00:00Z");
  const result = revokeCertificate(rig.ctx, ids.stationCertId, "实验室溯源链断裂");
  assert.equal(result.reevaluated, 1); // 只有未签署的被重评
  assert.equal(result.risksAppended, 1); // 已签署的追加一条风险

  // 未签署观测降级为待复核，原因含证书撤销
  const after = getObservation(rig.ctx, unsigned.id);
  assert.equal(after.status, "review");
  assert.ok(JSON.parse(after.failure_reasons).includes("certificate_revoked"));

  // 已签署观测资格快照原样保留
  const signedAfter = getObservation(rig.ctx, signed.id);
  assert.equal(signedAfter.qualification_snapshot, snapshotBefore);
  assert.equal(signedAfter.baseline_id, baseline.id);

  // 基线风险可追溯
  const risks = listBaselineRisks(rig.ctx, baseline.id);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].source, "certificate_revoked");
  assert.equal(risks[0].ref_id, ids.stationCertId);
  assert.equal(risks[0].observation_id, signed.id);
  assert.equal(getBaseline(rig.ctx, baseline.id).status, "signed");
  await rig.app.close();
});

test("维修结论迟到：只重评未签署观测，已签署的追加风险", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const signed = importObservation(rig.ctx, goodObservation("P-M1", "2026-03-10T08:00:00Z", ids.combinationId));
  const unsigned = importObservation(rig.ctx, goodObservation("P-M2", "2026-03-10T09:00:00Z", ids.combinationId));
  const baseline = createBaseline(rig.ctx, { code: "BL-2" });
  signBaseline(rig.ctx, baseline.id, "总工", [signed.id]);

  // 维修结论迟到：3-08 就已送修，4-01 才补录并结案
  rig.setNow("2026-04-01T00:00:00Z");
  const m = openMaintenance(rig.ctx, { serialNumber: "TS-001", openedAt: "2026-03-08T00:00:00Z" });
  const closed = closeMaintenance(rig.ctx, m.id, {
    closedAt: "2026-03-20T00:00:00Z",
    conclusion: "轴系校正，期间数据不可用",
  });
  assert.equal(closed.reevaluated, 1);
  assert.equal(closed.risksAppended, 1);

  const after = getObservation(rig.ctx, unsigned.id);
  assert.equal(after.status, "review");
  assert.ok(JSON.parse(after.failure_reasons).includes("maintenance_locked"));

  const risks = listBaselineRisks(rig.ctx, baseline.id);
  assert.equal(risks.length, 1);
  assert.equal(risks[0].source, "maintenance_conclusion");
  await rig.app.close();
});

test("已签署观测不能再复核裁定，未签署的裁定后也不影响基线", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, goodObservation("P-ADJ", "2026-03-10T08:00:00Z", ids.combinationId));
  const baseline = createBaseline(rig.ctx, { code: "BL-3" });
  signBaseline(rig.ctx, baseline.id, "总工", [obs.id]);
  const { reviewObservation } = await import("../src/domain/observations.js");
  assert.throws(
    () => reviewObservation(rig.ctx, obs.id, { disposition: "isolated", reviewedBy: "质检员" }),
    /已签署/,
  );
  await rig.app.close();
});

test("重评是幂等的：重复撤销同一证书直接拒绝", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  revokeCertificate(rig.ctx, ids.prismCertId, "第一次撤销");
  assert.throws(() => revokeCertificate(rig.ctx, ids.prismCertId, "第二次撤销"), /已撤销/);
  await rig.app.close();
});

test("签署只接受候选观测，待复核观测不能混入基线", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const bad = importObservation(rig.ctx, {
    ...goodObservation("P-BAD", "2026-03-10T08:00:00Z", ids.combinationId),
    workArea: "B区",
  });
  assert.equal(bad.status, "review");
  const baseline = createBaseline(rig.ctx, { code: "BL-4" });
  assert.throws(() => signBaseline(rig.ctx, baseline.id, "总工", [bad.id]), /候选观测/);
  await rig.app.close();
});
