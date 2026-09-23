import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app/app.js";
import { parseConfig } from "../../src/app/config.js";

const config = parseConfig({
  DATABASE_URL:
    "postgres://casecellshop:casecellshop@localhost:5432/casecellshop",
  REDIS_URL: "redis://localhost:6379",
  LOG_LEVEL: "silent",
});

describe("health endpoints", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("returns liveness and readiness while dependencies are healthy", async () => {
    const instance = await buildApp(config, {
      async checkDatabase() {},
      async checkRedis() {},
    });
    app = instance;
    const live = await instance.inject("/health/live");
    const ready = await instance.inject("/health/ready");
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(ready.headers["x-request-id"]).toBeTypeOf("string");
  });

  it("stays live but reports unavailable when a dependency fails", async () => {
    const instance = await buildApp(config, {
      async checkDatabase() {
        throw new Error("database down");
      },
      async checkRedis() {},
    });
    app = instance;
    const live = await instance.inject("/health/live");
    const ready = await instance.inject("/health/ready");
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().error).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
    });
    expect(ready.json().error.requestId).toBe(ready.headers["x-request-id"]);
  });
});
