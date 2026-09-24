import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "../src/app.js";

type App = ReturnType<typeof buildApp>;

const WINDOW = { start: "2026-03-01T00:00:00Z", end: "2026-03-31T23:59:59Z" };
const OBSERVED_AT = "2026-03-10T08:00:00Z";
const PAYLOAD = JSON.stringify({ points: [[1, 2, 3]] });

function makeApp(): App {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "qual-")), "test.sqlite3");
  return buildApp();
}

async function inject(app: App, method: string, url: string, payload?: unknown) {
  const response = await app.inject({ method: method as never, url, payload: payload as never });
  return { status: response.statusCode, body: response.json() as any };
}

async function seedQualifiedInstrument(app: App) {
  const serial = `TS-${randomUUID().slice(0, 8)}`;
  const instrument = (
    await inject(app, "POST", "/instruments", { serial_no: serial, kind: "total_station", custodian: "保管人甲" })
  ).body;
  const certificate = (
    await inject(app, "POST", "/certificates", {
      instrument_id: instrument.id,
      cert_no: `CAL-${randomUUID().slice(0, 8)}`,
      precision_class: "II",
      valid_from: "2026-01-01T00:00:00Z",
      valid_until: "2026-12-31T23:59:59Z",
    })
  ).body;
  const lease = (
    await inject(app, "POST", "/leases", {
      instrument_id: instrument.id,
      crew: "测绘一组",
      borrower: "领用人乙",
      zone: "A区",
      purpose: "控制网复测",
      window_start: WINDOW.start,
      window_end: WINDOW.end,
    })
  ).body;
  await inject(app, "POST", `/leases/${lease.id}/confirm-lend`, { confirmed_by: "保管人甲" });
  return { instrument, certificate, lease };
}

function importObservation(app: App, instrumentId: string, overrides: Record<string, unknown> = {}) {
  return inject(app, "POST", "/observations/import", {
    instrument_id: instrumentId,
    observed_at: OBSERVED_AT,
    zone: "A区",
    required_precision: "III",
    payload: PAYLOAD,
    ...overrides,
  });
}

test("重叠租约被原子拒绝且不留下记录", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument } = await seedQualifiedInstrument(app);

  const overlap = await inject(app, "POST", "/leases", {
    instrument_id: instrument.id,
    crew: "测绘二组",
    borrower: "领用人丙",
    zone: "B区",
    purpose: "变形监测",
    window_start: "2026-03-15T00:00:00Z",
    window_end: "2026-04-15T00:00:00Z",
  });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error, "lease_overlap");

  const accepted = await inject(app, "POST", "/leases", {
    instrument_id: instrument.id,
    crew: "测绘二组",
    borrower: "领用人丙",
    zone: "B区",
    purpose: "变形监测",
    window_start: "2026-04-01T00:00:00Z",
    window_end: "2026-04-15T00:00:00Z",
  });
  assert.equal(accepted.status, 201);

  const leases = (await inject(app, "GET", `/leases?instrument_id=${instrument.id}`)).body;
  assert.equal(leases.length, 2);
});

test("出借由保管人确认、归还由领用人确认", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const instrument = (
    await inject(app, "POST", "/instruments", { serial_no: "TS-CONF-1", kind: "total_station", custodian: "保管人甲" })
  ).body;
  const lease = (
    await inject(app, "POST", "/leases", {
      instrument_id: instrument.id,
      crew: "测绘一组",
      borrower: "领用人乙",
      zone: "A区",
      purpose: "测试",
      window_start: "2026-05-01T00:00:00Z",
      window_end: "2026-05-10T00:00:00Z",
    })
  ).body;

  const wrongLend = await inject(app, "POST", `/leases/${lease.id}/confirm-lend`, { confirmed_by: "路人" });
  assert.equal(wrongLend.status, 403);
  assert.equal(wrongLend.body.error, "custodian_required");

  const lent = await inject(app, "POST", `/leases/${lease.id}/confirm-lend`, { confirmed_by: "保管人甲" });
  assert.equal(lent.body.state, "lent");
  assert.equal(lent.body.lent_confirmed_by, "保管人甲");

  const wrongReturn = await inject(app, "POST", `/leases/${lease.id}/confirm-return`, { confirmed_by: "保管人甲" });
  assert.equal(wrongReturn.status, 403);
  assert.equal(wrongReturn.body.error, "borrower_required");

  const returned = await inject(app, "POST", `/leases/${lease.id}/confirm-return`, { confirmed_by: "领用人乙" });
  assert.equal(returned.body.state, "returned");

  const again = await inject(app, "POST", `/leases/${lease.id}/confirm-return`, { confirmed_by: "领用人乙" });
  assert.equal(again.status, 409);
});

test("合格观测进入候选解, 问题观测进入待复核且原始数据不被删除", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument } = await seedQualifiedInstrument(app);

  const good = await importObservation(app, instrument.id);
  assert.equal(good.body.status, "candidate");
  assert.deepEqual(good.body.reasons, []);

  const wrongZone = await importObservation(app, instrument.id, { zone: "C区" });
  assert.equal(wrongZone.body.status, "pending_review");
  assert.ok(wrongZone.body.reasons.includes("zone_mismatch"));

  const tooPrecise = await importObservation(app, instrument.id, { required_precision: "I" });
  assert.ok(tooPrecise.body.reasons.includes("precision_insufficient"));

  const outsideWindow = await importObservation(app, instrument.id, { observed_at: "2026-05-01T00:00:00Z" });
  assert.ok(outsideWindow.body.reasons.includes("lease_missing"));

  const expiredView = await importObservation(app, instrument.id, { observed_at: "2027-02-01T00:00:00Z" });
  assert.ok(expiredView.body.reasons.includes("certificate_expired"));

  // 待复核数据保留原始采集包
  const stored = (await inject(app, "GET", `/observations/${wrongZone.body.id}`)).body;
  assert.equal(stored.status, "pending_review");
  assert.equal(stored.payload, PAYLOAD);
});

test("组件组合不匹配进入待复核", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument } = await seedQualifiedInstrument(app);
  await inject(app, "POST", "/instruments", { serial_no: "PR-1", kind: "prism", custodian: "保管人甲" });
  const setWith = (await inject(app, "POST", "/component-sets", { name: "组合-含主机", members: ["PR-1", instrument.serial_no] })).body;
  const setWithout = (await inject(app, "POST", "/component-sets", { name: "组合-仅棱镜", members: ["PR-1"] })).body;

  const matched = await importObservation(app, instrument.id, { component_set_id: setWith.id });
  assert.equal(matched.body.status, "candidate");

  const mismatched = await importObservation(app, instrument.id, { component_set_id: setWithout.id });
  assert.equal(mismatched.body.status, "pending_review");
  assert.ok(mismatched.body.reasons.includes("component_mismatch"));
});

test("证书撤销只重评尚未裁定的观测", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument, certificate } = await seedQualifiedInstrument(app);

  const pending = (await importObservation(app, instrument.id)).body;
  const quarantined = (await importObservation(app, instrument.id)).body;
  await inject(app, "POST", `/observations/${quarantined.id}/adjudicate`, { decision: "quarantined", reviewer: "复核员" });

  const revoke = await inject(app, "POST", `/certificates/${certificate.id}/revoke`, { reason: "溯源链断裂" });
  assert.equal(revoke.status, 200);

  const afterPending = (await inject(app, "GET", `/observations/${pending.id}`)).body;
  assert.equal(afterPending.status, "pending_review");
  assert.ok(JSON.parse(afterPending.decision_reasons).includes("certificate_revoked"));

  const afterQuarantined = (await inject(app, "GET", `/observations/${quarantined.id}`)).body;
  assert.equal(afterQuarantined.status, "quarantined");
});

test("已签署基线保留资格快照, 证书撤销只追加风险", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument, certificate } = await seedQualifiedInstrument(app);

  const adopted = (await importObservation(app, instrument.id)).body;
  const pendingReview = (await importObservation(app, instrument.id, { zone: "B区" })).body;
  const baseline = (await inject(app, "POST", "/baselines", { name: "基线-v1" })).body;

  const rejected = await inject(app, "POST", `/baselines/${baseline.id}/sign`, {
    observation_ids: [pendingReview.id],
    signed_by: "项目负责人",
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, "observation_not_qualified");

  const signed = await inject(app, "POST", `/baselines/${baseline.id}/sign`, {
    observation_ids: [adopted.id],
    signed_by: "项目负责人",
  });
  assert.equal(signed.status, 200);

  await inject(app, "POST", `/certificates/${certificate.id}/revoke`, { reason: "证书造假" });

  const after = (await inject(app, "GET", `/observations/${adopted.id}`)).body;
  assert.equal(after.status, "adopted");

  const detail = (await inject(app, "GET", `/baselines/${baseline.id}`)).body;
  assert.equal(detail.risks.length, 1);
  assert.ok(detail.risks[0].risk.startsWith("certificate_revoked"));
  const snapshot = JSON.parse(detail.members[0].qualification_snapshot);
  assert.equal(snapshot.certificate.status, "valid");
  assert.equal(snapshot.instrument.custodian, "保管人甲");
});

test("维修锁定期间观测待复核, 迟到结论触发重评", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument } = await seedQualifiedInstrument(app);

  const maintenance = (
    await inject(app, "POST", "/maintenance", {
      instrument_id: instrument.id,
      opened_at: "2026-03-09T00:00:00Z",
      note: "轴系检修",
    })
  ).body;
  const locked = await importObservation(app, instrument.id);
  assert.equal(locked.body.status, "pending_review");
  assert.ok(locked.body.reasons.includes("maintenance_lock"));

  const closed = await inject(app, "POST", `/maintenance/${maintenance.id}/close`, {
    closed_at: "2026-03-11T00:00:00Z",
    conclusion: "照准部超差",
    conclusion_ok: false,
  });
  assert.ok(closed.body.observations_reevaluated >= 1);
  const after = (await inject(app, "GET", `/observations/${locked.body.id}`)).body;
  const reasons = JSON.parse(after.decision_reasons);
  assert.ok(reasons.includes("maintenance_failed"));
  assert.ok(!reasons.includes("maintenance_lock"));

  // 合格结论解除锁定, 观测回到候选解
  const { instrument: second } = await seedQualifiedInstrument(app);
  const secondMaintenance = (
    await inject(app, "POST", "/maintenance", { instrument_id: second.id, opened_at: "2026-03-09T00:00:00Z" })
  ).body;
  const secondObs = (await importObservation(app, second.id)).body;
  assert.equal(secondObs.status, "pending_review");
  await inject(app, "POST", `/maintenance/${secondMaintenance.id}/close`, {
    closed_at: "2026-03-11T00:00:00Z",
    conclusion: "检修合格",
    conclusion_ok: true,
  });
  const afterSecond = (await inject(app, "GET", `/observations/${secondObs.id}`)).body;
  assert.equal(afterSecond.status, "candidate");
});

test("同一封签并发确认只能成功一次", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument } = await seedQualifiedInstrument(app);

  const [first, second] = await Promise.all([
    inject(app, "POST", "/handovers/confirm", {
      seal_no: "SEAL-001",
      instrument_id: instrument.id,
      confirmed_by: "保管人甲",
      ledger_note: "设备流水归位#1",
    }),
    inject(app, "POST", "/handovers/confirm", {
      seal_no: "SEAL-001",
      instrument_id: instrument.id,
      confirmed_by: "保管人乙",
      ledger_note: "设备流水归位#2",
    }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);

  const record = await inject(app, "GET", "/handovers/SEAL-001");
  assert.equal(record.status, 200);
  assert.equal(record.body.instrument_id, instrument.id);
});

test("停服恢复后继续逾期归还、证书到期与复核任务", async (t) => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "qual-recovery-")), "recovery.sqlite3");
  const app = buildApp();

  const instrument = (
    await inject(app, "POST", "/instruments", { serial_no: "TS-OLD", kind: "total_station", custodian: "保管人甲" })
  ).body;
  await inject(app, "POST", "/certificates", {
    instrument_id: instrument.id,
    cert_no: "CAL-OLD",
    precision_class: "II",
    valid_from: "2025-01-01T00:00:00Z",
    valid_until: "2026-02-01T00:00:00Z",
  });
  const lease = (
    await inject(app, "POST", "/leases", {
      instrument_id: instrument.id,
      crew: "测绘一组",
      borrower: "领用人乙",
      zone: "A区",
      purpose: "控制网复测",
      window_start: "2026-01-01T00:00:00Z",
      window_end: "2026-01-31T00:00:00Z",
    })
  ).body;
  await inject(app, "POST", `/leases/${lease.id}/confirm-lend`, { confirmed_by: "保管人甲" });
  const observation = (
    await inject(app, "POST", "/observations/import", {
      instrument_id: instrument.id,
      observed_at: "2026-01-15T00:00:00Z",
      zone: "A区",
      required_precision: "III",
      payload: PAYLOAD,
    })
  ).body;
  assert.equal(observation.status, "candidate");
  await app.close();

  // 模拟停服后恢复
  const restarted = buildApp();
  t.after(() => restarted.close());

  const recovery = (await inject(restarted, "GET", "/recovery/status")).body;
  assert.equal(recovery.leases_marked_overdue, 1);
  assert.equal(recovery.certificates_expired, 1);

  const leaseAfter = (await inject(restarted, "GET", `/leases?instrument_id=${instrument.id}`)).body[0];
  assert.equal(leaseAfter.state, "overdue");

  const observationAfter = (await inject(restarted, "GET", `/observations/${observation.id}`)).body;
  assert.equal(observationAfter.status, "pending_review");
  assert.ok(JSON.parse(observationAfter.decision_reasons).includes("certificate_expired"));

  const tasks = (await inject(restarted, "GET", "/tasks?status=pending")).body;
  assert.deepEqual(
    tasks.map((task: { type: string }) => task.type).sort(),
    ["cert_expiry", "overdue_return", "review"],
  );
});

test("查询能解释观测为何采用、降级或隔离并追溯到保管人与校准依据", async (t) => {
  const app = makeApp();
  t.after(() => app.close());
  const { instrument, certificate, lease } = await seedQualifiedInstrument(app);

  const adopted = (await importObservation(app, instrument.id)).body;
  const baseline = (await inject(app, "POST", "/baselines", { name: "基线-解释" })).body;
  await inject(app, "POST", `/baselines/${baseline.id}/sign`, { observation_ids: [adopted.id], signed_by: "项目负责人" });

  const explanation = (await inject(app, "GET", `/observations/${adopted.id}/explanation`)).body;
  assert.equal(explanation.decision, "采用");
  assert.equal(explanation.custodian, "保管人甲");
  assert.ok(explanation.calibration_basis.includes(certificate.cert_no));
  assert.equal(explanation.qualification_snapshot.lease.id, lease.id);
  assert.equal(explanation.baselines[0].baseline_id, baseline.id);
  assert.ok(explanation.events.some((event: { event: string }) => event.event === "signed_into_baseline"));

  const downgraded = (await importObservation(app, instrument.id, { zone: "B区" })).body;
  await inject(app, "POST", `/observations/${downgraded.id}/adjudicate`, {
    decision: "downgraded",
    reviewer: "复核员",
    note: "越区观测降精度使用",
  });
  const downgradedExplanation = (await inject(app, "GET", `/observations/${downgraded.id}/explanation`)).body;
  assert.equal(downgradedExplanation.decision, "降级");
  assert.equal(downgradedExplanation.adjudication.adjudicated_by, "复核员");
  assert.ok(downgradedExplanation.decision_reasons.includes("zone_mismatch"));
});
