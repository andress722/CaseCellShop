import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Config } from "../../app/config.js";
import type { FastifyBaseLogger } from "fastify";
import type {
  CatalogProduct,
  FakeErpAdapter,
} from "../../integrations/erp/fake-erp.adapter.js";
import type { Metrics } from "../../observability/metrics.js";
import { withSpan } from "../../observability/tracing.js";
import { HttpError } from "../../shared/errors.js";

const FRESH_KEY = "catalog:v1:products";
const STALE_KEY = "catalog:v1:products:stale";
const LOCK_KEY = "lock:catalog:v1:products";

export interface CatalogResult {
  items: CatalogProduct[];
  cache: "HIT" | "MISS" | "STALE";
}

export class CatalogService {
  constructor(
    private readonly redis: Redis,
    private readonly source: Pick<FakeErpAdapter, "fetchCatalog">,
    private readonly config: Config,
    private readonly metrics: Metrics,
    private readonly logger?: FastifyBaseLogger,
  ) {}

  async getProducts(): Promise<CatalogResult> {
    return withSpan("catalog.getProducts", async () => {
      const fresh = await this.read(FRESH_KEY);
      if (fresh) {
        this.metrics.cacheHits.inc();
        return { items: fresh, cache: "HIT" };
      }
      this.metrics.cacheMisses.inc();
      const token = randomUUID();
      let locked = false;
      try {
        locked =
          (await withSpan("redis.lock", () =>
            this.redis.set(
              LOCK_KEY,
              token,
              "PX",
              this.config.CATALOG_LOCK_MS,
              "NX",
            ),
          )) === "OK";
      } catch (error) {
        this.metrics.cacheErrors.inc();
        this.logger?.warn(
          { event: "catalog.cache.error", err: error },
          "Catalog cache lock failed",
        );
        return this.loadDirect();
      }

      if (locked) {
        try {
          const items = await this.source.fetchCatalog();
          const jitter = 0.8 + Math.random() * 0.4;
          const freshTtl = Math.max(
            1,
            Math.round(this.config.CATALOG_TTL_SECONDS * jitter),
          );
          try {
            await withSpan("redis.set", async () => {
              await this.redis.set(
                FRESH_KEY,
                JSON.stringify(items),
                "EX",
                freshTtl,
              );
              await this.redis.set(
                STALE_KEY,
                JSON.stringify(items),
                "EX",
                this.config.CATALOG_STALE_TTL_SECONDS,
              );
            });
          } catch (error) {
            this.metrics.cacheErrors.inc();
            this.logger?.warn(
              { event: "catalog.cache.error", err: error },
              "Catalog cache write failed",
            );
          }
          return { items, cache: "MISS" };
        } catch (error) {
          this.logger?.warn(
            { event: "catalog.refresh.failed", err: error },
            "Catalog refresh failed",
          );
          return await this.staleOrUnavailable();
        } finally {
          try {
            await this.redis.eval(
              "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
              1,
              LOCK_KEY,
              token,
            );
          } catch (error) {
            this.metrics.cacheErrors.inc();
            this.logger?.warn(
              { event: "catalog.cache.error", err: error },
              "Catalog cache unlock failed",
            );
          }
        }
      }

      const stale = await this.read(STALE_KEY);
      if (stale) {
        this.metrics.staleServed.inc();
        return { items: stale, cache: "STALE" };
      }
      const deadline = Date.now() + this.config.CATALOG_LOCK_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const updated = await this.read(FRESH_KEY);
        if (updated) return { items: updated, cache: "HIT" };
      }
      return this.staleOrUnavailable();
    });
  }

  async invalidate(): Promise<void> {
    await this.redis.del(FRESH_KEY);
  }

  private async loadDirect(): Promise<CatalogResult> {
    try {
      return { items: await this.source.fetchCatalog(), cache: "MISS" };
    } catch {
      throw new HttpError(503, "ERP_UNAVAILABLE", "Catalog source unavailable");
    }
  }

  private async staleOrUnavailable(): Promise<CatalogResult> {
    const stale = await this.read(STALE_KEY);
    if (stale) {
      this.metrics.staleServed.inc();
      return { items: stale, cache: "STALE" };
    }
    throw new HttpError(503, "ERP_UNAVAILABLE", "Catalog source unavailable");
  }

  private async read(key: string): Promise<CatalogProduct[] | null> {
    try {
      const payload = await withSpan("redis.get", () => this.redis.get(key));
      return payload ? (JSON.parse(payload) as CatalogProduct[]) : null;
    } catch (error) {
      this.metrics.cacheErrors.inc();
      this.logger?.warn(
        { event: "catalog.cache.error", err: error },
        "Catalog cache read failed",
      );
      return null;
    }
  }
}
