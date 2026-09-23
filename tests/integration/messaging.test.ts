import { randomUUID } from "node:crypto";
import { Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeErpAdapter } from "../../src/integrations/erp/fake-erp.adapter.js";
import { CheckoutService } from "../../src/modules/checkout/checkout.service.js";
import {
  OrderProcessor,
  type OrderJob,
} from "../../src/messaging/order.processor.js";
import { OutboxDispatcher } from "../../src/messaging/outbox.dispatcher.js";
import { Reconciler } from "../../src/messaging/reconciliation.worker.js";
import {
  config,
  createTestContext,
  insertProduct,
  cleanupTestData,
  uniquePrefix,
} from "../helpers.js";

describe("outbox, worker and reconciliation", () => {
  const prefix = uniquePrefix();
  const productId = `${prefix}-product`;
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  let connection: Redis;
  let queue: Queue<OrderJob>;
  let dlq: Queue;
  let checkout: CheckoutService;
  let orderNumber = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
    await insertProduct(ctx.database, productId, 10);
    connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<OrderJob>(`test-orders-${randomUUID()}`, { connection });
    dlq = new Queue(`test-dlq-${randomUUID()}`, { connection });
    checkout = new CheckoutService(ctx.database, ctx.metrics);
  });

  afterAll(async () => {
    await Promise.all([
      queue.obliterate({ force: true }),
      dlq.obliterate({ force: true }),
    ]);
    await Promise.all([queue.close(), dlq.close()]);
    connection.disconnect();
    await cleanupTestData(ctx.database, prefix, [productId]);
    await ctx.close();
  });

  async function createOrder() {
    orderNumber++;
    return checkout.create(
      { items: [{ productId, quantity: 1 }] },
      `${prefix}-${orderNumber}`,
    );
  }

  function fakeJob(orderId: string, attempts = 3, attemptsMade = 0) {
    return {
      id: `test-job-${orderId}`,
      data: { orderId },
      opts: { attempts },
      attemptsMade,
    } as Job<OrderJob>;
  }

  it("publishes outbox once and safely republishes the same event", async () => {
    const order = await createOrder();
    const dispatcher = new OutboxDispatcher(ctx.database, queue, ctx.app.log);
    await dispatcher.dispatchOnce();
    const event = await ctx.database.query<{ id: string; published_at: Date }>(
      "SELECT id::text, published_at FROM outbox_events WHERE aggregate_id = $1",
      [order.orderId],
    );
    expect(event.rows[0]?.published_at).toBeInstanceOf(Date);
    expect(await queue.getJob(`outbox-${event.rows[0]?.id}`)).toBeTruthy();
    await ctx.database.query(
      "UPDATE outbox_events SET published_at = NULL WHERE aggregate_id = $1",
      [order.orderId],
    );
    await dispatcher.dispatchOnce();
    const jobs = await queue.getJobs([
      "waiting",
      "active",
      "completed",
      "failed",
    ]);
    expect(
      jobs.filter((job) => job.id === `outbox-${event.rows[0]?.id}`),
    ).toHaveLength(1);
  });

  it("keeps the outbox pending when publication fails", async () => {
    const order = await createOrder();
    const failingQueue = {
      async add() {
        throw new Error("Redis unavailable");
      },
    } as unknown as Queue<OrderJob>;
    const dispatcher = new OutboxDispatcher(
      ctx.database,
      failingQueue,
      ctx.app.log,
    );
    await expect(dispatcher.dispatchOnce()).rejects.toThrow(
      "Redis unavailable",
    );
    const event = await ctx.database.query<{ published_at: Date | null }>(
      "SELECT published_at FROM outbox_events WHERE aggregate_id = $1",
      [order.orderId],
    );
    const status = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(event.rows[0]?.published_at).toBeNull();
    expect(status.rows[0]?.status).toBe("PENDING");
  });

  it("survives accept-then-timeout and duplicate delivery without duplicate billing", async () => {
    const order = await createOrder();
    const erp = new FakeErpAdapter(
      ctx.database,
      { ...config, ERP_BILLING_MODE: "accept_then_timeout" },
      ctx.metrics,
    );
    const processor = new OrderProcessor(
      ctx.database,
      erp,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await expect(processor.process(fakeJob(order.orderId))).rejects.toThrow();
    await processor.process(fakeJob(order.orderId, 3, 1));
    await processor.process(fakeJob(order.orderId, 3, 2));
    const invoice = await ctx.database.query(
      "SELECT order_id FROM erp_invoices WHERE order_id = $1",
      [order.orderId],
    );
    const status = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(invoice.rowCount).toBe(1);
    expect(status.rows[0]?.status).toBe("COMPLETED");
  });

  it("completes a normal invoice and settles reserved stock", async () => {
    const order = await createOrder();
    const erp = new FakeErpAdapter(ctx.database, config, ctx.metrics);
    const processor = new OrderProcessor(
      ctx.database,
      erp,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    const before = await ctx.database.query<{ reserved: number }>(
      "SELECT reserved FROM inventory WHERE product_id = $1",
      [productId],
    );
    await processor.process(fakeJob(order.orderId));
    const after = await ctx.database.query<{ reserved: number }>(
      "SELECT reserved FROM inventory WHERE product_id = $1",
      [productId],
    );
    expect(after.rows[0]!.reserved).toBe(before.rows[0]!.reserved - 1);
    const status = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(status.rows[0]?.status).toBe("COMPLETED");
  });

  it("reconciles an accepted invoice after the response times out", async () => {
    const order = await createOrder();
    const erp = new FakeErpAdapter(
      ctx.database,
      { ...config, ERP_BILLING_MODE: "accept_then_timeout" },
      ctx.metrics,
    );
    const processor = new OrderProcessor(
      ctx.database,
      erp,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await expect(
      processor.process(fakeJob(order.orderId, 1)),
    ).rejects.toThrow();
    const reconciler = new Reconciler(
      ctx.database,
      erp,
      processor,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await reconciler.runOnce();
    const invoice = await ctx.database.query(
      "SELECT order_id FROM erp_invoices WHERE order_id = $1",
      [order.orderId],
    );
    const status = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(invoice.rowCount).toBe(1);
    expect(status.rows[0]?.status).toBe("COMPLETED");
  });

  it("sends permanent failures to DLQ and releases reserved stock", async () => {
    const order = await createOrder();
    const erp = new FakeErpAdapter(
      ctx.database,
      { ...config, ERP_BILLING_MODE: "error" },
      ctx.metrics,
    );
    const processor = new OrderProcessor(
      ctx.database,
      erp,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await expect(processor.process(fakeJob(order.orderId))).rejects.toThrow();
    const status = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(status.rows[0]?.status).toBe("FAILED");
    expect(await dlq.getJob(`dlq-${order.orderId}`)).toBeTruthy();
  });

  it("reconciles an ambiguous timeout with a definitive ERP lookup", async () => {
    const order = await createOrder();
    const erp = new FakeErpAdapter(
      ctx.database,
      { ...config, ERP_BILLING_MODE: "timeout", ERP_TIMEOUT_MS: 10 },
      ctx.metrics,
    );
    const processor = new OrderProcessor(
      ctx.database,
      erp,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await expect(
      processor.process(fakeJob(order.orderId, 1)),
    ).rejects.toThrow();
    const uncertain = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(uncertain.rows[0]?.status).toBe("RECONCILIATION_REQUIRED");
    const reconciler = new Reconciler(
      ctx.database,
      erp,
      processor,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await reconciler.runOnce();
    const resolved = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(resolved.rows[0]?.status).toBe("FAILED");
  });

  it("reconciles a stale processing order", async () => {
    const order = await createOrder();
    await ctx.database.query(
      "UPDATE orders SET status = 'PROCESSING', updated_at = now() - interval '1 minute' WHERE id = $1",
      [order.orderId],
    );
    const erp = new FakeErpAdapter(ctx.database, config, ctx.metrics);
    const processor = new OrderProcessor(
      ctx.database,
      erp,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    const reconciler = new Reconciler(
      ctx.database,
      erp,
      processor,
      dlq,
      ctx.metrics,
      ctx.app.log,
    );
    await reconciler.runOnce();
    const resolved = await ctx.database.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1",
      [order.orderId],
    );
    expect(resolved.rows[0]?.status).toBe("FAILED");
  });
});
