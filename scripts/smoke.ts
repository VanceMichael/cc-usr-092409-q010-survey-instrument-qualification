/* 冒烟脚本：完整走一遍 登记→证书→租约→导入→签署→撤销→重评→解释 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";

let clock = "2026-03-01T00:00:00Z";
const app = buildApp({
  databasePath: join(mkdtempSync(join(tmpdir(), "smoke-")), "smoke.sqlite3"),
  recoveryIntervalMs: 0,
  now: () => clock,
});

const post = async (url: string, body: unknown): Promise<any> => {
  const res = await app.inject({ method: "POST", url, payload: body as never });
  if (res.statusCode >= 400) throw new Error(`${url} -> ${res.statusCode}: ${res.body}`);
  return res.json();
};

const ts = await post("/devices", {
  serialNumber: "TS-001", kind: "total_station", accuracyClass: "2.0mm", custodian: "老陈",
});
const prism = await post("/devices", {
  serialNumber: "PR-001", kind: "prism", accuracyClass: "2.0mm", custodian: "老陈",
});
const combo = await post("/combinations", {
  code: "C-1", accuracyClass: "2.0mm",
  items: [
    { serialNumber: "TS-001", role: "station" },
    { serialNumber: "PR-001", role: "prism" },
  ],
});
await post("/certificates", {
  certificateNo: "CERT-TS-1", serialNumber: "TS-001",
  issuedAt: "2026-01-01T00:00:00Z", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z",
  accuracyClass: "2.0mm",
});
await post("/certificates", {
  certificateNo: "CERT-PR-1", serialNumber: "PR-001",
  issuedAt: "2026-01-01T00:00:00Z", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z",
  accuracyClass: "2.0mm",
});
const lease = await post("/leases", {
  code: "L-1", crew: "一班", workArea: "A区", purpose: "桥墩位移观测",
  startsAt: "2026-03-01T00:00:00Z", endsAt: "2026-03-31T00:00:00Z", applicant: "小李",
  devices: [{ serialNumber: "TS-001" }, { serialNumber: "PR-001" }],
});
await post(`/leases/${lease.id}/lend`, { custodian: "老陈", pickupPerson: "小李" });

// 重叠租约应被原子拒绝
const overlap = await app.inject({
  method: "POST", url: "/leases",
  payload: {
    code: "L-2", crew: "二班", workArea: "B区", purpose: "另一组观测",
    startsAt: "2026-03-10T00:00:00Z", endsAt: "2026-03-20T00:00:00Z", applicant: "小王",
    devices: [{ serialNumber: "TS-001" }],
  } as never,
});
console.log("重叠租约:", overlap.statusCode, overlap.json().error?.code);

const obs = await post("/observations", {
  packetId: "P-1", observedAt: "2026-03-10T08:00:00Z", crew: "一班", workArea: "A区",
  requiredAccuracy: "2.0mm", combinationId: combo.id,
  summary: "桥墩沉降观测", sequenceNo: "S-100", easting: 100.5, northing: 200.5, elevation: 10.2,
  devices: [
    { serialNumber: "TS-001", role: "station" },
    { serialNumber: "PR-001", role: "prism" },
  ],
});
console.log("合格观测:", obs.status, obs.decision);

// 越区观测 → 待复核
const bad = await post("/observations", {
  packetId: "P-2", observedAt: "2026-03-12T08:00:00Z", crew: "一班", workArea: "B区",
  summary: "越区观测", sequenceNo: "S-101", easting: 1, northing: 2,
  devices: [
    { serialNumber: "TS-001", role: "station" },
    { serialNumber: "PR-001", role: "prism" },
  ],
});
console.log("越区观测:", bad.status, bad.decision, JSON.parse(bad.failure_reasons));

// 签署基线
const baseline = await post("/baselines", { code: "BL-1", componentMapping: { pier: "P7" } });
await post(`/baselines/${baseline.id}/sign`, { signer: "总工", observationIds: [obs.id] });

// 撤销证书：已签署的不动快照只加风险
const certs = (await app.inject({ method: "GET", url: "/certificates" })).json() as Array<{ id: string; certificate_no: string }>;
const tsCert = certs.find((c) => c.certificate_no === "CERT-TS-1")!;
const revoked = await post(`/certificates/${tsCert.id}/revoke`, { reason: "实验室溯源链断裂" });
console.log("撤销后: 重评", revoked.reevaluated, "风险", revoked.risksAppended);

const explain = (await app.inject({ method: "GET", url: `/observations/${obs.id}/explain` })).json() as Record<string, never>;
console.log("解释 keys:", Object.keys(explain).join(","));

await app.close();
console.log("SMOKE_OK");
