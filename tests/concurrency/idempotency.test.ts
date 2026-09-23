import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  cleanupTestData,
  createTestContext,
  insertProduct,
  uniquePrefix,
} from "../helpers.js";

describe("concurrent idempotency", () => {
  const prefix = uniquePrefix();
  const replayProduct = `${prefix}-replay-product`;
  const conflictProduct = `${prefix}-conflict-product`;
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeAll(async () => {
    ctx = await createTestContext();
    await insertProduct(ctx.database, replayProduct, 5);
    await insertProduct(ctx.database, conflictProduct, 5);
  });

  afterAll(async () => {
    await cleanupTestData(ctx.database, prefix, [
      replayProduct,
      conflictProduct,
    ]);
    await ctx.close();
  });

  async function waitForBlockedCheckouts(expected: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await ctx.database.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND wait_event = 'advisory'
           AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'`,
      );
      if ((result.rows[0]?.waiting ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Expected ${expected} checkouts blocked on the advisory lock`,
    );
  }

  async function holdKeyLock(
    key: string,
  ): Promise<{ release: () => Promise<void> }> {
    const client: PoolClient = await ctx.database.connect();
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1::text, 0))",
      [key],
    );
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
            [key],
          );
        } finally {
          client.release();
        }
      },
    };
  }

  const checkout = (key: string, productId: string, quantity: number) =>
    ctx.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": key },
      payload: { items: [{ productId, quantity }] },
    });

  it("replays one order and reserves stock once for simultaneous identical requests", async () => {
    const key = `${prefix}-same-key`;
    const lock = await holdKeyLock(key);
    let responses: Awaited<ReturnType<typeof checkout>>[];
    let pending: ReturnType<typeof checkout>[] = [];
    try {
      pending = Array.from({ length: 4 }, () =>
        checkout(key, replayProduct, 2),
      );
      await waitForBlockedCheckouts(4);
      await lock.release();
      responses = await Promise.all(pending);
    } finally {
      await lock.release();
      await Promise.allSettled(pending);
    }

    expect(responses.every((response) => response.statusCode === 202)).toBe(
      true,
    );
    const orderIds = new Set(
      responses.map((response) => response.json().orderId as string),
    );
    expect(orderIds.size).toBe(1);
    const orderId = [...orderIds][0];
    const orders = await ctx.database.query(
      "SELECT id FROM orders WHERE idempotency_key = $1",
      [key],
    );
    const outbox = await ctx.database.query(
      "SELECT id FROM outbox_events WHERE aggregate_id = $1",
      [orderId],
    );
    const stock = await ctx.database.query<{
      available: number;
      reserved: number;
      version: number;
    }>(
      "SELECT available, reserved, version FROM inventory WHERE product_id = $1",
      [replayProduct],
    );
    expect(orders.rowCount).toBe(1);
    expect(outbox.rowCount).toBe(1);
    expect(stock.rows[0]).toMatchObject({
      available: 3,
      reserved: 2,
      version: 1,
    });
  });

  it("accepts one payload and conflicts the other for the same concurrent key", async () => {
    const key = `${prefix}-different-payloads`;
    const lock = await holdKeyLock(key);
    let responses: Awaited<ReturnType<typeof checkout>>[];
    let pending: ReturnType<typeof checkout>[] = [];
    try {
      pending = [
        checkout(key, conflictProduct, 1),
        checkout(key, conflictProduct, 2),
      ];
      await waitForBlockedCheckouts(2);
      await lock.release();
      responses = await Promise.all(pending);
    } finally {
      await lock.release();
      await Promise.allSettled(pending);
    }

    const accepted = responses.filter(
      (response) => response.statusCode === 202,
    );
    const rejected = responses.filter(
      (response) => response.statusCode === 409,
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const orderId = accepted[0]?.json().orderId as string;
    const orders = await ctx.database.query(
      "SELECT id FROM orders WHERE idempotency_key = $1",
      [key],
    );
    const outbox = await ctx.database.query(
      "SELECT id FROM outbox_events WHERE aggregate_id = $1",
      [orderId],
    );
    const items = await ctx.database.query<{ quantity: number }>(
      "SELECT quantity FROM order_items WHERE order_id = $1",
      [orderId],
    );
    const quantity = items.rows[0]?.quantity;
    const stock = await ctx.database.query<{
      available: number;
      reserved: number;
      version: number;
    }>(
      "SELECT available, reserved, version FROM inventory WHERE product_id = $1",
      [conflictProduct],
    );
    expect(orders.rowCount).toBe(1);
    expect(outbox.rowCount).toBe(1);
    expect([1, 2]).toContain(quantity);
    expect(stock.rows[0]).toMatchObject({
      available: 5 - quantity!,
      reserved: quantity,
      version: 1,
    });
  });
});
