import type { Queue } from "bullmq";
import type { Pool } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { OrderJob } from "./order.processor.js";
import { withSpan } from "../observability/tracing.js";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload_json: OrderJob;
}

export class OutboxDispatcher {
  constructor(
    private readonly database: Pool,
    private readonly queue: Queue<OrderJob>,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async dispatchOnce(): Promise<number> {
    const client = await this.database.connect();
    let published = 0;
    try {
      await client.query("BEGIN");
      const events = await client.query<OutboxRow>(
        `SELECT id::text, aggregate_id, payload_json FROM outbox_events
         WHERE published_at IS NULL AND event_type = 'order.created'
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 10`,
      );
      for (const event of events.rows) {
        await withSpan("outbox.publish", () =>
          this.queue.add("order.created", event.payload_json, {
            jobId: `outbox-${event.id}`,
            attempts: 3,
            backoff: { type: "exponential", delay: 200 },
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: false,
          }),
        );
        await client.query(
          "UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1",
          [event.id],
        );
        await client.query(
          "UPDATE orders SET status = 'QUEUED', updated_at = now() WHERE id = $1 AND status = 'PENDING'",
          [event.aggregate_id],
        );
        published++;
        this.logger.info(
          {
            event: "outbox.event.published",
            orderId: event.aggregate_id,
            jobId: `outbox-${event.id}`,
          },
          "Outbox event published",
        );
      }
      await client.query("COMMIT");
      return published;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
