import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { fail } from "./errors.js";

export interface Context {
  readonly db: DatabaseSync;
  now(): string;
  newId(prefix: string): string;
}

export function createContext(db: DatabaseSync, now?: () => string): Context {
  return {
    db,
    now: now ?? (() => new Date().toISOString()),
    newId: (prefix) => `${prefix}_${randomUUID()}`,
  };
}

/** IMMEDIATE 事务：立刻取得保留锁，配合触发器让并发写入串行化裁决。 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** SQLite 约束错误翻译成领域错误；重叠租约触发器带 OVERLAPPING_LEASE 前缀。 */
export function mapSqliteError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message;
  if (message.includes("OVERLAPPING_LEASE")) {
    return fail.overlap("同一设备的时间窗与既有租约重叠，已原子拒绝", { sqlite: message });
  }
  if (message.includes("UNIQUE constraint failed")) {
    return fail.conflict("唯一性约束冲突", { sqlite: message });
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    return fail.validation("引用的记录不存在", { sqlite: message });
  }
  return error;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function parseIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw fail.validation(`${field} 必须是 UTC ISO8601 时间`);
  }
  return value;
}

/** 精度等级按毫米解析，如 "2.0mm" → 2。 */
export function parseAccuracyMm(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*mm\s*$/i.exec(value);
  return match ? Number(match[1]) : null;
}

export function requireAccuracy(value: unknown, field: string): string {
  if (typeof value !== "string" || parseAccuracyMm(value) === null) {
    throw fail.validation(`${field} 必须是形如 "2.0mm" 的精度等级`);
  }
  return value;
}
