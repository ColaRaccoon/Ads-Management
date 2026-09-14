import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { AppRole, ConflictPolicy, InviteStatus, Prisma } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { AuthConfig } from "../auth/auth.config";
import { AuthService } from "../auth/auth.service";
import { AuthHttpException } from "../auth/auth.errors";
import { ProviderSession, VerifiedAccessToken } from "../auth/auth.types";
import { AuthCookieService } from "../auth/cookie.service";
import { IdentityProvider, ProviderInvalidCredentialsError } from "../auth/identity-provider";
import { SupabaseJwtVerifier } from "../auth/supabase-jwt.verifier";
import { PrismaService } from "../common/prisma.service";
import { META_AD_DAILY_CSV_COLUMNS, MetaAdDailyCsvParser } from "../domain/meta-ad-daily-csv";
import { ExchangeRatesService } from "../exchange-rates/exchange-rates.service";
import { MappingsService } from "../mappings/mappings.service";
import { MetaAdDailyImportService } from "./meta-ad-daily-import.service";
import { MetaAdsetAggregateService } from "./meta-adset-aggregate.service";
import { MetaEntityWriterService } from "./meta-entity-writer.service";
import { MetaMetricVersionService } from "./meta-metric-version.service";
import { UploadExchangeRateService } from "./upload-exchange-rate.service";
import { UploadStorageService } from "./upload-storage.service";

// Opt-in, disposable local PostgreSQL only. Never reads DATABASE_URL as its target.
// Prepare the selected schemas using prisma db push; destroy the disposable container after
// collecting results. The test deliberately does not delete existing database rows.
const enabled = process.env.RUN_UPLOAD_AUTH_CONTENTION === "1";
const suite = enabled ? describe : describe.skip;
const ROW_COUNT = 500;
const REPEATS = 3;

suite("actual Meta CSV import and auth contention on disposable PostgreSQL", () => {
  it("measures selected connection limits with identical input and mixed requests", async () => {
    const target = guardedTarget();
    const configuredLimit = process.env.UPLOAD_AUTH_TEST_CONNECTION_LIMIT;
    if (configuredLimit !== undefined && !/^[123]$/.test(configuredLimit)) {
      throw new Error("UPLOAD_AUTH_TEST_CONNECTION_LIMIT must be 1, 2, or 3 when provided");
    }
    const limits = configuredLimit === undefined ? [1, 2] : [Number(configuredLimit)];
    const previousUrl = process.env.DATABASE_URL;
    const previousLimit = process.env.PRISMA_CONNECTION_LIMIT;
    try {
      for (const limit of limits) {
        target.searchParams.set("schema", `test_upload_auth_${limit}`);
        process.env.DATABASE_URL = target.toString();
        process.env.PRISMA_CONNECTION_LIMIT = String(limit);
        const prisma = new PrismaService();
        try {
          await prisma.$connect();
          // Fail closed if this is not a freshly provisioned rehearsal schema.
          expect(await prisma.appUser.count()).toBe(0);
          expect(await prisma.uploadBatch.count()).toBe(0);
          const authUserId = randomUUID();
          const email = "contention@example.invalid";
          const actor = await prisma.appUser.create({ data: {
            authUserId, email, normalizedEmail: email, name: "Synthetic reader",
            role: AppRole.USER, inviteStatus: InviteStatus.ACTIVE
          } });
          const uploader = await prisma.appUser.create({ data: {
            name: "Synthetic uploader", role: AppRole.ADMIN, inviteStatus: InviteStatus.ACTIVE
          } });
          await prisma.exchangeRate.create({ data: {
            rateDate: new Date("2026-08-10"), sourceDate: new Date("2026-08-10"),
            rate: 1350, providerPayload: { synthetic: true }
          } });
          const { auth, cookies } = syntheticAuth(prisma, authUserId, email);
          const config = new ConfigService({ STORAGE_PROVIDER: "local" });
          const writer = new MetaEntityWriterService(prisma);
          const versions = new MetaMetricVersionService(prisma);
          const exchangeRates = new ExchangeRatesService(prisma, {
            fetchRates: async () => { throw new Error("Unexpected external exchange rate request"); }
          } as never, config);
          const storage = new UploadStorageService(config);
          // External object storage is excluded, just like the external identity provider.
          // Keep the real batch reservation/storage-state transition and all SQL work.
          vi.spyOn(storage, "putOriginalFile").mockImplementation(async (file, reference) => ({
            key: reference.slice("local:".length), size: file.buffer.length,
            hash: createHash("sha256").update(file.buffer).digest("hex")
          }));
          const importer = new MetaAdDailyImportService(prisma, storage, writer,
            versions, new MetaAdsetAggregateService(prisma, versions), new MappingsService(prisma),
            new UploadExchangeRateService(prisma, exchangeRates));
          const baselineSession = await auth.login(email, "synthetic-password");
          const baseline = await probes(auth, cookies, prisma, actor.id, email, baselineSession);
          expect(baseline.every((item) => item.ok)).toBe(true);
          console.info(JSON.stringify({ kind: "upload-auth-baseline", limit, probes: baseline }));

          const file = syntheticCsv();
          for (let repeat = 1; repeat <= REPEATS; repeat++) {
            const session = await auth.login(email, "synthetic-password");
            let beginMixedRequests!: () => void;
            const firstRow = new Promise<void>((resolve) => { beginMixedRequests = resolve; });
            const originalUpsert = writer.upsertCampaign.bind(writer);
            // Observe the first real write; no sleeps, fake work, or changed transaction options.
            const writeSpy = vi.spyOn(writer, "upsertCampaign").mockImplementationOnce(async (...args) => {
              const result = await originalUpsert(...args);
              beginMixedRequests();
              return result;
            });
            let parseMs = 0;
            const originalParse = MetaAdDailyCsvParser.prototype.parseBuffer;
            const parseSpy = vi.spyOn(MetaAdDailyCsvParser.prototype, "parseBuffer")
              .mockImplementation(function (this: MetaAdDailyCsvParser, ...args) {
                const started = performance.now();
                try { return originalParse.apply(this, args); }
                finally { parseMs += performance.now() - started; }
              });
            const loop = monitorEventLoopDelay({ resolution: 10 });
            const cpuStart = process.cpuUsage();
            let peakRss = process.memoryUsage().rss;
            const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
            loop.enable();
            const started = performance.now();
            let importMs = 0;
            const upload = importer.importMetaAdDailyCsv(file, ConflictPolicy.NEW_VERSION, uploader.id)
              .then((result) => { importMs = performance.now() - started; return result; });
            try {
              // If import fails before the hook, reject immediately instead of hanging.
              await Promise.race([firstRow, upload.then(() => { throw new Error("Import ended before first write"); })]);
              const writeObservedMs = performance.now() - started;
              const mixed = await probes(auth, cookies, prisma, actor.id, email, session);
              const imported = await upload;
              const cpu = process.cpuUsage(cpuStart);
              console.info(JSON.stringify({ kind: "upload-auth-contention", limit, repeat,
                rowCount: ROW_COUNT, bytes: file.size, parseMs: rounded(parseMs),
                firstWriteMs: rounded(writeObservedMs), importMs: rounded(importMs),
                cpuUserMs: rounded(cpu.user / 1000), cpuSystemMs: rounded(cpu.system / 1000),
                peakRssMiB: rounded(peakRss / 1024 / 1024), eventLoopMaxMs: rounded(loop.max / 1e6),
                probes: mixed }));
              expect(imported).toMatchObject({ status: "IMPORTED", rowCount: ROW_COUNT,
                validRowCount: ROW_COUNT, importedAdMetricCount: ROW_COUNT, errorCount: 0 });
              expect(await prisma.uploadRow.count({ where: { uploadBatchId: imported.batchId } })).toBe(ROW_COUNT);
              const current = await prisma.metaAdDailyMetric.aggregate({ where: { isCurrent: true },
                _count: true, _sum: { spendUsd: true } });
              expect(current._count).toBe(ROW_COUNT);
              expect(Number(current._sum.spendUsd)).toBe(ROW_COUNT * 10);
              const aggregate = await prisma.metaAdsetDailyMetric.aggregate({ where: { isCurrent: true },
                _sum: { spendUsd: true } });
              expect(Number(aggregate._sum.spendUsd)).toBe(ROW_COUNT * 10);
              if (limit >= 2) {
                expect(mixed.every((item) => item.ok)).toBe(true);
                expect(mixed.every((item) => item.ms < 5000)).toBe(true);
              }
            } finally {
              await upload.catch(() => undefined);
              clearInterval(sampler);
              loop.disable();
              writeSpy.mockRestore();
              parseSpy.mockRestore();
            }
          }
          const before = await prisma.uploadBatch.count();
          await importer.importMetaAdDailyCsv(file, ConflictPolicy.SKIP, uploader.id);
          expect(await prisma.uploadBatch.count()).toBe(before);
          const rowsBeforeFailure = await prisma.uploadRow.count();
          const metricsBeforeFailure = await prisma.metaAdDailyMetric.count();
          const originalImport = versions.importAdDailyMetric.bind(versions);
          let writtenRows = 0;
          const failDuringWrite = vi.spyOn(versions, "importAdDailyMetric").mockImplementation(async (...args) => {
            const result = await originalImport(...args);
            if (++writtenRows === 2) throw new Error("Synthetic transaction failure");
            return result;
          });
          try {
            await expect(importer.importMetaAdDailyCsv(file, ConflictPolicy.NEW_VERSION, uploader.id))
              .rejects.toThrow("Synthetic transaction failure");
          } finally { failDuringWrite.mockRestore(); }
          expect(await prisma.uploadRow.count()).toBe(rowsBeforeFailure);
          expect(await prisma.metaAdDailyMetric.count()).toBe(metricsBeforeFailure);
          const retained = await prisma.metaAdDailyMetric.aggregate({ where: { isCurrent: true },
            _count: true, _sum: { spendUsd: true } });
          expect(retained._count).toBe(ROW_COUNT);
          expect(Number(retained._sum.spendUsd)).toBe(ROW_COUNT * 10);
          await expect(auth.login(email, "wrong-password")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
          await prisma.appUser.update({ where: { id: actor.id }, data: { isActive: false } });
          await expect(auth.login(email, "synthetic-password")).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
        } finally { await prisma.$disconnect(); }
      }
    } finally {
      if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
      if (previousLimit === undefined) delete process.env.PRISMA_CONNECTION_LIMIT; else process.env.PRISMA_CONNECTION_LIMIT = previousLimit;
      vi.restoreAllMocks();
    }
  }, 300_000);
});

function guardedTarget() {
  const raw = process.env.UPLOAD_AUTH_TEST_DATABASE_URL;
  if (!raw) throw new Error("UPLOAD_AUTH_TEST_DATABASE_URL is required");
  const target = new URL(raw);
  if (target.protocol !== "postgresql:" || target.hostname !== "127.0.0.1" ||
      target.pathname !== "/meta_ads_contention" || target.username !== "contention_test" ||
      !target.port || !target.password || process.env.CONFIRM_DISPOSABLE_UPLOAD_AUTH_DB !== "meta_ads_contention") {
    throw new Error("An explicitly confirmed disposable local contention database is required");
  }
  // No external host/socket overrides or arbitrary Prisma URL parameters.
  if ([...target.searchParams.keys()].some((key) => key !== "schema")) {
    throw new Error("Only the schema query parameter is allowed on the rehearsal URL");
  }
  return target;
}

function syntheticAuth(prisma: PrismaService, subject: string, email: string) {
  const sessions = new Map<string, { session: ProviderSession; verified: VerifiedAccessToken }>();
  const createSession = () => {
    const token = randomUUID();
    const session = { accessToken: token, refreshToken: token, expiresIn: 3600,
      user: { id: subject, email, emailVerified: true } };
    sessions.set(token, { session, verified: { subject, sessionId: randomUUID(), expiresAt: Date.now() / 1000 + 3600 } });
    return session;
  };
  const unused = async (): Promise<never> => { throw new Error("Unexpected identity provider operation"); };
  const provider: IdentityProvider = {
    signInWithPassword: async (_email: string, password: string) => {
      if (password !== "synthetic-password") throw new ProviderInvalidCredentialsError();
      return createSession();
    },
    refreshSession: async (token: string) => sessions.get(token)!.session,
    revokeSession: async () => undefined,
    getUserById: unused, inviteUserByEmail: unused, verifyInvitationToken: unused,
    updatePassword: unused, deleteInvitationUser: unused
  };
  const verifier = { verify: async (token: string) => sessions.get(token)!.verified } as SupabaseJwtVerifier;
  const secret = () => randomBytes(48).toString("base64url");
  const cookies = new AuthCookieService({ production: false, cookieSecure: false,
    sessionHandleSecret: secret(), authorizationVersionSecret: secret(), csrfSecret: secret() } as AuthConfig);
  return { auth: new AuthService(prisma, provider, verifier, cookies), cookies };
}

async function probes(auth: AuthService, cookies: AuthCookieService, prisma: PrismaService,
  actorId: string, email: string, session: Awaited<ReturnType<AuthService["login"]>>) {
  let signedHandle = "";
  cookies.setAuthenticatedCookies({ cookie: (name: string, value: string) => {
    if (name === cookies.sessionCookieName) signedHandle = value;
  } } as Response, session.cookies);
  return Promise.all([
    measure("login", () => auth.login(email, "synthetic-password")),
    measure("refresh", async () => {
      const result = await auth.refresh(session.cookies.refreshToken, signedHandle);
      if (!("response" in result)) throw new Error("Refresh recovered without authenticating");
      return result;
    }),
    measure("read", () => prisma.appUser.findUniqueOrThrow({ where: { id: actorId }, select: { id: true } }))
  ]);
}

async function measure(name: string, action: () => Promise<unknown>) {
  const started = performance.now();
  try { await action(); return { name, ok: true, ms: rounded(performance.now() - started) }; }
  catch (error) {
    // Never log database URLs, SQL arguments, credentials, tokens or raw error messages.
    return { name, ok: false, ms: rounded(performance.now() - started),
      error: error instanceof Prisma.PrismaClientKnownRequestError || error instanceof AuthHttpException ? error.code :
        error instanceof Error ? error.constructor.name : "UnknownError" };
  }
}

function rounded(value: number) { return Math.round(value * 100) / 100; }

function syntheticCsv(): Express.Multer.File {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [META_AD_DAILY_CSV_COLUMNS.map(cell).join(",")];
  for (let index = 0; index < ROW_COUNT; index++) {
    const row: Record<string, string> = {
      "보고 시작": "2026-08-10", "보고 종료": "2026-08-10", "캠페인 이름": "Synthetic campaign",
      "캠페인 ID": "campaign-contention", "광고 세트 이름": "Synthetic adset", "광고 세트 ID": "adset-contention",
      "광고 이름": `260810_소재_${index}`, "광고 ID": `ad-${index}`, "광고 게재": "active",
      "지출 금액 (USD)": "10", "노출": "100", "도달": "80", "결과": "1", "결과 표시 도구": "구매"
    };
    lines.push(META_AD_DAILY_CSV_COLUMNS.map((header) => cell(row[header] ?? "")).join(","));
  }
  const buffer = Buffer.from(lines.join("\n"), "utf8");
  return { buffer, originalname: "synthetic-contention.csv", size: buffer.length } as Express.Multer.File;
}
