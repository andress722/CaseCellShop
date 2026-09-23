import { Pool } from "pg";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import pino from "pino";
import { parseConfig } from "../src/app/config.js";
import { FakeErpAdapter } from "../src/integrations/erp/fake-erp.adapter.js";
import { OrderProcessor } from "../src/messaging/order.processor.js";
import { Reconciler } from "../src/messaging/reconciliation.worker.js";
import { createMetrics } from "../src/observability/metrics.js";
import { startTracing } from "../src/observability/tracing.js";

const config = parseConfig(process.env);
const tracing = startTracing("casecellshop-reconcile");
const database = new Pool({ connectionString: config.DATABASE_URL });
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const dlq = new Queue("order-deadletter", { connection });
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "casecellshop-reconcile", env: config.NODE_ENV },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
});
const metrics = createMetrics("casecellshop-reconcile");
const erp = new FakeErpAdapter(database, config, metrics);
const processor = new OrderProcessor(database, erp, dlq, metrics, logger);
const reconciler = new Reconciler(
  database,
  erp,
  processor,
  dlq,
  metrics,
  logger,
);

try {
  const count = await reconciler.runOnce();
  process.stdout.write(`Inspected ${count} orders\n`);
} catch (error) {
  logger.error({ err: error }, "Reconciliation failed");
  process.exitCode = 1;
} finally {
  await dlq.close();
  connection.disconnect();
  await Promise.all([database.end(), tracing.shutdown()]);
}
