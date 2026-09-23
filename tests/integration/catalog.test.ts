import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Redis } from "ioredis";
import { CatalogService } from "../../src/modules/catalog/catalog.service.js";
import { createMetrics } from "../../src/observability/metrics.js";
import { config } from "../helpers.js";

const keys = [
  "catalog:v1:products",
  "catalog:v1:products:stale",
  "lock:catalog:v1:products",
];
const sample = [
  {
    id: "test-case",
    name: "Test Case",
    price: 79.9,
    available: 10,
    updatedAt: new Date().toISOString(),
  },
];

describe("catalog cache", () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(config.REDIS_URL);
  });
  beforeEach(async () => {
    await redis.del(...keys);
  });
  afterAll(async () => {
    await redis.del(...keys);
    await redis.quit();
  });

  it("loads once on miss, then serves a hit without querying ERP", async () => {
    const source = { fetchCatalog: vi.fn(async () => sample) };
    const service = new CatalogService(redis, source, config, createMetrics());
    expect((await service.getProducts()).cache).toBe("MISS");
    expect((await service.getProducts()).cache).toBe("HIT");
    expect(source.fetchCatalog).toHaveBeenCalledTimes(1);
  });

  it("expires fresh data and serves stale when ERP fails", async () => {
    const source = { fetchCatalog: vi.fn(async () => sample) };
    const service = new CatalogService(
      redis,
      source,
      { ...config, CATALOG_TTL_SECONDS: 1 },
      createMetrics(),
    );
    await service.getProducts();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    source.fetchCatalog.mockRejectedValueOnce(new Error("ERP unavailable"));
    const result = await service.getProducts();
    expect(result.cache).toBe("STALE");
    expect(result.items).toEqual(sample);
  });

  it("returns 503 when ERP fails without stale data", async () => {
    const source = {
      fetchCatalog: vi.fn(async () => {
        throw new Error("ERP unavailable");
      }),
    };
    const service = new CatalogService(redis, source, config, createMetrics());
    await expect(service.getProducts()).rejects.toMatchObject({
      statusCode: 503,
      code: "ERP_UNAVAILABLE",
    });
  });

  it("uses ERP directly when Redis is unavailable", async () => {
    const brokenRedis = {
      async get() {
        throw new Error("Redis unavailable");
      },
      async set() {
        throw new Error("Redis unavailable");
      },
    } as unknown as Redis;
    const source = { fetchCatalog: vi.fn(async () => sample) };
    const service = new CatalogService(
      brokenRedis,
      source,
      config,
      createMetrics(),
    );
    const result = await service.getProducts();
    expect(result.cache).toBe("MISS");
    expect(source.fetchCatalog).toHaveBeenCalledTimes(1);
  });

  it("allows only one refresh for simultaneous misses", async () => {
    const source = {
      fetchCatalog: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return sample;
      }),
    };
    const service = new CatalogService(redis, source, config, createMetrics());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.getProducts()),
    );
    expect(source.fetchCatalog).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.items.length === 1)).toBe(true);
  });
});
