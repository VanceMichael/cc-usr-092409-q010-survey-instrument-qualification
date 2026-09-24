import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { confirmLend, confirmReturn, getLease, rejectLease, requestLease } from "../src/domain/leases.js";
import { openMaintenance } from "../src/domain/maintenance.js";
import { registerDevice } from "../src/domain/devices.js";
import { makeApp, seedKit } from "./helpers/rig.js";

test("借用申请绑定班组、工作区、时间窗、用途与设备", async () => {
  const rig = makeApp();
  const { leaseId } = seedKit(rig.ctx);
  const lease = getLease(rig.ctx, leaseId);
  assert.equal(lease.crew, "一班");
  assert.equal(lease.work_area, "A区");
  assert.equal(lease.purpose, "桥墩位移观测");
  assert.equal(lease.status, "lent");
  assert.equal(lease.custodian, "老陈");
  assert.equal(lease.applicant, "小李");
  await rig.app.close();
});

test("重叠租约被原子拒绝，边界相接允许", async () => {
  const rig = makeApp();
  seedKit(rig.ctx); // L-1: 03-01 ~ 03-31 lent
  // 相交 → 拒绝
  assert.throws(
    () =>
      requestLease(rig.ctx, {
        code: "L-2",
        crew: "二班",
        workArea: "B区",
        purpose: "另一组观测",
        startsAt: "2026-03-10T00:00:00Z",
        endsAt: "2026-03-20T00:00:00Z",
        applicant: "小王",
        devices: [{ serialNumber: "TS-001" }],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "OVERLAPPING_LEASE",
  );
  // 边界相接（03-31 起）→ 允许
  const adjacent = requestLease(rig.ctx, {
    code: "L-3",
    crew: "二班",
    workArea: "B区",
    purpose: "接续观测",
    startsAt: "2026-03-31T00:00:00Z",
    endsAt: "2026-04-10T00:00:00Z",
    applicant: "小王",
    devices: [{ serialNumber: "TS-001" }],
  });
  assert.equal(adjacent.status, "requested");
  await rig.app.close();
});

test("归还后同设备同窗口可再次出借", async () => {
  const rig = makeApp();
  const { leaseId } = seedKit(rig.ctx);
  rig.setNow("2026-03-15T00:00:00Z");
  confirmReturn(rig.ctx, leaseId, "小李");
  const again = requestLease(rig.ctx, {
    code: "L-4",
    crew: "二班",
    workArea: "B区",
    purpose: "复测",
    startsAt: "2026-03-16T00:00:00Z",
    endsAt: "2026-03-20T00:00:00Z",
    applicant: "小王",
    devices: [{ serialNumber: "TS-001" }, { serialNumber: "PR-001" }],
  });
  assert.equal(again.status, "requested");
  await rig.app.close();
});

test("出借必须由保管人确认，归还必须由领用人确认", async () => {
  const rig = makeApp();
  registerDevice(rig.ctx, {
    serialNumber: "TS-002",
    kind: "total_station",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  const lease = requestLease(rig.ctx, {
    code: "L-9",
    crew: "一班",
    workArea: "A区",
    purpose: "观测",
    startsAt: "2026-03-01T00:00:00Z",
    endsAt: "2026-03-10T00:00:00Z",
    applicant: "小李",
    devices: [{ serialNumber: "TS-002" }],
  });
  assert.throws(
    () => confirmLend(rig.ctx, lease.id, "别人"),
    (error: unknown) => error instanceof DomainError && error.code === "ILLEGAL_STATE",
  );
  confirmLend(rig.ctx, lease.id, "老陈");
  assert.throws(
    () => confirmReturn(rig.ctx, lease.id, "老陈"),
    (error: unknown) => error instanceof DomainError && error.code === "ILLEGAL_STATE",
  );
  const returned = confirmReturn(rig.ctx, lease.id, "小李");
  assert.equal(returned.status, "returned");
  assert.equal(returned.return_confirmer, "小李");
  await rig.app.close();
});

test("维修锁定中的设备不能出借", async () => {
  const rig = makeApp();
  registerDevice(rig.ctx, {
    serialNumber: "TS-003",
    kind: "total_station",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  openMaintenance(rig.ctx, { serialNumber: "TS-003", openedAt: "2026-03-01T00:00:00Z" });
  const lease = requestLease(rig.ctx, {
    code: "L-10",
    crew: "一班",
    workArea: "A区",
    purpose: "观测",
    startsAt: "2026-03-02T00:00:00Z",
    endsAt: "2026-03-10T00:00:00Z",
    applicant: "小李",
    devices: [{ serialNumber: "TS-003" }],
  });
  assert.throws(
    () => confirmLend(rig.ctx, lease.id, "老陈"),
    (error: unknown) => error instanceof DomainError && error.code === "ILLEGAL_STATE",
  );
  await rig.app.close();
});

test("HTTP：重叠租约返回 409 OVERLAPPING_LEASE", async () => {
  const rig = makeApp();
  seedKit(rig.ctx);
  const response = await rig.app.inject({
    method: "POST",
    url: "/leases",
    payload: {
      code: "L-HTTP",
      crew: "二班",
      workArea: "B区",
      purpose: "冲突观测",
      startsAt: "2026-03-05T00:00:00Z",
      endsAt: "2026-03-06T00:00:00Z",
      applicant: "小王",
      devices: [{ serialNumber: "PR-001" }],
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "OVERLAPPING_LEASE");
  await rig.app.close();
});

test("HTTP：驳回后不再占用时间窗", async () => {
  const rig = makeApp();
  registerDevice(rig.ctx, {
    serialNumber: "TS-004",
    kind: "total_station",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  const lease = requestLease(rig.ctx, {
    code: "L-11",
    crew: "一班",
    workArea: "A区",
    purpose: "观测",
    startsAt: "2026-03-01T00:00:00Z",
    endsAt: "2026-03-10T00:00:00Z",
    applicant: "小李",
    devices: [{ serialNumber: "TS-004" }],
  });
  rejectLease(rig.ctx, lease.id, "计划取消");
  const again = requestLease(rig.ctx, {
    code: "L-12",
    crew: "二班",
    workArea: "A区",
    purpose: "观测",
    startsAt: "2026-03-01T00:00:00Z",
    endsAt: "2026-03-10T00:00:00Z",
    applicant: "小王",
    devices: [{ serialNumber: "TS-004" }],
  });
  assert.equal(again.status, "requested");
  await rig.app.close();
});
