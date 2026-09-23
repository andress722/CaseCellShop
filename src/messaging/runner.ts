import { Pool } from "pg";
import pino from "pino";
import { parseConfig } from "../app/config.js";
import { createMetrics } from "../observability/metrics.js";
import { startTracing } from "../observability/tracing.js";
import { startBackground } from "./background.js";

const config = parseConfig(process.env);
const tracing = startTracing("casecellshop-worker");
const database = new Pool({ connectionString: config.DATABASE_URL });
const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "casecellshop-worker", env: config.NODE_ENV },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
});
const background = startBackground(
  config,
  database,
  createMetrics("casecellshop-worker"),
  logger,
);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await background.close();
  await Promise.all([database.end(), tracing.shutdown()]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close();
  });
}
