import { Counter, Gauge, Histogram, Registry } from "prom-client";

export function createMetrics(service = "casecellshop-api") {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  const httpRequests = new Counter({
    name: "http_requests_total",
    help: "HTTP requests",
    labelNames: ["method", "route", "status_code"] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["method", "route"] as const,
    registers: [registry],
  });
  const cacheHits = new Counter({
    name: "catalog_cache_hits_total",
    help: "Catalog cache hits",
    registers: [registry],
  });
  const cacheMisses = new Counter({
    name: "catalog_cache_misses_total",
    help: "Catalog cache misses",
    registers: [registry],
  });
  const staleServed = new Counter({
    name: "catalog_stale_served_total",
    help: "Stale catalog responses",
    registers: [registry],
  });
  const cacheErrors = new Counter({
    name: "catalog_cache_errors_total",
    help: "Redis catalog errors",
    registers: [registry],
  });
  const checkoutRequests = new Counter({
    name: "checkout_requests_total",
    help: "Checkout outcomes",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const checkoutReplays = new Counter({
    name: "checkout_idempotent_replays_total",
    help: "Idempotent checkout replays",
    registers: [registry],
  });
  const checkoutOutOfStock = new Counter({
    name: "checkout_out_of_stock_total",
    help: "Rejected checkouts due to stock",
    registers: [registry],
  });
  const orderCompleted = new Counter({
    name: "orders_completed_total",
    help: "Completed orders",
    registers: [registry],
  });
  const orderFailed = new Counter({
    name: "orders_failed_total",
    help: "Failed orders",
    registers: [registry],
  });
  const workerRetries = new Counter({
    name: "worker_retries_total",
    help: "Worker retries",
    registers: [registry],
  });
  const dlqMessages = new Counter({
    name: "dlq_messages_total",
    help: "Dead lettered messages",
    registers: [registry],
  });
  const reconciliation = new Counter({
    name: "reconciliation_total",
    help: "Reconciliation outcomes",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const erpRequests = new Counter({
    name: "erp_requests_total",
    help: "ERP catalog and billing requests",
    registers: [registry],
  });
  const erpErrors = new Counter({
    name: "erp_errors_total",
    help: "ERP catalog and billing errors",
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: "queue_depth",
    help: "Waiting and active orders",
    registers: [registry],
  });
  const dlqDepth = new Gauge({
    name: "dlq_depth",
    help: "Dead letter queue depth",
    registers: [registry],
  });
  const outboxPending = new Gauge({
    name: "outbox_pending",
    help: "Unpublished outbox events",
    registers: [registry],
  });
  const processing = new Gauge({
    name: "orders_processing",
    help: "Orders in processing state",
    registers: [registry],
  });
  const catalogLoad = new Histogram({
    name: "catalog_load_duration_seconds",
    help: "Catalog source load duration",
    registers: [registry],
  });
  const checkoutDuration = new Histogram({
    name: "checkout_duration_seconds",
    help: "Checkout transaction duration",
    registers: [registry],
  });
  const erpDuration = new Histogram({
    name: "erp_request_duration_seconds",
    help: "ERP billing duration",
    registers: [registry],
  });
  const orderDuration = new Histogram({
    name: "order_processing_duration_seconds",
    help: "Order processing duration",
    registers: [registry],
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    cacheHits,
    cacheMisses,
    staleServed,
    cacheErrors,
    checkoutRequests,
    checkoutReplays,
    checkoutOutOfStock,
    orderCompleted,
    orderFailed,
    workerRetries,
    dlqMessages,
    reconciliation,
    erpRequests,
    erpErrors,
    queueDepth,
    dlqDepth,
    outboxPending,
    processing,
    catalogLoad,
    checkoutDuration,
    erpDuration,
    orderDuration,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
