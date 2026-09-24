import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? "data/bridge_baselines.sqlite3";
}

export function openDatabase(path?: string): DatabaseSync {
  const resolved = path ?? databasePath();
  mkdirSync(dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return database;
}
