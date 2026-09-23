import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { parseConfig } from "../src/app/config.js";

const config = parseConfig(process.env);
const pool = new Pool({ connectionString: config.DATABASE_URL });
const migrationsDirectory = fileURLToPath(
  new URL("../db/migrations/", import.meta.url),
);

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(75234901)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of files) {
      const exists = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [name],
      );
      if (exists.rowCount) continue;
      const sql = await readFile(join(migrationsDirectory, name), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        name,
      ]);
      process.stdout.write(`Applied ${name}\n`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  process.stderr.write(`Migration failed: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
