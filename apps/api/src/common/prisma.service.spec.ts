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

  it("enforces TLS and certificate verification for verify-full deployments", () => {
    const result = new URL(databaseUrlWithConnectionLimit(
      `${databaseUrl}&sslmode=verify-full&sslaccept=accept_invalid_certs`, "1"
    )!);
    expect(result.searchParams.get("sslmode")).toBe("require");
    expect(result.searchParams.get("sslaccept")).toBe("strict");
    expect(result.searchParams.get("schema")).toBe("public");
  });

  it("passes the configured trust root using Prisma's certificate option", () => {
    const result = new URL(databaseUrlWithConnectionLimit(
      `${databaseUrl}&sslmode=verify-full&sslrootcert=%2Frun%2Fca.pem`, "1"
    )!);
    expect(result.searchParams.get("sslcert")).toBe("/run/ca.pem");
    expect(result.searchParams.has("sslrootcert")).toBe(false);
  });

  it("preserves explicit local development TLS settings", () => {
    const result = new URL(databaseUrlWithConnectionLimit(`${databaseUrl}&sslmode=disable`, "1")!);
    expect(result.searchParams.get("sslmode")).toBe("disable");
    expect(result.searchParams.has("sslaccept")).toBe(false);
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
