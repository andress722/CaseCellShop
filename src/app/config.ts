import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().startsWith("postgres://"),
  REDIS_URL: z.url().startsWith("redis://"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  CATALOG_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  CATALOG_STALE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CATALOG_LOCK_MS: z.coerce.number().int().positive().default(5000),
  ERP_CATALOG_MODE: z.enum(["normal", "slow", "error"]).default("normal"),
  ERP_BILLING_MODE: z
    .enum(["normal", "slow", "timeout", "error", "accept_then_timeout"])
    .default("normal"),
  ERP_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
  BACKGROUND_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type Config = z.infer<typeof environmentSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): Config {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
