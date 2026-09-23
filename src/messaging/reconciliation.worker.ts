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
          if (
            !status.rows[0] ||
            ["COMPLETED", "FAILED"].includes(status.rows[0].status)
          )
            continue;
          const reference = await this.erp.lookupInvoice(orderId);
          if (reference) {
            await this.processor.complete(orderId, reference);
            this.metrics.reconciliation.inc({ result: "completed" });
          } else {
            await this.processor.fail(orderId, "ERP_NOT_PROCESSED");
            this.metrics.reconciliation.inc({ result: "failed" });
          }
          this.logger.info(
            {
              event: "reconciliation.completed",
              orderId,
              result: reference ? "completed" : "failed",
            },
            "Order reconciled",
          );
        } catch (error) {
          this.metrics.reconciliation.inc({ result: "inconclusive" });
          this.logger.warn(
            { event: "reconciliation.inconclusive", orderId, err: error },
            "Order remains uncertain",
          );
        }
      }
      return ids.size;
    });
  }
}
