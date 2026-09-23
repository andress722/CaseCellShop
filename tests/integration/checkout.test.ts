import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  insertProduct,
  cleanupTestData,
  uniquePrefix,
} from "../helpers.js";

describe("checkout API", () => {
  const prefix = uniquePrefix();
  const productId = `${prefix}-product`;
  let ctx: Awaited<ReturnType<typeof createTestContext>>;

  beforeAll(async () => {
    ctx = await createTestContext();
    await insertProduct(ctx.database, productId, 10);
  });
  afterAll(async () => {
    await cleanupTestData(ctx.database, prefix, [productId]);
    await ctx.close();
  });

  const body = (id: string, quantity = 1) => ({
    items: [{ productId: id, quantity }],
  });
  const checkout = (key: string, payload: object) =>
    ctx.app.inject({
      method: "POST",
      url: "/checkout",
      headers: { "idempotency-key": key },
      payload,
    });

  it("requires a key and validates items", async () => {
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/checkout",
      payload: body(productId),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const invalid = await checkout(`${prefix}-invalid`, body(productId, 0));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns a stable order for retries and conflicts on a changed payload", async () => {
    const key = `${prefix}-replay`;
    const catalogBefore = await ctx.app.inject("/products");
    const beforeAvailable = catalogBefore
      .json()
      .items.find((item: { id: string }) => item.id === productId).available;
    const first = await checkout(key, body(productId));
    const second = await checkout(key, body(productId));
    const conflict = await checkout(key, body(productId, 2));
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().orderId).toBe(first.json().orderId);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const orders = await ctx.database.query(
      "SELECT id FROM orders WHERE idempotency_key = $1",
      [key],
    );
    const outbox = await ctx.database.query(
      "SELECT id FROM outbox_events WHERE aggregate_id = $1",
      [first.json().orderId],
    );
    expect(orders.rowCount).toBe(1);
    expect(outbox.rowCount).toBe(1);
    const catalogAfter = await ctx.app.inject("/products");
    const afterAvailable = catalogAfter
      .json()
      .items.find((item: { id: string }) => item.id === productId).available;
    expect(afterAvailable).toBe(beforeAvailable - 1);
    const status = await ctx.app.inject(
      `/orders/${first.json().orderId}/status`,
    );
    expect(status.json().status).toBe("PENDING");
    const metrics = await ctx.app.inject("/metrics");
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("checkout_idempotent_replays_total");
    const contract = await ctx.app.inject("/docs/json");
    expect(
      contract.json().paths["/checkout"].post.responses["202"],
    ).toBeTruthy();
  });

  it("returns typed errors for missing product and insufficient stock", async () => {
    const missing = await checkout(
      `${prefix}-missing`,
      body(`${prefix}-absent`),
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("PRODUCT_NOT_FOUND");
    const stock = await checkout(`${prefix}-stock`, body(productId, 100));
    expect(stock.statusCode).toBe(409);
    expect(stock.json().error.code).toBe("OUT_OF_STOCK");
    const unknownOrder = await ctx.app.inject("/orders/unknown/status");
    expect(unknownOrder.statusCode).toBe(404);
  });

  it("rolls back every reservation and outbox insert when a later item fails", async () => {
    const key = `${prefix}-rollback`;
    const outboxBefore = await ctx.database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_events",
    );
    const before = await ctx.database.query<{
      available: number;
      reserved: number;
    }>("SELECT available, reserved FROM inventory WHERE product_id = $1", [
      productId,
    ]);
    const result = await checkout(key, {
      items: [
        { productId, quantity: 1 },
        { productId: `${prefix}-missing`, quantity: 1 },
      ],
    });
    expect(result.statusCode).toBe(404);
    const after = await ctx.database.query<{
      available: number;
      reserved: number;
    }>("SELECT available, reserved FROM inventory WHERE product_id = $1", [
      productId,
    ]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const orders = await ctx.database.query(
      "SELECT id FROM orders WHERE idempotency_key = $1",
      [key],
    );
    expect(orders.rowCount).toBe(0);
    const outboxAfter = await ctx.database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_events",
    );
    expect(outboxAfter.rows[0]?.count).toBe(outboxBefore.rows[0]?.count);
  });
});
