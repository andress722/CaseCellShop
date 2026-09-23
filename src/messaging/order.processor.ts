import type { Pool, PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Job, Queue } from "bullmq";
import { UnrecoverableError } from "bullmq";
import {
  FakeErpAdapter,
  ErpPermanentError,
} from "../integrations/erp/fake-erp.adapter.js";
import type { Metrics } from "../observability/metrics.js";
import { startSpan, spanContext, withSpan } from "../observability/tracing.js";
import { context } from "@opentelemetry/api";

export interface OrderJob {
  orderId: string;
  trace?: Record<string, string>;
}

interface LockedOrder {
  id: string;
  status: string;
}

export class OrderProcessor {
  constructor(
    private readonly database: Pool,
    private readonly erp: FakeErpAdapter,
    private readonly dlq: Queue,
    private readonly metrics: Metrics,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async process(job: Job<OrderJob>): Promise<void> {
    const { orderId } = job.data;
    const span = startSpan("bullmq order.created", job.data.trace);
    const started = Date.now();
    try {
      await context.with(spanContext(span), async () => {
        await withSpan("order.process", async () => {
          const current = await this.database.query<{ status: string }>(
            "SELECT status FROM orders WHERE id = $1",
            [orderId],
          );
          if (
            !current.rows[0] ||
            current.rows[0].status === "COMPLETED" ||
            current.rows[0].status === "FAILED"
          ) {
            return;
          }
          await withSpan("order.markProcessing", async () => {
            await this.database.query(
              `UPDATE orders SET status = 'PROCESSING', updated_at = now()
               WHERE id = $1 AND status IN ('PENDING', 'QUEUED', 'PROCESSING', 'RECONCILIATION_REQUIRED')`,
              [orderId],
            );
          });
          this.logger.info(
            {
              event: "order.worker.started",
              orderId,
              jobId: job.id,
              attempt: job.attemptsMade + 1,
            },
            "Processing order",
          );
          try {
            const reference = await this.erp.invoice(orderId);
            await this.complete(orderId, reference);
            this.logger.info(
              { event: "order.worker.completed", orderId, jobId: job.id },
              "Order completed",
            );
          } catch (error) {
            const permanent = error instanceof ErpPermanentError;
            const exhausted = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
            if (permanent || exhausted) {
              const status = permanent ? "FAILED" : "RECONCILIATION_REQUIRED";
              if (permanent) await this.fail(orderId, "ERP_REJECTED");
              else await this.markUncertain(orderId);
              await this.dlq.add(
                "order.deadletter",
                {
                  orderId,
                  reason: permanent ? "ERP_REJECTED" : "ERP_TIMEOUT",
                  trace: job.data.trace,
                },
                { jobId: `dlq-${orderId}`, removeOnComplete: false },
              );
              this.metrics.dlqMessages.inc();
              this.logger.error(
                {
                  event: "order.sent_to_dlq",
                  orderId,
                  jobId: job.id,
                  attempt: job.attemptsMade + 1,
                  status,
                  err: error,
                },
                "Order sent to DLQ",
              );
              if (permanent)
                throw new UnrecoverableError("ERP rejected invoice");
            } else {
              this.metrics.workerRetries.inc();
              this.logger.warn(
                {
                  event: "order.worker.retry",
                  orderId,
                  jobId: job.id,
                  attempt: job.attemptsMade + 1,
                  err: error,
                },
                "Retrying order",
              );
            }
            throw error;
          }
        });
      });
    } finally {
      this.metrics.orderDuration.observe((Date.now() - started) / 1000);
      span.end();
    }
  }

  async complete(orderId: string, reference: string): Promise<void> {
    await this.changeTerminalStatus(orderId, "COMPLETED", reference);
  }

  async fail(orderId: string, code: string): Promise<void> {
    await this.changeTerminalStatus(orderId, "FAILED", code);
  }

  private async markUncertain(orderId: string): Promise<void> {
    await this.database.query(
      `UPDATE orders SET status = 'RECONCILIATION_REQUIRED', error_code = 'ERP_TIMEOUT', updated_at = now()
       WHERE id = $1 AND status = 'PROCESSING'`,
      [orderId],
    );
  }

  private async changeTerminalStatus(
    orderId: string,
    status: "COMPLETED" | "FAILED",
    value: string,
  ): Promise<void> {
    const client = await this.database.connect();
    let transitioned = false;
    try {
      await client.query("BEGIN");
      await withSpan(`order.mark${status}`, async () => {
        const current = await client.query<LockedOrder>(
          "SELECT id, status FROM orders WHERE id = $1 FOR UPDATE",
          [orderId],
        );
        const row = current.rows[0];
        if (!row || row.status === status) return;
        if (row.status === "COMPLETED" || row.status === "FAILED") return;
        await this.adjustInventory(client, orderId, status);
        await client.query(
          `UPDATE orders SET status = $2, erp_reference = CASE WHEN $2 = 'COMPLETED' THEN $3 ELSE erp_reference END,
             error_code = CASE WHEN $2 = 'FAILED' THEN $3 ELSE NULL END, updated_at = now() WHERE id = $1`,
          [orderId, status, value],
        );
        transitioned = true;
      });
      await client.query("COMMIT");
      if (transitioned) {
        if (status === "COMPLETED") this.metrics.orderCompleted.inc();
        else this.metrics.orderFailed.inc();
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async adjustInventory(
    client: PoolClient,
    orderId: string,
    status: "COMPLETED" | "FAILED",
  ) {
    await client.query(
      `UPDATE inventory AS i SET
         reserved = i.reserved - oi.quantity,
         available = i.available + CASE WHEN $2 = 'FAILED' THEN oi.quantity ELSE 0 END,
         version = i.version + 1, updated_at = now()
       FROM order_items AS oi WHERE oi.order_id = $1 AND oi.product_id = i.product_id`,
      [orderId, status],
    );
  }
}
