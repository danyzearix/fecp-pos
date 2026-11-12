// npm run db:setup  -> ejecuta db/schema.sql en DATABASE_URL
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("Falta DATABASE_URL en .env.local");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "schema.sql"), "utf8");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query(sql);
  console.log("OK: tablas creadas/verificadas.");
} catch (e) {
  console.error("Error ejecutando el esquema:", e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
