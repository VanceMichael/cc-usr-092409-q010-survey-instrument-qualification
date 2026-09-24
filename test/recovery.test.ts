import assert from "node:assert/strict";
import test from "node:test";

import { getCertificate } from "../src/domain/certificates.js";
import { listDueTasks, runDueTasks } from "../src/domain/duetasks.js";
import { getLease } from "../src/domain/leases.js";
import { importObservation } from "../src/domain/observations.js";
import { makeApp, goodObservation, seedKit } from "./helpers/rig.js";

test("停服恢复后续跑逾期归还、证书到期与复核任务", async () => {
  // 第一次启动：建立租约（出借）、证书与一条待复核观测
  const first = makeApp("2026-03-01T00:00:00Z");
  const ids = seedKit(first.ctx);
  const reviewObs = importObservation(first.ctx, {
    ...goodObservation("P-REV", "2026-03-10T08:00:00Z", ids.combinationId),
    workArea: "B区",
  });
  assert.equal(reviewObs.status, "review");
  const dbPath = first.dbPath;
  // 任务已登记
  const pendingBefore = listDueTasks(first.ctx, "pending");
  assert.ok(pendingBefore.some((t) => t.type === "overdue_return" && t.ref_id === ids.leaseId));
  assert.ok(pendingBefore.some((t) => t.type === "certificate_expiry" && t.ref_id === ids.stationCertId));
  assert.ok(pendingBefore.some((t) => t.type === "review" && t.ref_id === reviewObs.id));
  await first.app.close(); // 模拟停服

  // 恢复时时间已越过租约截止与复核期限：启动即续跑
  const second = makeApp("2026-04-02T00:00:00Z", dbPath);
  const lease = getLease(second.ctx, ids.leaseId);
  assert.equal(lease.overdue, 1); // 逾期归还被标记
  // 复核任务到期已处理（事件落库），观测仍在待复核
  const reviewTasks = listDueTasks(second.ctx).filter((t) => t.type === "review" && t.ref_id === reviewObs.id);
  assert.equal(reviewTasks[0].status, "done");
  const events = second.ctx.db
    .prepare("SELECT type FROM domain_events WHERE subject_id = ? ORDER BY at")
    .all(reviewObs.id) as unknown as Array<{ type: string }>;
  assert.ok(events.some((e) => e.type === "observation.review_overdue"));

  // 时间越过证书有效期后恢复：证书被标记过期
  await second.app.close();
  const third = makeApp("2027-02-01T00:00:00Z", dbPath);
  assert.equal(getCertificate(third.ctx, ids.stationCertId).status, "expired");
  assert.equal(getCertificate(third.ctx, ids.prismCertId).status, "expired");
  await third.app.close();
});

test("到期任务幂等：重复执行不重复标记", async () => {
  const rig = makeApp("2026-03-01T00:00:00Z");
  const ids = seedKit(rig.ctx);
  rig.setNow("2026-04-02T00:00:00Z");
  const first = runDueTasks(rig.ctx);
  assert.ok(first.completed >= 1);
  const lease = getLease(rig.ctx, ids.leaseId);
  assert.equal(lease.overdue, 1);
  const versionAfterFirst = lease.version;
  const second = runDueTasks(rig.ctx);
  assert.equal(second.claimed, 0); // 没有遗留到期任务
  assert.equal(getLease(rig.ctx, ids.leaseId).version, versionAfterFirst);
  await rig.app.close();
});

test("归还后逾期任务被取消，恢复时不会误标", async () => {
  const rig = makeApp("2026-03-01T00:00:00Z");
  const ids = seedKit(rig.ctx);
  const { confirmReturn } = await import("../src/domain/leases.js");
  rig.setNow("2026-03-20T00:00:00Z");
  confirmReturn(rig.ctx, ids.leaseId, "小李");
  const dbPath = rig.dbPath;
  await rig.app.close();
  const second = makeApp("2026-04-05T00:00:00Z", dbPath);
  const lease = getLease(second.ctx, ids.leaseId);
  assert.equal(lease.status, "returned");
  assert.equal(lease.overdue, 0);
  await second.app.close();
});
