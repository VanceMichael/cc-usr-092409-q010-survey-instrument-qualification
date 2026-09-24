import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "migrations"), // 开发：src/ → 仓库根
    join(here, "..", "..", "migrations"), // 构建产物：dist/src/ → 应用根
    join(process.cwd(), "migrations"), // 兜底：工作目录
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[2];
}

/** 顺序应用 migrations/*.sql，已应用的跳过（schema_migrations 记录）。 */
export function runMigrations(db: DatabaseSync, dir: string = defaultMigrationsDir()): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied: string[] = [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const exists = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(file);
    if (exists) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(join(dir, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(file);
      db.exec("COMMIT");
      applied.push(file);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return applied;
}
