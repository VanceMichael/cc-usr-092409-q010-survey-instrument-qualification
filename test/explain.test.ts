import assert from "node:assert/strict";
import test from "node:test";

import { createBaseline, signBaseline } from "../src/domain/baselines.js";
import { revokeCertificate } from "../src/domain/certificates.js";
import { importObservation } from "../src/domain/observations.js";
import { makeApp, goodObservation, seedKit } from "./helpers/rig.js";

test("解释采用的观测：规则轨迹、保管人、校准依据齐全", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, goodObservation("P-X1", "2026-03-10T08:00:00Z", ids.combinationId));
  const response = await rig.app.inject({ method: "GET", url: `/observations/${obs.id}/explain` });
  assert.equal(response.statusCode, 200);
  const explain = response.json();
  assert.equal(explain.disposition.label, "采用");
  assert.equal(explain.disposition.adjudicated, false);
  // 设备保管人
  const station = explain.lineage.devices.find((d: { serialNumber: string }) => d.serialNumber === "TS-001");
  assert.equal(station.custodian, "老陈");
  assert.equal(station.current.custodian, "老陈");
  // 校准依据
  const certNos = explain.lineage.certificates.map((c: { certificateNo: string }) => c.certificateNo).sort();
  assert.deepEqual(certNos, ["CERT-PR-1", "CERT-TS-1"]);
  // 租约与领用人
  assert.equal(explain.lineage.lease.code, "L-1");
  assert.equal(explain.lineage.lease.applicant, "小李");
  // 冻结快照与规则轨迹
  assert.ok(explain.frozenAtImport.qualificationSnapshot.lease.id);
  assert.ok(explain.frozenAtImport.ruleTrace.checks.length > 0);
  // 时间线含导入事件
  assert.ok(explain.timeline.some((e: { type: string }) => e.type === "observation.imported"));
  await rig.app.close();
});

test("解释降级的观测：给出失败原因与后续复核任务", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, {
    ...goodObservation("P-X2", "2026-03-10T08:00:00Z", ids.combinationId),
    workArea: "B区",
  });
  const explain = (await rig.app.inject({ method: "GET", url: `/observations/${obs.id}/explain` })).json();
  assert.equal(explain.disposition.label, "降级");
  assert.ok(explain.disposition.failureReasons.includes("work_area_mismatch"));
  assert.ok(explain.disposition.failureLabels.some((l: string) => l.includes("越")));
  assert.ok(explain.followUp.pendingTasks.some((t: { type: string }) => t.type === "review"));
  await rig.app.close();
});

test("解释隔离的观测：说明采集包不完整", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const incomplete = goodObservation("P-X3", "2026-03-10T08:00:00Z", ids.combinationId) as Record<string, unknown>;
  delete incomplete.summary;
  delete incomplete.easting;
  const obs = importObservation(rig.ctx, incomplete as never);
  const explain = (await rig.app.inject({ method: "GET", url: `/observations/${obs.id}/explain` })).json();
  assert.equal(explain.disposition.label, "隔离");
  assert.ok(explain.disposition.failureReasons.includes("packet_incomplete"));
  assert.equal(explain.observation.complete, false);
  await rig.app.close();
});

test("证书撤销后：已签署观测的解释保留冻结快照并列出风险与证书当前状态", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, goodObservation("P-X4", "2026-03-10T08:00:00Z", ids.combinationId));
  const baseline = createBaseline(rig.ctx, { code: "BL-X" });
  signBaseline(rig.ctx, baseline.id, "总工", [obs.id]);
  rig.setNow("2026-04-01T00:00:00Z");
  revokeCertificate(rig.ctx, ids.stationCertId, "实验室溯源链断裂");

  const explain = (await rig.app.inject({ method: "GET", url: `/observations/${obs.id}/explain` })).json();
  assert.equal(explain.disposition.adjudicated, true);
  // 冻结快照里的证书仍是签署时版本
  const frozenCert = explain.frozenAtImport.qualificationSnapshot.certificates.find(
    (c: { id: string }) => c.id === ids.stationCertId,
  );
  assert.ok(frozenCert);
  // 当前证书状态已撤销，版本漂移可见
  const certLineage = explain.lineage.certificates.find((c: { id: string }) => c.id === ids.stationCertId);
  assert.equal(certLineage.current.status, "revoked");
  assert.equal(certLineage.current.versionDrift, true);
  // 后续处置：基线 + 风险
  assert.equal(explain.followUp.baseline.code, "BL-X");
  assert.equal(explain.followUp.risks.length, 1);
  assert.equal(explain.followUp.risks[0].source, "certificate_revoked");
  // 时间线含签署与重评相关事件
  assert.ok(explain.timeline.some((e: { type: string }) => e.type === "observation.imported"));
  await rig.app.close();
});

test("解释不存在的观测返回 404", async () => {
  const rig = makeApp();
  const response = await rig.app.inject({ method: "GET", url: "/observations/obs_none/explain" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "NOT_FOUND");
  await rig.app.close();
});
