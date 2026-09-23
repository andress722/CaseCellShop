import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  insertProduct,
  cleanupTestData,
  uniquePrefix,
} from "../helpers.js";

describe("concurrent checkout", () => {
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

  it("accepts exactly 10 of 20 buyers for 10 units", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ctx.app.inject({
          method: "POST",
          url: "/checkout",
          headers: { "idempotency-key": `${prefix}-${index}` },
          payload: { items: [{ productId, quantity: 1 }] },
        }),
      ),
    );
    expect(
      responses.filter((response) => response.statusCode === 202),
    ).toHaveLength(10);
    expect(
      responses.filter(
        (response) =>
          response.statusCode === 409 &&
          response.json().error.code === "OUT_OF_STOCK",
      ),
    ).toHaveLength(10);
    const stock = await ctx.database.query<{
      available: number;
      reserved: number;
    }>("SELECT available, reserved FROM inventory WHERE product_id = $1", [
      productId,
    ]);
    expect(stock.rows[0]).toMatchObject({ available: 0, reserved: 10 });
    const orders = await ctx.database.query(
      "SELECT id FROM orders WHERE idempotency_key LIKE $1",
      [`${prefix}%`],
    );
    expect(orders.rowCount).toBe(10);
  });
});
