import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { buildApp } from "../src/app/app.js";
import { parseConfig } from "../src/app/config.js";
import { createMetrics } from "../src/observability/metrics.js";

export const config = parseConfig({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://casecellshop:casecellshop@localhost:5432/casecellshop",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
  LOG_LEVEL: "silent",
  NODE_ENV: "test",
  BACKGROUND_ENABLED: "false",
});

export function uniquePrefix() {
  return `test-${randomUUID()}`;
}

export async function createTestContext() {
  const database = new Pool({ connectionString: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const metrics = createMetrics();
  const app = await buildApp(
    config,
    {
      async checkDatabase() {
        await database.query("SELECT 1");
      },
      async checkRedis() {
        await redis.ping();
      },
    },
    { database, redis, metrics },
  );
  return {
    database,
    redis,
    metrics,
    app,
    async close() {
      await app.close();
      await Promise.all([database.end(), redis.quit()]);
    },
  };
}

export async function insertProduct(database: Pool, id: string, stock: number) {
  await database.query(
    "INSERT INTO products (id, name, price_cents, source_updated_at) VALUES ($1, $2, 7990, now())",
    [id, `Test ${id}`],
  );
  await database.query(
    "INSERT INTO inventory (product_id, available) VALUES ($1, $2)",
    [id, stock],
  );
}

export async function cleanupTestData(
  database: Pool,
  prefix: string,
  productIds: string[],
) {
  const pattern = `${prefix}%`;
  await database.query(
    "DELETE FROM erp_invoices WHERE order_id IN (SELECT id FROM orders WHERE idempotency_key LIKE $1)",
    [pattern],
  );
  await database.query(
    "DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM orders WHERE idempotency_key LIKE $1)",
    [pattern],
  );
  await database.query(
    "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE idempotency_key LIKE $1)",
    [pattern],
  );
  await database.query("DELETE FROM orders WHERE idempotency_key LIKE $1", [
    pattern,
  ]);
  await database.query("DELETE FROM inventory WHERE product_id = ANY($1)", [
    productIds,
  ]);
  await database.query("DELETE FROM products WHERE id = ANY($1)", [productIds]);
}
