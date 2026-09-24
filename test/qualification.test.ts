import assert from "node:assert/strict";
import test from "node:test";

import { issueCertificate } from "../src/domain/certificates.js";
import { registerDevice } from "../src/domain/devices.js";
import { openMaintenance } from "../src/domain/maintenance.js";
import { getObservation, importObservation, reviewObservation } from "../src/domain/observations.js";
import { makeApp, goodObservation, seedKit } from "./helpers/rig.js";

test("合格观测进入候选解并冻结设备/证书/租约版本", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, goodObservation("P-OK", "2026-03-10T08:00:00Z", ids.combinationId));
  assert.equal(obs.status, "candidate");
  assert.equal(obs.decision, "adopted");
  const snapshot = JSON.parse(obs.qualification_snapshot!);
  assert.equal(snapshot.lease.id, ids.leaseId);
  assert.equal(snapshot.lease.version, 2); // requested → lent
  assert.deepEqual(
    snapshot.certificates.map((c: { id: string }) => c.id).sort(),
    [ids.stationCertId, ids.prismCertId].sort(),
  );
  assert.equal(snapshot.combination.id, ids.combinationId);
  assert.equal(snapshot.devices.length, 2);
  const trace = JSON.parse(obs.rule_trace!);
  assert.ok(trace.checks.every((c: { ok: boolean }) => c.ok));
  await rig.app.close();
});

test("校准过期观测进入待复核且不被删除", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  // 证书 2027-01-01 到期；观测发生在之后
  const obs = importObservation(rig.ctx, goodObservation("P-EXP", "2027-02-01T08:00:00Z", ids.combinationId));
  assert.equal(obs.status, "review");
  assert.equal(obs.decision, "downgraded");
  assert.ok(JSON.parse(obs.failure_reasons).includes("certificate_expired"));
  // 数据仍在，可查询
  assert.equal(getObservation(rig.ctx, obs.id).packet_id, "P-EXP");
  await rig.app.close();
});

test("越区观测进入待复核", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, {
    ...goodObservation("P-AREA", "2026-03-10T08:00:00Z", ids.combinationId),
    workArea: "B区",
  });
  assert.equal(obs.status, "review");
  assert.ok(JSON.parse(obs.failure_reasons).includes("work_area_mismatch"));
  await rig.app.close();
});

test("设备借给另一班组的观测进入待复核", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, {
    ...goodObservation("P-CREW", "2026-03-10T08:00:00Z", ids.combinationId),
    crew: "二班",
  });
  assert.equal(obs.status, "review");
  assert.ok(JSON.parse(obs.failure_reasons).includes("crew_mismatch"));
  await rig.app.close();
});

test("组件不匹配（用了别的棱镜）进入待复核", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  registerDevice(rig.ctx, {
    serialNumber: "PR-002",
    kind: "prism",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  issueCertificate(rig.ctx, {
    certificateNo: "CERT-PR-2",
    serialNumber: "PR-002",
    issuedAt: "2026-01-01T00:00:00Z",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
    accuracyClass: "2.0mm",
  });
  const obs = importObservation(rig.ctx, {
    ...goodObservation("P-COMP", "2026-03-10T08:00:00Z", ids.combinationId),
    devices: [
      { serialNumber: "TS-001", role: "station" },
      { serialNumber: "PR-002", role: "prism" },
    ],
  });
  assert.equal(obs.status, "review");
  assert.ok(JSON.parse(obs.failure_reasons).includes("component_mismatch"));
  await rig.app.close();
});

test("维修锁定期间的观测进入待复核", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  rig.setNow("2026-03-05T00:00:00Z");
  openMaintenance(rig.ctx, { serialNumber: "PR-001", openedAt: "2026-03-05T00:00:00Z" });
  const obs = importObservation(rig.ctx, goodObservation("P-MNT", "2026-03-06T08:00:00Z", ids.combinationId));
  assert.equal(obs.status, "review");
  const failures = JSON.parse(obs.failure_reasons);
  assert.ok(failures.includes("maintenance_locked"));
  await rig.app.close();
});

test("精度不足进入待复核", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, {
    ...goodObservation("P-ACC", "2026-03-10T08:00:00Z", ids.combinationId),
    requiredAccuracy: "1.0mm",
  });
  assert.equal(obs.status, "review");
  assert.ok(JSON.parse(obs.failure_reasons).includes("accuracy_insufficient"));
  await rig.app.close();
});

test("逾期未还期间的观测进入待复核", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  // 租约 03-31 结束，未归还；04-02 的观测
  const obs = importObservation(rig.ctx, goodObservation("P-OVD", "2026-04-02T08:00:00Z", ids.combinationId));
  assert.equal(obs.status, "review");
  assert.ok(JSON.parse(obs.failure_reasons).includes("lease_overdue"));
  await rig.app.close();
});

test("不完整采集包被隔离而非删除，且不能未补全就参与仲裁", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const incomplete = goodObservation("P-INC", "2026-03-10T08:00:00Z", ids.combinationId) as Record<string, unknown>;
  delete incomplete.summary;
  const obs = importObservation(rig.ctx, incomplete as never);
  assert.equal(obs.status, "quarantined");
  assert.equal(obs.decision, "isolated");
  // 未补全摘要/序号/坐标前不能解除隔离
  assert.throws(
    () => reviewObservation(rig.ctx, obs.id, { disposition: "released", reviewedBy: "质检员" }),
    /不完整/,
  );
  // 记录仍在
  assert.equal(getObservation(rig.ctx, obs.id).status, "quarantined");
  await rig.app.close();
});

test("待复核观测可被裁定为隔离，也可解除回候选", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  const obs = importObservation(rig.ctx, {
    ...goodObservation("P-RVW", "2026-03-10T08:00:00Z", ids.combinationId),
    workArea: "B区",
  });
  assert.equal(obs.status, "review");
  const isolated = reviewObservation(rig.ctx, obs.id, {
    disposition: "isolated",
    reviewedBy: "质检员",
    note: "越区观测，隔离保留",
  });
  assert.equal(isolated.status, "quarantined");
  assert.equal(isolated.decision, "isolated");
  const released = reviewObservation(rig.ctx, obs.id, { disposition: "released", reviewedBy: "总工" });
  assert.equal(released.status, "candidate");
  assert.equal(released.decision, "adopted");
  assert.equal(released.reviewed_by, "总工");
  await rig.app.close();
});

test("原始采集包不可覆盖：packetId 重复被拒绝", async () => {
  const rig = makeApp();
  const ids = seedKit(rig.ctx);
  importObservation(rig.ctx, goodObservation("P-DUP", "2026-03-10T08:00:00Z", ids.combinationId));
  const response = await rig.app.inject({
    method: "POST",
    url: "/observations",
    payload: goodObservation("P-DUP", "2026-03-11T08:00:00Z", ids.combinationId),
  });
  assert.equal(response.statusCode, 409);
  await rig.app.close();
});
