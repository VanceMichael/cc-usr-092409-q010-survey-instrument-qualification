import { openDatabase } from "../src/database.js";
import { applyMigrations } from "../src/migrate.js";

const database = openDatabase();
const applied = applyMigrations(database);
console.log(applied.length > 0 ? `已应用迁移: ${applied.join(", ")}` : "没有待应用的迁移");
database.close();
