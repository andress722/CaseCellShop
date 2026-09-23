import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../app/config.js";
import { FakeErpAdapter } from "../integrations/erp/fake-erp.adapter.js";
import type { Metrics } from "../observability/metrics.js";
import { OrderProcessor, type OrderJob } from "./order.processor.js";
import { OutboxDispatcher } from "./outbox.dispatcher.js";
import { Reconciler } from "./reconciliation.worker.js";

export function startBackground(
  config: Config,
  database: Pool,
  metrics: Metrics,
  logger: FastifyBaseLogger,
) {
  const workerConnection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  const queueConnection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
  });
  const orderQueue = new Queue<OrderJob>("order-created", {
    connection: queueConnection,
  });
  const dlq = new Queue("order-deadletter", { connection: queueConnection });
  orderQueue.on("error", (error) =>
    logger.error(
      { event: "order.queue.error", err: error },
      "Order queue error",
    ),
  );
  dlq.on("error", (error) =>
    logger.error({ event: "order.dlq.error", err: error }, "DLQ error"),
  );
  const erp = new FakeErpAdapter(database, config, metrics);
  const processor = new OrderProcessor(database, erp, dlq, metrics, logger);
  const dispatcher = new OutboxDispatcher(database, orderQueue, logger);
  const reconciler = new Reconciler(
    database,
    erp,
    processor,
    dlq,
    metrics,
    logger,
  );
  const worker = new Worker<OrderJob>(
    "order-created",
    (job) => processor.process(job),
    {
      connection: workerConnection,
      concurrency: 4,
    },
  );
  worker.on("error", (error) =>
    logger.error({ event: "order.worker.error", err: error }, "Worker error"),
  );

  let dispatching = false;
  const dispatchTimer = setInterval(() => {
    if (dispatching) return;
    dispatching = true;
    void dispatcher
      .dispatchOnce()
      .catch((error: unknown) =>
        logger.error(
          { event: "outbox.dispatch.failed", err: error },
          "Outbox dispatch failed",
        ),
      )
      .finally(() => {
        dispatching = false;
      });
  }, 250);
  let reconciling = false;
  const reconcileTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconciler
      .runOnce()
      .catch((error: unknown) =>
        logger.error(
          { event: "reconciliation.failed", err: error },
          "Reconciliation failed",
        ),
      )
      .finally(() => {
        reconciling = false;
      });
  }, 10_000);
  const metricsTimer = setInterval(() => {
    void Promise.all([
      orderQueue.getJobCounts("waiting", "active"),
      dlq.getJobCounts("waiting", "failed"),
    ])
      .then(([orders, dead]) => {
        metrics.queueDepth.set((orders.waiting ?? 0) + (orders.active ?? 0));
        metrics.dlqDepth.set((dead.waiting ?? 0) + (dead.failed ?? 0));
      })
      .catch((error: unknown) =>
        logger.warn(
          { event: "queue.metrics.failed", err: error },
          "Queue metrics failed",
        ),
      );
  }, 5000);
  void dispatcher
    .dispatchOnce()
    .catch((error: unknown) =>
      logger.error(
        { event: "outbox.dispatch.failed", err: error },
        "Initial dispatch failed",
      ),
    );

  return {
    dispatcher,
    processor,
    reconciler,
    async close() {
      clearInterval(dispatchTimer);
      clearInterval(reconcileTimer);
      clearInterval(metricsTimer);
      await worker.close();
      await Promise.all([orderQueue.close(), dlq.close()]);
      workerConnection.disconnect();
      queueConnection.disconnect();
    },
  };
}
