import type { DatabaseSync } from "node:sqlite";

export type Param = string | number | null;

export function get<T>(db: DatabaseSync, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: DatabaseSync, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** 在同一事务内执行 fn, 提交或回滚; 用于租约创建等需要原子检查-写入的场景。 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务已经结束
    }
    throw error;
  }
}

export function addEvent(db: DatabaseSync, observationId: string, event: string, detail: string): void {
  db.prepare("INSERT INTO observation_events(observation_id, event, detail) VALUES (?,?,?)").run(observationId, event, detail);
}

export function ensureTask(db: DatabaseSync, id: string, type: string, refId: string, detail: string): void {
  db.prepare("INSERT OR IGNORE INTO tasks(id, type, ref_id, detail) VALUES (?,?,?,?)").run(id, type, refId, detail);
}

export function completeTask(db: DatabaseSync, id: string, doneAt: string): void {
  db.prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'pending'").run(doneAt, id);
}

export interface InstrumentRow {
  id: string;
  serial_no: string;
  kind: string;
  custodian: string;
  status: string;
  version: number;
}

export interface CertificateRow {
  id: string;
  cert_no: string;
  instrument_id: string;
  precision_class: string;
  valid_from: string;
  valid_until: string;
  status: string;
  revoked_reason: string | null;
  version: number;
}

export interface LeaseRow {
  id: string;
  instrument_id: string;
  crew: string;
  borrower: string;
  zone: string;
  purpose: string;
  window_start: string;
  window_end: string;
  state: string;
  lent_confirmed_by: string | null;
  lent_at: string | null;
  returned_confirmed_by: string | null;
  returned_at: string | null;
  version: number;
}

export interface ObservationRow {
  id: string;
  instrument_id: string;
  component_set_id: string | null;
  observed_at: string;
  zone: string;
  required_precision: string;
  payload: string;
  status: string;
  decision_reasons: string;
  instrument_version: number;
  certificate_id: string | null;
  certificate_version: number | null;
  lease_id: string | null;
  lease_version: number | null;
  imported_at: string;
  adjudicated_at: string | null;
  adjudicated_by: string | null;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** 观测导入时冻结的设备/证书/租约版本 + 当前可解析的登记信息, 用于签署快照与解释查询。 */
export function buildQualificationSnapshot(db: DatabaseSync, observation: ObservationRow) {
  const instrument = get<InstrumentRow>(db, "SELECT * FROM instruments WHERE id = ?", observation.instrument_id);
  const certificate = observation.certificate_id
    ? get<CertificateRow>(db, "SELECT * FROM certificates WHERE id = ?", observation.certificate_id)
    : undefined;
  const lease = observation.lease_id
    ? get<LeaseRow>(db, "SELECT * FROM leases WHERE id = ?", observation.lease_id)
    : undefined;
  let componentSet: { id: string; name: string; members: string[] } | null = null;
  if (observation.component_set_id) {
    const set = get<{ id: string; name: string }>(db, "SELECT * FROM component_sets WHERE id = ?", observation.component_set_id);
    if (set) {
      const members = all<{ serial_no: string }>(
        db,
        `SELECT i.serial_no FROM component_set_members m JOIN instruments i ON i.id = m.instrument_id WHERE m.set_id = ?`,
        set.id,
      );
      componentSet = { id: set.id, name: set.name, members: members.map((member) => member.serial_no) };
    }
  }
  return {
    instrument: instrument && {
      id: instrument.id,
      serial_no: instrument.serial_no,
      kind: instrument.kind,
      custodian: instrument.custodian,
      version: observation.instrument_version,
    },
    certificate: certificate && {
      id: certificate.id,
      cert_no: certificate.cert_no,
      precision_class: certificate.precision_class,
      valid_from: certificate.valid_from,
      valid_until: certificate.valid_until,
      status: certificate.status,
      version: observation.certificate_version,
    },
    lease: lease && {
      id: lease.id,
      crew: lease.crew,
      borrower: lease.borrower,
      zone: lease.zone,
      purpose: lease.purpose,
      window_start: lease.window_start,
      window_end: lease.window_end,
      state: lease.state,
      version: observation.lease_version,
    },
    component_set: componentSet,
  };
}
