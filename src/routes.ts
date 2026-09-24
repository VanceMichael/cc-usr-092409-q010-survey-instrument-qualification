import type { FastifyInstance } from "fastify";

import type { Context } from "./runtime.js";
import { createBaseline, getBaseline, listBaselineItems, listBaselineRisks, listBaselines, acknowledgeRisk, signBaseline } from "./domain/baselines.js";
import { issueCertificate, listCertificates, revokeCertificate } from "./domain/certificates.js";
import { createCombination, getCombination, getCombinationItems, getDevice, listCombinations, listDevices, registerDevice } from "./domain/devices.js";
import { listDueTasks, reconcileDueTasks, recoverStaleTasks, runDueTasks } from "./domain/duetasks.js";
import { explainObservation } from "./domain/explain.js";
import { confirmHandoff, listHandoffs, recordHandoff } from "./domain/handoffs.js";
import { cancelLease, confirmLend, confirmReturn, getLease, getLeaseDevices, listLeases, rejectLease, requestLease } from "./domain/leases.js";
import { closeMaintenance, listMaintenance, openMaintenance } from "./domain/maintenance.js";
import { getObservation, getObservationDevices, importObservation, listObservations, reviewObservation } from "./domain/observations.js";

type Body = Record<string, unknown>;

function bodyOf(request: { body: unknown }): Body {
  return (request.body ?? {}) as Body;
}

function idOf(request: { params: unknown }): string {
  return (request.params as { id: string }).id;
}

export function registerRoutes(app: FastifyInstance, ctx: Context): void {
  // ---- 设备登记与组件组合 ----
  app.post("/devices", async (request) => registerDevice(ctx, bodyOf(request) as never));
  app.get("/devices", async () => listDevices(ctx));
  app.get("/devices/:id", async (request) => getDevice(ctx, idOf(request)));
  app.get("/devices/:id/handoffs", async (request) => listHandoffs(ctx, idOf(request)));
  app.post("/combinations", async (request) => createCombination(ctx, bodyOf(request) as never));
  app.get("/combinations", async () => listCombinations(ctx));
  app.get("/combinations/:id", async (request) => {
    const id = idOf(request);
    return { ...getCombination(ctx, id), items: getCombinationItems(ctx, id) };
  });

  // ---- 校准证书 ----
  app.post("/certificates", async (request) => issueCertificate(ctx, bodyOf(request) as never));
  app.get("/certificates", async (request) => {
    const query = request.query as { deviceId?: string };
    return listCertificates(ctx, query.deviceId);
  });
  app.post("/certificates/:id/revoke", async (request) =>
    revokeCertificate(ctx, idOf(request), String(bodyOf(request).reason ?? "")),
  );

  // ---- 维修状态 ----
  app.post("/maintenance/open", async (request) => openMaintenance(ctx, bodyOf(request) as never));
  app.post("/maintenance/:id/close", async (request) =>
    closeMaintenance(ctx, idOf(request), bodyOf(request) as never),
  );
  app.get("/maintenance", async (request) => {
    const query = request.query as { deviceId?: string };
    return listMaintenance(ctx, query.deviceId);
  });

  // ---- 借用链 ----
  app.post("/leases", async (request) => requestLease(ctx, bodyOf(request) as never));
  app.get("/leases", async (request) => {
    const query = request.query as { status?: string };
    return listLeases(ctx, query.status);
  });
  app.get("/leases/:id", async (request) => {
    const id = idOf(request);
    return { ...getLease(ctx, id), devices: getLeaseDevices(ctx, id) };
  });
  app.post("/leases/:id/lend", async (request) => {
    const body = bodyOf(request);
    return confirmLend(ctx, idOf(request), String(body.custodian ?? ""), body.pickupPerson as string | undefined);
  });
  app.post("/leases/:id/return", async (request) =>
    confirmReturn(ctx, idOf(request), String(bodyOf(request).returnConfirmer ?? "")),
  );
  app.post("/leases/:id/reject", async (request) =>
    rejectLease(ctx, idOf(request), String(bodyOf(request).reason ?? "")),
  );
  app.post("/leases/:id/cancel", async (request) => cancelLease(ctx, idOf(request)));

  // ---- 观测导入、复核与解释 ----
  app.post("/observations", async (request) => importObservation(ctx, bodyOf(request) as never));
  app.get("/observations", async (request) => {
    const query = request.query as { status?: string };
    return listObservations(ctx, query.status);
  });
  app.get("/observations/:id", async (request) => {
    const id = idOf(request);
    return { ...getObservation(ctx, id), devices: getObservationDevices(ctx, id) };
  });
  app.get("/observations/:id/explain", async (request) => explainObservation(ctx, idOf(request)));
  app.post("/observations/:id/review", async (request) =>
    reviewObservation(ctx, idOf(request), bodyOf(request) as never),
  );

  // ---- 基线签署与风险 ----
  app.post("/baselines", async (request) => createBaseline(ctx, bodyOf(request) as never));
  app.get("/baselines", async () => listBaselines(ctx));
  app.get("/baselines/:id", async (request) => {
    const id = idOf(request);
    return {
      ...getBaseline(ctx, id),
      items: listBaselineItems(ctx, id),
      risks: listBaselineRisks(ctx, id),
    };
  });
  app.post("/baselines/:id/sign", async (request) => {
    const body = bodyOf(request);
    return signBaseline(ctx, idOf(request), String(body.signer ?? ""), body.observationIds as string[] | undefined);
  });
  app.post("/risks/:id/acknowledge", async (request) =>
    acknowledgeRisk(ctx, idOf(request), String(bodyOf(request).acknowledgedBy ?? "")),
  );

  // ---- 离线交接（封签） ----
  app.post("/handoffs", async (request) => recordHandoff(ctx, bodyOf(request) as never));
  app.post("/handoffs/:id/confirm", async (request) =>
    confirmHandoff(ctx, idOf(request), String(bodyOf(request).confirmedBy ?? "")),
  );

  // ---- 停服恢复任务 ----
  app.get("/due-tasks", async (request) => {
    const query = request.query as { status?: string };
    return listDueTasks(ctx, query.status);
  });
  app.post("/recovery/run", async () => {
    const recovered = recoverStaleTasks(ctx);
    const reconciled = reconcileDueTasks(ctx);
    const run = runDueTasks(ctx);
    return { recovered, reconciled, run };
  });
}
