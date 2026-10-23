import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Module, type FactoryProvider } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { NestFactory } from "@nestjs/core";
import { DailySyncModule } from "../../../apps/api/src/daily-sync/daily-sync.module";
import { MetaDayReader, type MetaDayReadInput } from "../../../apps/api/src/daily-sync/meta-day-reader";
import { MetaAdsClient } from "../../../apps/api/src/daily-sync/meta-ads.client";

const provider = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DailySyncModule) as FactoryProvider[])
  .find(value => value.provide === MetaDayReader)!;
const keys = ["DAILY_SYNC_META_TRANSPORT", "DAILY_SYNC_FEATURE_ENABLED", "DAILY_SYNC_META_MCP_CATALOG_PATH", "DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH"];
const input: MetaDayReadInput = { accountId: "123456", day: "2026-10-14", deadlineAt: Date.now() + 10_000,
  accessToken: "SYNTHETIC_NEVER_SENT", settings: { actionReportTime: "MCP_PROVIDER_DEFAULT_UNVERIFIED", attributionWindows: [] } };
async function context(graph: object) {
  class ProbeModule {}
  Module({ providers: [{ provide: MetaAdsClient, useValue: graph }, provider] })(ProbeModule);
  return NestFactory.createApplicationContext(ProbeModule, { logger: false, abortOnError: false });
}
function restore(before: Record<string, string | undefined>) {
  for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
}
for (const enabled of ["false", "true"]) test(`actual DI provider starts with MCP files absent and feature=${enabled}; fetch rejects before request`, async () => {
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const missing = join(tmpdir(), `incident-meta-reader-missing-${randomUUID()}`);
  const originalStat = fs.lstatSync, originalRead = fs.readFileSync, originalFetch = globalThis.fetch;
  let fileOperations = 0, providerRequests = 0, graphRequests = 0;
  fs.lstatSync = ((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path).startsWith(missing)) fileOperations++;
    return Reflect.apply(originalStat, fs, [path, ...args]);
  }) as typeof fs.lstatSync;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).startsWith(missing)) fileOperations++;
    return Reflect.apply(originalRead, fs, [path, ...args]);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  globalThis.fetch = (async () => { providerRequests++; throw Error("UNEXPECTED_PROVIDER_REQUEST"); }) as typeof fetch;
  process.env.DAILY_SYNC_META_TRANSPORT = "MCP"; process.env.DAILY_SYNC_FEATURE_ENABLED = enabled;
  process.env.DAILY_SYNC_META_MCP_CATALOG_PATH = join(missing, "catalog.json");
  process.env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH = join(missing, "reporting.json");
  let app: Awaited<ReturnType<typeof context>> | undefined;
  try {
    app = await context({ transport: "GRAPH", fetchDay: async () => { graphRequests++; } });
    const reader = app.get(MetaDayReader);
    assert.equal(reader.transport, "MCP"); assert.equal(fileOperations, 0); assert.equal(providerRequests, 0);
    await assert.rejects(reader.fetchDay(input), (error: unknown) =>
      (error as { getResponse(): { code?: string } }).getResponse().code === "PROVIDER_AUTH_REQUIRED");
    assert(fileOperations > 0); assert.equal(providerRequests, 0); assert.equal(graphRequests, 0);
  } finally {
    await app?.close(); fs.lstatSync = originalStat; fs.readFileSync = originalRead; syncBuiltinESMExports(); globalThis.fetch = originalFetch; restore(before);
  }
});
test("actual Graph DI provider remains the same injected instance and delegates unchanged", async () => {
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]])); process.env.DAILY_SYNC_META_TRANSPORT = "GRAPH";
  let seen: unknown; const result = { synthetic: true }, graph = { transport: "GRAPH", fetchDay: async (value: unknown) => { seen = value; return result; } };
  const app = await context(graph);
  try { const reader = app.get(MetaDayReader); assert.equal(reader, graph); assert.equal(await reader.fetchDay(input), result); assert.equal(seen, input); }
  finally { await app.close(); restore(before); }
});
