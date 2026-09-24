import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type AppWithContext } from "../../src/app.js";
import type { Context } from "../../src/runtime.js";
import { issueCertificate } from "../../src/domain/certificates.js";
import { createCombination, registerDevice } from "../../src/domain/devices.js";
import { confirmLend, requestLease } from "../../src/domain/leases.js";

export interface TestRig {
  app: AppWithContext;
  ctx: Context;
  dbPath: string;
  setNow(iso: string): void;
  now(): string;
}

export function makeApp(start = "2026-03-01T00:00:00Z", dbPath?: string): TestRig {
  let current = start;
  const resolved = dbPath ?? join(mkdtempSync(join(tmpdir(), "rig-")), "test.sqlite3");
  const app = buildApp({
    databasePath: resolved,
    recoveryIntervalMs: 0,
    now: () => current,
  });
  return {
    app,
    ctx: app.ctx,
    dbPath: resolved,
    setNow: (iso) => {
      current = iso;
    },
    now: () => current,
  };
}

export interface SeedIds {
  stationId: string;
  prismId: string;
  combinationId: string;
  stationCertId: string;
  prismCertId: string;
  leaseId: string;
}

/** 标准场景：全站仪+棱镜+组合+双证书+一班/A区/三月份租约（已出借）。 */
export function seedKit(ctx: Context): SeedIds {
  const station = registerDevice(ctx, {
    serialNumber: "TS-001",
    kind: "total_station",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  const prism = registerDevice(ctx, {
    serialNumber: "PR-001",
    kind: "prism",
    accuracyClass: "2.0mm",
    custodian: "老陈",
  });
  const combo = createCombination(ctx, {
    code: "C-1",
    accuracyClass: "2.0mm",
    items: [
      { serialNumber: "TS-001", role: "station" },
      { serialNumber: "PR-001", role: "prism" },
    ],
  });
  const stationCert = issueCertificate(ctx, {
    certificateNo: "CERT-TS-1",
    serialNumber: "TS-001",
    issuedAt: "2026-01-01T00:00:00Z",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
    accuracyClass: "2.0mm",
  });
  const prismCert = issueCertificate(ctx, {
    certificateNo: "CERT-PR-1",
    serialNumber: "PR-001",
    issuedAt: "2026-01-01T00:00:00Z",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
    accuracyClass: "2.0mm",
  });
  const lease = requestLease(ctx, {
    code: "L-1",
    crew: "一班",
    workArea: "A区",
    purpose: "桥墩位移观测",
    startsAt: "2026-03-01T00:00:00Z",
    endsAt: "2026-03-31T00:00:00Z",
    applicant: "小李",
    devices: [{ serialNumber: "TS-001" }, { serialNumber: "PR-001" }],
  });
  confirmLend(ctx, lease.id, "老陈", "小李");
  return {
    stationId: station.id,
    prismId: prism.id,
    combinationId: combo.id,
    stationCertId: stationCert.id,
    prismCertId: prismCert.id,
    leaseId: lease.id,
  };
}

export function goodObservation(packetId: string, observedAt: string, combinationId?: string) {
  return {
    packetId,
    observedAt,
    crew: "一班",
    workArea: "A区",
    requiredAccuracy: "2.0mm",
    combinationId,
    summary: "桥墩沉降观测",
    sequenceNo: `SEQ-${packetId}`,
    easting: 100.5,
    northing: 200.5,
    elevation: 10.2,
    devices: [
      { serialNumber: "TS-001", role: "station" },
      { serialNumber: "PR-001", role: "prism" },
    ],
  };
}
