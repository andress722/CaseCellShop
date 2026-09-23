import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { FastifyBaseLogger } from "fastify";
import type { FakeErpAdapter } from "../integrations/erp/fake-erp.adapter.js";
import type { Metrics } from "../observability/metrics.js";
import type { OrderProcessor } from "./order.processor.js";
import { withSpan } from "../observability/tracing.js";

export class Reconciler {
  constructor(
    private readonly database: Pool,
    private readonly erp: FakeErpAdapter,
    private readonly processor: OrderProcessor,
    private readonly dlq: Queue,
    private readonly metrics: Metrics,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async runOnce(): Promise<number> {
    return withSpan("reconciliation.run", async () => {
      const uncertain = await this.database.query<{ id: string }>(
        `SELECT id FROM orders
         WHERE status = 'RECONCILIATION_REQUIRED'
            OR (status = 'PROCESSING' AND updated_at < now() - interval '30 seconds')
         ORDER BY updated_at LIMIT 100`,
      );
      const deadJobs = await this.dlq.getJobs(
        ["waiting", "failed", "completed"],
        0,
        100,
      );
      const ids = new Set([
        ...uncertain.rows.map((row) => row.id),
        ...deadJobs.map((job) => job.data.orderId as string),
      ]);
      if (ids.size > 0)
        this.logger.info(
          { event: "reconciliation.started", count: ids.size },
          "Reconciliation started",
        );
      for (const orderId of ids) {
        try {
          const status = await this.database.query<{ status: string }>(
            "SELECT status FROM orders WHERE id = $1",
            [orderId],
          );
          if (!status.rows[0]) throw new Error(`Order ${orderId} not found`);
          let resolvedStatus = status.rows[0].status;
          if (resolvedStatus !== "COMPLETED" && resolvedStatus !== "FAILED") {
            const reference = await this.erp.lookupInvoice(orderId);
            if (reference) {
              await this.processor.complete(orderId, reference);
            } else {
              await this.processor.fail(orderId, "ERP_NOT_PROCESSED");
            }
            const final = await this.database.query<{ status: string }>(
              "SELECT status FROM orders WHERE id = $1",
              [orderId],
            );
            resolvedStatus = final.rows[0]?.status ?? "";
            if (resolvedStatus !== "COMPLETED" && resolvedStatus !== "FAILED") {
              throw new Error(
                `Order ${orderId} did not reach a terminal state`,
              );
            }
            this.metrics.reconciliation.inc({
              result: resolvedStatus === "COMPLETED" ? "completed" : "failed",
            });
            this.logger.info(
              {
                event: "reconciliation.completed",
                orderId,
                result: resolvedStatus,
              },
              "Order reconciled",
            );
          }
          for (const job of deadJobs.filter(
            (candidate) => candidate.data.orderId === orderId,
          )) {
            if (!job.id) throw new Error(`DLQ job for ${orderId} has no ID`);
            const reason =
              typeof job.data.reason === "string" ? job.data.reason : "UNKNOWN";
            await this.database.query(
              `INSERT INTO dlq_resolutions (job_id, order_id, reason, resolved_status)
               VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
              [job.id, orderId, reason, resolvedStatus],
            );
            await job.remove();
            this.logger.info(
              {
                event: "reconciliation.dlq_cleared",
                orderId,
                jobId: job.id,
                result: resolvedStatus,
              },
              "Resolved DLQ job removed after durable audit",
            );
          }
        } catch (error) {
          this.metrics.reconciliation.inc({ result: "inconclusive" });
          this.logger.warn(
            { event: "reconciliation.inconclusive", orderId, err: error },
            "Order remains uncertain",
          );
        }
      }
      try {
        const depth = await this.dlq.getJobCounts("waiting", "failed");
        this.metrics.dlqDepth.set((depth.waiting ?? 0) + (depth.failed ?? 0));
      } catch (error) {
        this.logger.warn(
          { event: "queue.metrics.failed", err: error },
          "DLQ depth refresh failed",
        );
      }
      return ids.size;
    });
  }
}
