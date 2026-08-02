import { describe, expect, it } from "vitest";
import {
  databaseUrlWithConnectionLimit,
  DEFAULT_PRISMA_CONNECTION_LIMIT
} from "./prisma.service";

describe("databaseUrlWithConnectionLimit", () => {
  const databaseUrl = "postgresql://app:secret@example.com:5432/database?schema=public&connection_limit=3";

  it("uses a conservative single-connection pool by default", () => {
    const result = databaseUrlWithConnectionLimit(databaseUrl, undefined);

    expect(new URL(result!).searchParams.get("connection_limit")).toBe(
      String(DEFAULT_PRISMA_CONNECTION_LIMIT)
    );
  });

  it("allows an explicit per-process connection limit", () => {
    const result = databaseUrlWithConnectionLimit(databaseUrl, "2");

    expect(new URL(result!).searchParams.get("connection_limit")).toBe("2");
  });

  it("preserves the other datasource options", () => {
    const result = databaseUrlWithConnectionLimit(databaseUrl, "1");

    expect(new URL(result!).searchParams.get("schema")).toBe("public");
  });

  it("defers a missing DATABASE_URL to Prisma's normal validation", () => {
    expect(databaseUrlWithConnectionLimit(undefined, "1")).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "many"])("rejects invalid limits: %s", (value) => {
    expect(() => databaseUrlWithConnectionLimit(databaseUrl, value)).toThrow(
      "PRISMA_CONNECTION_LIMIT must be a positive integer."
    );
  });
});
