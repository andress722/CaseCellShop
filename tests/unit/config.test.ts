import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/app/config.js";

const validEnvironment = {
  DATABASE_URL:
    "postgres://casecellshop:casecellshop@localhost:5432/casecellshop",
  REDIS_URL: "redis://localhost:6379",
};

describe("configuration", () => {
  it("supplies local defaults for optional settings", () => {
    const config = parseConfig(validEnvironment);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
  });

  it("rejects missing infrastructure settings at startup", () => {
    expect(() =>
      parseConfig({ REDIS_URL: validEnvironment.REDIS_URL }),
    ).toThrow("Invalid environment");
  });

  it("rejects an invalid port", () => {
    expect(() => parseConfig({ ...validEnvironment, PORT: "70000" })).toThrow(
      "Invalid environment",
    );
  });
});
