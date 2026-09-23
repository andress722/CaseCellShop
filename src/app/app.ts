import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { context, type Span } from "@opentelemetry/api";
import type { Config } from "./config.js";
import { createMetrics, type Metrics } from "../observability/metrics.js";
import { spanContext, startSpan, withSpan } from "../observability/tracing.js";
import { errorSchema, HttpError } from "../shared/errors.js";
import { FakeErpAdapter } from "../integrations/erp/fake-erp.adapter.js";
import { CatalogService } from "../modules/catalog/catalog.service.js";
import {
  CheckoutService,
  checkoutInput,
} from "../modules/checkout/checkout.service.js";
import { OrdersService } from "../modules/orders/orders.service.js";

export interface HealthDependencies {
  checkDatabase(): Promise<void>;
  checkRedis(): Promise<void>;
}

export interface AppResources {
  database: Pool;
  redis: Redis;
  metrics?: Metrics;
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    requestSpan: Span | null;
  }
}

export async function buildApp(
  config: Config,
  health: HealthDependencies,
  resources?: AppResources,
) {
  const metrics = resources?.metrics ?? createMetrics();
  const app = Fastify({
    bodyLimit: 1_048_576,
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      base: { service: "casecellshop-api", env: config.NODE_ENV },
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.idempotency-key",
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.decorateRequest("correlationId", "");
  app.decorateRequest("requestSpan", null);
  app.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-correlation-id"];
    request.correlationId =
      typeof incoming === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(incoming)
        ? incoming
        : request.id;
    request.log = request.log.child({
      requestId: request.id,
      correlationId: request.correlationId,
    });
    reply.header("x-request-id", request.id);
    reply.header("x-correlation-id", request.correlationId);
    const traceparent = request.headers.traceparent;
    request.requestSpan = startSpan(`HTTP ${request.method}`, {
      ...(typeof traceparent === "string" ? { traceparent } : {}),
    });
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    metrics.httpRequests.inc({
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    });
    metrics.httpDuration.observe(
      { method: request.method, route },
      reply.elapsedTime / 1000,
    );
    request.requestSpan?.updateName(`HTTP ${request.method} ${route}`);
    request.log.info(
      {
        event: "http.request.completed",
        requestId: request.id,
        correlationId: request.correlationId,
        method: request.method,
        route,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        traceId: request.requestSpan?.spanContext().traceId,
        spanId: request.requestSpan?.spanContext().spanId,
      },
      "HTTP request completed",
    );
    request.requestSpan?.end();
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: { title: "CaseCellShop API", version: "0.1.0" },
      components: { schemas: { Error: errorSchema } },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  const liveSchema = {
    tags: ["health"],
    response: {
      200: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ok"] } },
      },
    },
  } as const;
  app.get("/health/live", { schema: liveSchema }, async () => ({
    status: "ok",
  }));

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["health"],
        response: {
          200: liveSchema.response[200],
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await Promise.all([health.checkDatabase(), health.checkRedis()]);
        return { status: "ok" };
      } catch (error) {
        request.log.warn(
          { event: "health.ready.failed", err: error },
          "Readiness check failed",
        );
        return reply.code(503).send({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "A required dependency is unavailable",
            requestId: request.id,
          },
        });
      }
    },
  );

  if (resources) {
    const { database, redis } = resources;
    const erp = new FakeErpAdapter(database, config, metrics);
    const catalog = new CatalogService(redis, erp, config, metrics, app.log);
    const checkout = new CheckoutService(database, metrics, () =>
      catalog.invalidate(),
    );
    const orders = new OrdersService(database);

    const productSchema = {
      type: "object",
      required: ["id", "name", "price", "available", "updatedAt"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        price: { type: "number" },
        available: { type: "integer" },
        updatedAt: { type: "string", format: "date-time" },
      },
    } as const;
    app.get(
      "/products",
      {
        schema: {
          tags: ["catalog"],
          response: {
            200: {
              type: "object",
              required: ["items"],
              properties: { items: { type: "array", items: productSchema } },
            },
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await context.with(
          spanContext(request.requestSpan!),
          () => catalog.getProducts(),
        );
        const stock = await context.with(
          spanContext(request.requestSpan!),
          () =>
            withSpan("inventory.availability", () =>
              database.query<{ product_id: string; available: number }>(
                "SELECT product_id, available FROM inventory WHERE product_id = ANY($1)",
                [result.items.map((item) => item.id)],
              ),
            ),
        );
        const available = new Map(
          stock.rows.map((row) => [row.product_id, row.available]),
        );
        reply.header("x-cache", result.cache);
        request.log.info(
          { event: `catalog.cache.${result.cache.toLowerCase()}` },
          "Catalog served",
        );
        return {
          items: result.items.map((item) => ({
            ...item,
            available: available.get(item.id) ?? 0,
          })),
        };
      },
    );

    const statusSchema = {
      type: "string",
      enum: [
        "PENDING",
        "QUEUED",
        "PROCESSING",
        "COMPLETED",
        "FAILED",
        "RECONCILIATION_REQUIRED",
      ],
    } as const;
    app.post(
      "/checkout",
      {
        schema: {
          tags: ["checkout"],
          headers: {
            type: "object",
            required: ["idempotency-key"],
            properties: {
              "idempotency-key": {
                type: "string",
                minLength: 1,
                maxLength: 128,
              },
            },
          },
          body: {
            type: "object",
            required: ["items"],
            additionalProperties: false,
            properties: {
              items: {
                type: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  type: "object",
                  required: ["productId", "quantity"],
                  additionalProperties: false,
                  properties: {
                    productId: { type: "string", minLength: 1, maxLength: 128 },
                    quantity: { type: "integer", minimum: 1, maximum: 1000 },
                  },
                },
              },
            },
          },
          response: {
            202: {
              type: "object",
              required: ["orderId", "status"],
              properties: { orderId: { type: "string" }, status: statusSchema },
            },
            400: errorSchema,
            404: errorSchema,
            409: errorSchema,
          },
        },
      },
      async (request, reply) => {
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !key.trim()) {
          throw new HttpError(
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
            "Idempotency-Key is required",
          );
        }
        const parsed = checkoutInput.safeParse(request.body);
        if (!parsed.success)
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "Invalid checkout request",
          );
        const result = await context.with(
          spanContext(request.requestSpan!),
          () => checkout.create(parsed.data, key),
        );
        request.log.info(
          {
            event: result.replay
              ? "checkout.idempotent_replay"
              : "checkout.accepted",
            orderId: result.orderId,
          },
          "Checkout accepted",
        );
        return reply
          .code(202)
          .send({ orderId: result.orderId, status: result.status });
      },
    );

    app.get<{ Params: { orderId: string } }>(
      "/orders/:orderId/status",
      {
        schema: {
          tags: ["orders"],
          params: {
            type: "object",
            required: ["orderId"],
            properties: { orderId: { type: "string", minLength: 1 } },
          },
          response: {
            200: {
              type: "object",
              required: ["orderId", "status", "updatedAt"],
              properties: {
                orderId: { type: "string" },
                status: statusSchema,
                updatedAt: { type: "string", format: "date-time" },
              },
            },
            404: errorSchema,
          },
        },
      },
      async (request) =>
        context.with(spanContext(request.requestSpan!), () =>
          orders.getStatus(request.params.orderId),
        ),
    );

    app.get(
      "/metrics",
      { schema: { tags: ["observability"], hide: true } },
      async (_request, reply) => {
        const counts = await database.query<{
          pending: string;
          processing: string;
        }>(`SELECT
          (SELECT count(*) FROM outbox_events WHERE published_at IS NULL)::text AS pending,
          (SELECT count(*) FROM orders WHERE status = 'PROCESSING')::text AS processing`);
        metrics.outboxPending.set(Number(counts.rows[0]?.pending ?? 0));
        metrics.processing.set(Number(counts.rows[0]?.processing ?? 0));
        return reply
          .type(metrics.registry.contentType)
          .send(await metrics.registry.metrics());
      },
    );
  }

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof HttpError;
    const validation =
      error !== null &&
      typeof error === "object" &&
      "validation" in error &&
      Boolean(error.validation);
    const statusCode = known ? error.statusCode : validation ? 400 : 500;
    const missingKey =
      validation &&
      request.routeOptions.url === "/checkout" &&
      !request.headers["idempotency-key"];
    const code = known
      ? error.code
      : missingKey
        ? "IDEMPOTENCY_KEY_REQUIRED"
        : validation
          ? "VALIDATION_ERROR"
          : "INTERNAL_ERROR";
    const message = known
      ? error.message
      : missingKey
        ? "Idempotency-Key is required"
        : validation
          ? "Invalid request"
          : "Internal server error";
    request.log[statusCode >= 500 ? "error" : "warn"](
      {
        event: "http.request.failed",
        code,
        err: statusCode >= 500 ? error : undefined,
      },
      "Request failed",
    );
    reply.code(statusCode).send({
      error: {
        code,
        message,
        requestId: request.id,
      },
    });
  });

  return app;
}
