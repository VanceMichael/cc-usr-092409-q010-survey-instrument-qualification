import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { DomainError } from "../src/errors.js";
import { confirmHandoff, listHandoffs, recordHandoff } from "../src/domain/handoffs.js";
import { registerDevice } from "../src/domain/devices.js";
import { makeApp, seedKit } from "./helpers/rig.js";

function runWorker(dbPath: string, action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./helpers/sql-worker.mjs", import.meta.url), {
      workerData: { dbPath, action },
    });
    worker.on("message", resolve);
    worker.on("error", reject);
  });
}

test("离线交接按设备流水归位", async () => {
  const rig = makeApp();
  const { stationId } = seedKit(rig.ctx);
  const first = recordHandoff(rig.ctx, {
    deviceId: stationId,
    sealCode: "SEAL-1",
    direction: "outbound",
    fromParty: "老陈",
    toParty: "小李",
  });
  const second = recordHandoff(rig.ctx, {
    deviceId: stationId,
    sealCode: "SEAL-2",
    direction: "inbound",
    fromParty: "小李",
    toParty: "老陈",
  });
  assert.equal(first.sequence_no, 1);
  assert.equal(second.sequence_no, 2);
  const journal = listHandoffs(rig.ctx, stationId);
  assert.deepEqual(journal.map((h) => h.seal_code), ["SEAL-1", "SEAL-2"]);
  await rig.app.close();
});

test("同一封签重复确认只有一次成功", async () => {
  const rig = makeApp();
  const { stationId } = seedKit(rig.ctx);
  const handoff = recordHandoff(rig.ctx, {
    deviceId: stationId,
    sealCode: "SEAL-9",
    direction: "outbound",
    fromParty: "老陈",
    toParty: "小李",
  });
  const confirmed = confirmHandoff(rig.ctx, handoff.id, "小李");
  assert.equal(confirmed.status, "confirmed");
  assert.throws(
    () => confirmHandoff(rig.ctx, handoff.id, "小李"),
    (error: unknown) => error instanceof DomainError && error.code === "SEAL_ALREADY_CONFIRMED",
  );
  await rig.app.close();
});

test("同一封签并发确认只有一次成功（多会话）", async () => {
  const rig = makeApp();
  const { stationId } = seedKit(rig.ctx);
  const handoff = recordHandoff(rig.ctx, {
    deviceId: stationId,
    sealCode: "SEAL-RACE",
    direction: "outbound",
    fromParty: "老陈",
    toParty: "小李",
  });
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      runWorker(rig.dbPath, { kind: "confirm-handoff", id: handoff.id, by: `确认人${i}` }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  const journal = listHandoffs(rig.ctx, stationId);
  const mine = journal.find((h) => h.id === handoff.id)!;
  assert.equal(mine.status, "confirmed");
  await rig.app.close();
});

test("并发提交重叠租约只有一个成功（多会话）", async () => {
  const rig = makeApp();
  registerDevice(rig.ctx, {
    serialNumber: "TS-RACE",
    kind: "total_station",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  const device = rig.ctx.db
    .prepare("SELECT id FROM devices WHERE serial_number = 'TS-RACE'")
    .get() as { id: string };
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      runWorker(rig.dbPath, {
        kind: "insert-lease",
        leaseId: `lease-race-${i}`,
        code: `L-RACE-${i}`,
        deviceId: device.id,
        startsAt: "2026-03-01T00:00:00Z",
        endsAt: "2026-03-31T00:00:00Z",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  const count = rig.ctx.db
    .prepare("SELECT COUNT(*) AS n FROM leases WHERE code LIKE 'L-RACE-%'")
    .get() as { n: number };
  assert.equal(count.n, 1);
  await rig.app.close();
});

test("封签号全局唯一，重复登记被拒绝", async () => {
  const rig = makeApp();
  const { stationId, prismId } = seedKit(rig.ctx);
  recordHandoff(rig.ctx, {
    deviceId: stationId,
    sealCode: "SEAL-DUP",
    direction: "outbound",
    fromParty: "老陈",
    toParty: "小李",
  });
  assert.throws(
    () =>
      recordHandoff(rig.ctx, {
        deviceId: prismId,
        sealCode: "SEAL-DUP",
        direction: "outbound",
        fromParty: "老陈",
        toParty: "小王",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CONFLICT",
  );
  await rig.app.close();
});
