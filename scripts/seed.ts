import { Pool } from "pg";
import { parseConfig } from "../src/app/config.js";

const config = parseConfig(process.env);
const pool = new Pool({ connectionString: config.DATABASE_URL });

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO products (id, name, price_cents, source_updated_at)
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      ["case-iphone-15-black", "Case iPhone 15 Black", 7990],
    );
    await client.query(
      `INSERT INTO inventory (product_id, available)
       VALUES ($1, $2) ON CONFLICT (product_id) DO NOTHING`,
      ["case-iphone-15-black", 10],
    );
    await client.query("COMMIT");
    process.stdout.write("Seed complete\n");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  process.stderr.write(`Seed failed: ${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
