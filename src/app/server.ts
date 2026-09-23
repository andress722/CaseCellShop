import { Pool } from "pg";
import { Redis } from "ioredis";
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createMetrics } from "../observability/metrics.js";
import { startTracing } from "../observability/tracing.js";
import { startBackground } from "../messaging/background.js";

const config = parseConfig(process.env);
const tracing = startTracing();
const database = new Pool({ connectionString: config.DATABASE_URL });
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const metrics = createMetrics();

const app = await buildApp(
  config,
  {
    async checkDatabase() {
      await database.query("SELECT 1");
    },
    async checkRedis() {
      await redis.ping();
    },
  },
  { database, redis, metrics },
);

const background = config.BACKGROUND_ENABLED
  ? startBackground(config, database, metrics, app.log)
  : undefined;

app.addHook("onClose", async () => {
  await background?.close();
  await Promise.all([database.end(), redis.quit(), tracing.shutdown()]);
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.fatal({ err: error }, "Unable to start API");
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
