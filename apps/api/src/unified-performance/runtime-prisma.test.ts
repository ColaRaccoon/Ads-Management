import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaService } from "../common/prisma.service";
import { UnifiedRuntimePrisma, unifiedRuntimeDatabaseUrl } from "./runtime-prisma";
import { UnifiedPerformanceModule } from "./unified-performance.module";

const legacy = "postgresql://legacy:legacy-password@db.example:5432/postgres?schema=meta_ads";
const restricted = "postgresql://report:report-password@db.example:5432/postgres?schema=meta_ads";
const on = { UNIFIED_PERFORMANCE_ENABLED: "true", DATABASE_URL: legacy, UNIFIED_RUNTIME_DATABASE_URL: restricted };
async function environment(env: NodeJS.ProcessEnv, work: () => Promise<void>) {
  const names = ["UNIFIED_PERFORMANCE_ENABLED", "DATABASE_URL", "UNIFIED_RUNTIME_DATABASE_URL", "PRISMA_IDLE_DISCONNECT_MS", "PRISMA_CONNECTION_LIMIT"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
  try { await work(); } finally {
    for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
  }
}

test("enabled unified runtime requires a distinct restricted login on the explicit same target", () => {
  assert.equal(unifiedRuntimeDatabaseUrl({ UNIFIED_PERFORMANCE_ENABLED: "false", DATABASE_URL: "invalid" }), undefined);
  assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, UNIFIED_RUNTIME_DATABASE_URL: undefined }), /URL_REQUIRED/);
  assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, UNIFIED_RUNTIME_DATABASE_URL: legacy }), /DISTINCT_ROLE/);
  for (const url of ["not-a-url", "https://report@db.example/postgres?schema=meta_ads", "postgresql://report@db.example/?schema=meta_ads",
    `${restricted}&options=-crole%3Dlegacy`, `${restricted}&host=other.example`, `${restricted}&user=legacy`, `${restricted}#fragment`])
    assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, UNIFIED_RUNTIME_DATABASE_URL: url }), /URL_INVALID/);
  for (const url of [restricted.replace("db.example", "other.example"), restricted.replace(":5432", ":6543"),
    restricted.replace("/postgres", "/other"), restricted.replace("meta_ads", "public"), restricted.replace("?schema=meta_ads", ""), `${restricted}&schema=public`])
    assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, UNIFIED_RUNTIME_DATABASE_URL: url }), /TARGET_MISMATCH/);
  for (const role of ["postgres", "supabase_admin", "service_role", "authenticator"])
    assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, UNIFIED_RUNTIME_DATABASE_URL: restricted.replace("report:", `${role}:`) }), /RESTRICTED_ROLE/);
  const result = new URL(unifiedRuntimeDatabaseUrl({ ...on, PRISMA_CONNECTION_LIMIT: "2" })!);
  assert.equal(result.username, "report"); assert.equal(result.searchParams.get("connection_limit"), "2");
});

test("shared Supabase pooler host cannot switch project through username suffix", () => {
  const pooled = (role: string, project = "projectA") => `postgresql://${role}.${project}:secret@aws-0-region.pooler.supabase.com:5432/postgres?schema=meta_ads`;
  assert(unifiedRuntimeDatabaseUrl({ ...on, DATABASE_URL: pooled("legacy"), UNIFIED_RUNTIME_DATABASE_URL: pooled("report") }));
  assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, DATABASE_URL: pooled("legacy"), UNIFIED_RUNTIME_DATABASE_URL: pooled("report", "projectB") }), /TARGET_MISMATCH/);
  assert.throws(() => unifiedRuntimeDatabaseUrl({ ...on, DATABASE_URL: pooled("legacy"), UNIFIED_RUNTIME_DATABASE_URL: pooled("report").replace(".projectA:", ":") }), /TARGET_MISMATCH/);
});

test("restricted client preserves common strict TLS translation without changing the legacy URL", () => {
  const env = { ...on, UNIFIED_RUNTIME_DATABASE_URL: restricted + "&sslmode=verify-full&sslrootcert=%2Fprivate%2Froot.pem" };
  const result = new URL(unifiedRuntimeDatabaseUrl(env)!);
  assert.equal(result.searchParams.get("sslmode"), "require"); assert.equal(result.searchParams.get("sslaccept"), "strict");
  assert.equal(result.searchParams.get("sslcert"), "/private/root.pem"); assert.equal(result.searchParams.has("sslrootcert"), false);
  assert.equal(env.DATABASE_URL, legacy);
});

test("OFF lifecycle never connects, ignores absent secrets and blocks accidental repository access", async () => environment({ UNIFIED_PERFORMANCE_ENABLED: "false", DATABASE_URL: "invalid" }, async () => {
  const client = new UnifiedRuntimePrisma(); let connections = 0, disconnects = 0;
  client.$connect = async () => { connections++; }; client.$disconnect = async () => { disconnects++; };
  await client.onModuleInit();
  await assert.rejects(client.$queryRaw`SELECT 1`, /UNIFIED_RUNTIME_DISABLED/);
  assert.throws(() => client.$transaction(async () => 1), /UNIFIED_RUNTIME_DISABLED/);
  await client.onModuleDestroy();
  assert.equal(connections, 0); assert.equal(disconnects, 0);
}));

test("startup rejects actual owner/admin role flags and redacts provider errors", async () => environment(on, async () => {
  for (const attribute of ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "owns", "providerError"] as const) {
    const client = new UnifiedRuntimePrisma(); let disconnected = 0;
    client.$connect = async () => {};
    client.$queryRaw = (async () => {
      if (attribute === "providerError") throw Error("secret connection details must not escape");
      return [{ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, owns: 0n, [attribute]: attribute === "owns" ? 1n : true }];
    }) as typeof client.$queryRaw;
    client.$disconnect = async () => { disconnected++; };
    await assert.rejects(client.onModuleInit(), error => error instanceof Error && error.message === "UNIFIED_RUNTIME_STARTUP_REJECTED");
    assert.equal(disconnected, 1);
  }
}));

test("separate restricted login has its own connect/disconnect lifecycle", async () => environment({ ...on, PRISMA_IDLE_DISCONNECT_MS: "1000" }, async () => {
  const client = new UnifiedRuntimePrisma(); let connected = 0;
  client.$connect = async () => { connected++; };
  client.$queryRaw = (async () => [{ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, owns: 0n }]) as typeof client.$queryRaw;
  await client.onModuleInit(); assert.equal(connected, 1);
  await client.onModuleDestroy();
}));

const legacyClient = { name: "legacy-global-client" };
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: legacyClient }], exports: [PrismaService] })
class LegacyCommonFixture {}
@Injectable()
class ExistingScreen { constructor(@Inject(PrismaService) readonly prisma: PrismaService) {} }
@Module({ imports: [LegacyCommonFixture, UnifiedPerformanceModule], providers: [ExistingScreen] })
class ScopeFixture {}

test("Nest module override keeps existing screens on global Prisma and isolates the unified module", async () => environment({ UNIFIED_PERFORMANCE_ENABLED: "false" }, async () => {
  const app = await NestFactory.createApplicationContext(ScopeFixture, { logger: false });
  try {
    assert.equal(app.get(ExistingScreen).prisma, legacyClient);
    const unifiedClient = app.select(UnifiedPerformanceModule).get(PrismaService, { strict: true });
    assert.notEqual(unifiedClient, legacyClient);
    assert.equal(unifiedClient.onModuleInit, UnifiedRuntimePrisma.prototype.onModuleInit);
  } finally { await app.close(); }
}));
