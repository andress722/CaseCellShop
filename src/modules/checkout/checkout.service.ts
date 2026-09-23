import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HttpError } from "../../shared/errors.js";
import type { Metrics } from "../../observability/metrics.js";
import { traceCarrier, withSpan } from "../../observability/tracing.js";

export const checkoutInput = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1).max(128),
        quantity: z.number().int().positive().max(1000),
      }),
    )
    .min(1)
    .max(20),
});

export type CheckoutInput = z.infer<typeof checkoutInput>;
export type OrderStatus =
  | "PENDING"
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export interface CheckoutResult {
  orderId: string;
  status: OrderStatus;
  replay: boolean;
}

interface ExistingOrder {
  id: string;
  status: OrderStatus;
  request_hash: string;
}

interface ReservedProduct {
  product_id: string;
  price_cents: number;
}

export class CheckoutService {
  constructor(
    private readonly database: Pool,
    private readonly metrics: Metrics,
    private readonly invalidateCatalog: () => Promise<void> = async () => {},
  ) {}

  async create(input: CheckoutInput, key: string): Promise<CheckoutResult> {
    const ids = input.items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Duplicate productId in items",
      );
    }
    const items = [...input.items].sort((a, b) =>
      a.productId.localeCompare(b.productId),
    );
    const hash = createHash("sha256")
      .update(JSON.stringify(items))
      .digest("hex");
    const stopTimer = this.metrics.checkoutDuration.startTimer();
    try {
      return await withSpan("checkout.create", async () => {
        const client = await this.database.connect();
        try {
          await client.query("BEGIN");
          const result = await withSpan("db.transaction", () =>
            this.createInTransaction(client, items, key, hash),
          );
          await client.query("COMMIT");
          if (!result.replay) {
            try {
              await this.invalidateCatalog();
            } catch {
              // A cache failure cannot undo an accepted transaction; the TTL bounds staleness.
            }
          }
          this.metrics.checkoutRequests.inc({
            result: result.replay ? "replay" : "accepted",
          });
          if (result.replay) this.metrics.checkoutReplays.inc();
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          this.metrics.checkoutRequests.inc({
            result: error instanceof HttpError ? error.code : "error",
          });
          if (error instanceof HttpError && error.code === "OUT_OF_STOCK")
            this.metrics.checkoutOutOfStock.inc();
          throw error;
        } finally {
          client.release();
        }
      });
    } finally {
      stopTimer();
    }
  }

  private async createInTransaction(
    client: PoolClient,
    items: CheckoutInput["items"],
    key: string,
    hash: string,
  ): Promise<CheckoutResult> {
    await withSpan("idempotency.lookup", async () => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [key],
      );
    });
    const prior = await client.query<ExistingOrder>(
      "SELECT id, status, request_hash FROM orders WHERE idempotency_key = $1",
      [key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key already used with different items",
        );
      }
      return {
        orderId: prior.rows[0].id,
        status: prior.rows[0].status,
        replay: true,
      };
    }

    const orderId = `ord_${randomUUID()}`;
    let totalCents = 0;
    const reserved: Array<{
      productId: string;
      quantity: number;
      priceCents: number;
    }> = [];
    for (const item of items) {
      const result = await withSpan("inventory.reserve", () =>
        client.query<ReservedProduct>(
          `UPDATE inventory AS i
           SET available = i.available - $2, reserved = i.reserved + $2,
               version = i.version + 1, updated_at = now()
           FROM products AS p
           WHERE i.product_id = $1 AND p.id = i.product_id AND i.available >= $2
           RETURNING i.product_id, p.price_cents`,
          [item.productId, item.quantity],
        ),
      );
      if (!result.rows[0]) {
        const product = await client.query(
          "SELECT 1 FROM products WHERE id = $1",
          [item.productId],
        );
        throw product.rowCount
          ? new HttpError(409, "OUT_OF_STOCK", "Insufficient stock")
          : new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
      }
      const priceCents = result.rows[0].price_cents;
      totalCents += priceCents * item.quantity;
      reserved.push({
        productId: item.productId,
        quantity: item.quantity,
        priceCents,
      });
    }
    if (!Number.isSafeInteger(totalCents) || totalCents > 2_147_483_647) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Order total exceeds supported limit",
      );
    }

    await withSpan("order.insert", async () => {
      await client.query(
        `INSERT INTO orders (id, status, total_cents, idempotency_key, request_hash)
         VALUES ($1, 'PENDING', $2, $3, $4)`,
        [orderId, totalCents, key, hash],
      );
      for (const item of reserved) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, unit_price_cents, quantity, subtotal_cents)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            orderId,
            item.productId,
            item.priceCents,
            item.quantity,
            item.priceCents * item.quantity,
          ],
        );
      }
    });
    await withSpan("outbox.insert", async () => {
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload_json)
         VALUES ('order', $1, 'order.created', $2::jsonb)`,
        [orderId, JSON.stringify({ orderId, trace: traceCarrier() })],
      );
    });
    return { orderId, status: "PENDING", replay: false };
  }
}
