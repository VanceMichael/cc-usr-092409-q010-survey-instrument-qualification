import { openDatabase } from "../src/database.js";
import { runMigrations } from "../src/migrate.js";

const database = openDatabase();
const applied = runMigrations(database);
for (const file of applied) {
  console.log(`applied ${file}`);
}
if (applied.length === 0) {
  console.log("no pending migrations");
}
database.close();
