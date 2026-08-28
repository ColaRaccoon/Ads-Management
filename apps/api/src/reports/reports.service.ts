import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, ReportExport, ReportType } from "@prisma/client";
import ExcelJS from "exceljs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PrismaService } from "../common/prisma.service";
import { parseDateRange } from "../common/date-range";
import { safeExportCellValue } from "../common/safe-export-cell";
import { MetricsService } from "../metrics/metrics.service";
import {
  configuredFileStorage,
  configuredFileStorageForProvider
} from "../storage/configured-file-storage";
import {
  FileStorage,
  InvalidStorageKeyError,
  StoredFile,
  StorageIntegrityError,
  StorageObjectNotFoundError
} from "../storage/file-storage";
import {
  legacyLocalPathToKey,
  parseStorageReference,
  storageReference
} from "../storage/storage-reference";
import {
  DEFAULT_TEMP_STORAGE_BUDGET_BYTES,
  temporaryStorageBudget
} from "../storage/temporary-storage-budget";

@Injectable()
export class ReportsService implements OnApplicationBootstrap {
  private fileStorage?: FileStorage;
  private readonly serviceStartedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly config: ConfigService
  ) {}

  async onApplicationBootstrap() {
    await this.reconcileStaleCreatingReports(this.serviceStartedAt);
  }

  /**
   * Reconciles only rows that pre-date this service process. An in-process
   * export may legitimately be between its atomic payload publish and its DB
   * finalize; startup rows cannot belong to such a live request.
   */
  async reconcileStaleCreatingReports(cutoff = this.serviceStartedAt) {
    const result = { scanned: 0, created: 0, failed: 0, unresolved: 0 };
    let afterId: string | undefined;

    while (true) {
      const candidates = await this.prisma.reportExport.findMany({
        where: {
          status: "CREATING",
          createdAt: { lt: cutoff },
          ...(afterId ? { id: { gt: afterId } } : {})
        },
        orderBy: { id: "asc" },
        take: 1_000,
        select: { id: true, filePath: true }
      });
      if (candidates.length === 0) break;
      result.scanned += candidates.length;
      if (result.scanned > 100_000) throw new Error("REPORT_RECONCILIATION_LIMIT_EXCEEDED");

      for (const candidate of candidates) {
      if (!candidate.filePath) {
        const status = await this.confirmMissingCreatingReport(candidate.id, null);
        result[status] += 1;
        continue;
      }

      const inspected = await this.inspectCreatingReport(candidate.filePath);
      if (inspected === "MISSING") {
        const status = await this.confirmMissingCreatingReport(candidate.id, candidate.filePath);
        result[status] += 1;
        continue;
      }
      if (!inspected) {
        result.unresolved += 1;
        continue;
      }

      try {
        // A stale CREATING row has no committed expected hash. Never bless the
        // bytes found at its path as a successful report. A concurrent/lost-ACK
        // finalize may still win this conditional update and is recognized by
        // the fresh read below using its DB-persisted hash.
        await this.prisma.reportExport.updateMany({
          where: {
            id: candidate.id,
            status: "CREATING",
            filePath: candidate.filePath,
            fileHashSha256: null
          },
          data: { status: "FAILED", fileHashSha256: null }
        });
      } catch {
        // A fresh read plus exact byte verification below is authoritative.
      }
      const status = await this.readReportStatus(
        candidate.id,
        candidate.filePath,
        inspected.stored,
        inspected.storage
      );
      if (status === "failed") {
        if (!await this.storedObjectMatches(inspected.stored, inspected.storage)) {
          result.unresolved += 1;
          continue;
        }
        const deleted = await inspected.storage.delete(inspected.stored.key);
        if (!deleted && await inspected.storage.exists(inspected.stored.key)) {
          result.unresolved += 1;
          continue;
        }
      }
      result[status] += 1;
      }
      afterId = candidates[candidates.length - 1].id;
      if (candidates.length < 1_000) break;
    }
    return result;
  }

  async export(
    body: { reportType?: string; from?: string; to?: string; parameters?: Record<string, unknown> },
    actorId: string
  ) {
    const reportType = parseReportType(body.reportType);
    const range = parseDateRange(body.from, body.to);
    const reportId = randomUUID();
    const extension = reportType === ReportType.DAILY_HTML ? "html" : "xlsx";
    const reference = this.reportReference(reportId, extension);
    const report = await this.prisma.reportExport.create({
      data: {
        id: reportId,
        reportType,
        periodStart: range.fromDate,
        periodEnd: range.toDate,
        parameters: (body.parameters ?? {}) as Prisma.InputJsonObject,
        filePath: reference,
        status: "CREATING",
        createdBy: actorId
      }
    });

    let stored: StoredFile | undefined;
    try {
      const body = extension === "html"
        ? Buffer.from(await this.renderHtml(range.from, range.to), "utf8")
        : Buffer.from(await (await this.renderWorkbook(range.from, range.to, reportType)).xlsx.writeBuffer());
      const parsed = this.explicitCurrentReference(reference);
      const result = await this.storage.put({
        key: parsed.key,
        body,
        expectedHashSha256: createHash("sha256").update(body).digest("hex")
      });
      stored = result;
      return await this.prisma.reportExport.update({
        where: { id: report.id },
        data: {
          fileHashSha256: result.hash,
          status: "CREATED"
        }
      });
    } catch {
      if (stored) {
        const committed = await this.reconcileStoredReport(report.id, reference, stored);
        if (committed) return committed;
      } else {
        await this.prisma.reportExport.update({
          where: { id: report.id },
          data: { status: "FAILED", fileHashSha256: null }
        }).catch(() => undefined);
      }
      throw new ServiceUnavailableException({
        code: "REPORT_STORAGE_UNAVAILABLE",
        message: "The report could not be stored and remains available for a safe retry."
      });
    }
  }

  list() {
    return this.prisma.reportExport.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        reportType: true,
        periodStart: true,
        periodEnd: true,
        parameters: true,
        fileHashSha256: true,
        status: true,
        createdBy: true,
        createdAt: true
      }
    });
  }

  async download(id: string) {
    const report = await this.prisma.reportExport.findUnique({ where: { id } });
    if (!report?.filePath || report.status !== "CREATED") {
      throw new NotFoundException({ code: "REPORT_NOT_FOUND", message: "보고서 파일을 찾을 수 없습니다." });
    }
    const extension = report.reportType === ReportType.DAILY_HTML ? "html" : "xlsx";
    try {
      const resolved = this.storageFromStoredReference(report.filePath);
      if (!report.fileHashSha256 || !/^[a-f0-9]{64}$/i.test(report.fileHashSha256)) {
        throw new StorageIntegrityError();
      }
      const stored = await resolved.storage.getStream(resolved.key);
      const verified = await verifyDownloadBeforePublication(
        stored,
        report.fileHashSha256,
        this.maxStoredReportBytes,
        this.temporaryStorageBudgetBytes,
        this.downloadMaxLifetimeMs
      );
      return {
        ...verified,
        contentType: extension === "html"
          ? "text/html; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `${report.reportType}-${report.periodStart.toISOString().slice(0, 10)}-${report.periodEnd
          .toISOString()
          .slice(0, 10)}.${extension}`
      };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError || error instanceof InvalidStorageKeyError) {
        throw new NotFoundException({ code: "REPORT_NOT_FOUND", message: "보고서 파일을 찾을 수 없습니다." });
      }
      if (error instanceof StorageIntegrityError) throw reportIntegrityUnavailable();
      throw new ServiceUnavailableException({
        code: "REPORT_STORAGE_UNAVAILABLE",
        message: "The report storage service is temporarily unavailable."
      });
    }
  }

  private async renderHtml(from: string, to: string) {
    const [summary, products, adsets, unmatched, decisions] = await this.reportSnapshot((client) => Promise.all([
      this.metricsService.dashboardSummary(from, to, undefined, undefined, client),
      this.metricsService.productMetrics(from, to, undefined, client),
      this.metricsService.adsetMetrics({ from, to }, client),
      this.metricsService.unmatchedMetrics(from, to, undefined, client),
      client.decisionLog.findMany({ where: { periodStart: new Date(`${from}T00:00:00.000Z`), periodEnd: new Date(`${to}T00:00:00.000Z`) }, take: 20 })
    ]));
    const bestProduct = products.sort((a, b) => (b.totals.marginKrw ?? -Infinity) - (a.totals.marginKrw ?? -Infinity))[0];
    const worstProduct = products.sort((a, b) => (a.totals.marginKrw ?? Infinity) - (b.totals.marginKrw ?? Infinity))[0];
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <title>Meta Ads Performance Hub Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #17202a; }
    h1 { font-size: 24px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #d8dee6; padding: 8px; text-align: left; font-size: 13px; }
    th { background: #f3f6f8; }
    .warn { color: #a15c00; font-weight: 700; }
  </style>
</head>
<body>
  <h1>Meta Ads Performance Hub Report</h1>
  <p>선택 기간 기준 총 광고비는 ${fmt(summary.totals.spendKrw)}원, 구매수는 ${summary.totals.purchaseCount}건, 누적 CPA는 ${fmt(summary.totals.cpaKrw)}원입니다.</p>
  <p>제품별로는 ${escapeHtml(String(bestProduct?.product?.displayName ?? "-"))}가 가장 높은 마진을 보였고, ${escapeHtml(String(worstProduct?.product?.displayName ?? "-"))}는 점검 후보입니다.</p>
  <p class="warn">미매칭 ${summary.health.unmatchedCount}건, 원가 기준 미설정 ${summary.health.missingCostRuleCount}개, CPA 기준 미설정 ${summary.health.missingCpaRuleCount}개</p>
  <h2>KPI</h2>
  <table><tbody>
    <tr><th>Spend USD</th><td>${summary.totals.spendUsd.toFixed(2)}</td><th>Spend KRW</th><td>${fmt(summary.totals.spendKrw)}</td></tr>
    <tr><th>Purchases</th><td>${summary.totals.purchaseCount}</td><th>CPA KRW</th><td>${fmt(summary.totals.cpaKrw)}</td></tr>
    <tr><th>Revenue KRW</th><td>${fmt(summary.totals.revenueKrw)}</td><th>Margin KRW</th><td>${fmt(summary.totals.marginKrw)}</td></tr>
  </tbody></table>
  <h2>Product Performance</h2>
  ${table(products, ["product.displayName", "totals.spendKrw", "totals.purchaseCount", "totals.cpaKrw", "targetCpaKrw", "breakEvenCpaKrw", "watchCpaKrw", "stopCpaKrw", "totals.marginKrw", "ruleStatus"])}
  <h2>Adset Performance</h2>
  ${table(adsets.slice(0, 50), ["adsetName", "stage", "product.displayName", "totals.spendKrw", "totals.purchaseCount", "totals.cpaKrw", "totals.marginKrw"])}
  <h2>Decisions</h2>
  ${table(decisions, ["scopeType", "decision", "severity", "reason", "recommendedAction"])}
  <h2>Unmatched</h2>
  ${table(unmatched, ["metricDate", "adsetName", "spendUsd", "resultCount"])}
</body>
</html>`;
  }

  private async renderWorkbook(from: string, to: string, reportType: ReportType) {
    const [summary, products, adsets, unmatched, decisions, changeLogs] = await this.reportSnapshot((client) => Promise.all([
      this.metricsService.dashboardSummary(from, to, undefined, undefined, client),
      this.metricsService.productMetrics(from, to, undefined, client),
      this.metricsService.adsetMetrics({ from, to }, client),
      this.metricsService.unmatchedMetrics(from, to, undefined, client),
      client.decisionLog.findMany({
        where: { periodStart: new Date(`${from}T00:00:00.000Z`), periodEnd: new Date(`${to}T00:00:00.000Z`) },
        orderBy: { createdAt: "desc" }
      }),
      client.changeLog.findMany({
        where: { actionDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
        orderBy: { actionDate: "desc" }
      })
    ]));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Meta Ads Performance Hub";
    addRows(workbook.addWorksheet("Summary"), [
      ["Period", `${from} ~ ${to}`],
      ["Report Type", reportType],
      ["Spend USD", summary.totals.spendUsd],
      ["Spend KRW", summary.totals.spendKrw],
      ["Purchases", summary.totals.purchaseCount],
      ["CPA KRW", summary.totals.cpaKrw],
      ["Revenue KRW", summary.totals.revenueKrw],
      ["Margin KRW", summary.totals.marginKrw],
      ["Unmatched", summary.health.unmatchedCount],
      ["Missing Cost Rules", summary.health.missingCostRuleCount],
      ["Missing CPA Rules", summary.health.missingCpaRuleCount]
    ]);
    addObjectRows(workbook.addWorksheet("Product Performance"), products);
    addObjectRows(workbook.addWorksheet("Adset Performance"), adsets);
    addObjectRows(workbook.addWorksheet("Decisions"), decisions);
    addObjectRows(workbook.addWorksheet("Unmatched"), unmatched);
    addObjectRows(workbook.addWorksheet("Change Logs"), changeLogs);
    workbook.worksheets.forEach((sheet) => {
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.columns.forEach((column) => {
        column.width = 18;
      });
    });
    return workbook;
  }

  private reportReference(reportId: string, extension: string) {
    const now = new Date();
    const key = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${reportId}.${extension}`;
    return storageReference(this.storage.provider, key);
  }

  private reportSnapshot<T>(work: (client: Prisma.TransactionClient) => Promise<T>) {
    const transaction = (this.prisma as PrismaService & { $transaction?: PrismaService["$transaction"] }).$transaction;
    if (typeof transaction !== "function") {
      // Lightweight unit-test doubles do not expose Prisma transactions.
      return work(this.prisma as unknown as Prisma.TransactionClient);
    }
    return this.prisma.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 60_000
    });
  }

  private async reconcileStoredReport(
    reportId: string,
    reference: string,
    stored: StoredFile,
    storage = this.storage
  ) {
    let current: ReportExport | null;
    try {
      current = await this.prisma.reportExport.findUnique({ where: { id: reportId } });
    } catch {
      return null;
    }

    const committed = await this.confirmCommittedStoredReport(current, reference, stored, storage);
    if (committed) return committed;
    if (!current || current.filePath !== reference) return null;

    if (current.status === "CREATING" && current.fileHashSha256 === null) {
      try {
        await this.prisma.reportExport.updateMany({
          where: { id: reportId, status: "CREATING", filePath: reference, fileHashSha256: null },
          data: { status: "FAILED", fileHashSha256: null }
        });
      } catch {
        // The FAILED transition can have the same commit/ack ambiguity. The
        // second read below is the authority; never delete before it confirms.
      }
      try {
        current = await this.prisma.reportExport.findUnique({ where: { id: reportId } });
      } catch {
        return null;
      }
      const committedAfterRace = await this.confirmCommittedStoredReport(
        current,
        reference,
        stored,
        storage
      );
      if (committedAfterRace) return committedAfterRace;
    }

    if (
      current?.status === "FAILED" &&
      current.filePath === reference &&
      current.fileHashSha256 === null
    ) {
      if (await this.storedObjectMatches(stored, storage)) {
        await storage.delete(stored.key).catch(() => undefined);
      }
    }
    return null;
  }

  private async inspectCreatingReport(
    reference: string
  ): Promise<{ stored: StoredFile; storage: FileStorage } | "MISSING" | null> {
    let stream: Awaited<ReturnType<FileStorage["getStream"]>>["stream"] | undefined;
    try {
      const resolved = this.reconciliationStorageFromStoredReference(reference);
      const actual = await resolved.storage.getStream(resolved.key);
      stream = actual.stream;
      if (
        !Number.isSafeInteger(actual.size) || actual.size < 0 ||
        actual.size > this.maxStoredReportBytes
      ) {
        stream.destroy();
        return null;
      }
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > actual.size || size > this.maxStoredReportBytes) {
          stream.destroy();
          return null;
        }
        hash.update(bytes);
      }
      if (size !== actual.size) return null;
      return {
        stored: { key: resolved.key, hash: hash.digest("hex"), size },
        storage: resolved.storage
      };
    } catch (error) {
      stream?.destroy();
      if (error instanceof StorageObjectNotFoundError || error instanceof InvalidStorageKeyError) {
        return "MISSING";
      }
      return null;
    }
  }

  private async confirmMissingCreatingReport(reportId: string, reference: string | null) {
    try {
      await this.prisma.reportExport.updateMany({
        where: { id: reportId, status: "CREATING", filePath: reference, fileHashSha256: null },
        data: { status: "FAILED", fileHashSha256: null }
      });
    } catch {
      // The following read resolves a lost acknowledgement without guessing.
    }
    return this.readReportStatus(reportId);
  }

  private async readReportStatus(
    reportId: string,
    reference?: string,
    expected?: StoredFile,
    storage = this.storage
  ): Promise<"created" | "failed" | "unresolved"> {
    try {
      const current = await this.prisma.reportExport.findUnique({ where: { id: reportId } });
      if (
        current?.status === "CREATED" && reference && expected &&
        await this.confirmCommittedStoredReport(current, reference, expected, storage)
      ) return "created";
      if (current?.status === "FAILED") return "failed";
    } catch {
      // Preserve payload and CREATING state when the DB outcome is unavailable.
    }
    return "unresolved";
  }

  private async confirmCommittedStoredReport(
    report: ReportExport | null,
    reference: string,
    stored: StoredFile,
    storage = this.storage
  ) {
    if (
      !report || report.status !== "CREATED" || report.filePath !== reference ||
      report.fileHashSha256?.toLowerCase() !== stored.hash.toLowerCase()
    ) return null;
    let resolved: { key: string; storage: FileStorage };
    try {
      resolved = this.reconciliationStorageFromStoredReference(reference);
    } catch {
      return null;
    }
    if (resolved.storage.provider !== storage.provider || resolved.key !== stored.key) return null;
    return await this.storedObjectMatches(stored, storage) ? report : null;
  }

  private async storedObjectMatches(expected: StoredFile, storage = this.storage) {
    let stream: Awaited<ReturnType<FileStorage["getStream"]>>["stream"] | undefined;
    try {
      const actual = await storage.getStream(expected.key);
      stream = actual.stream;
      if (
        !Number.isSafeInteger(expected.size) || expected.size < 0 ||
        actual.size !== expected.size
      ) {
        stream.destroy();
        return false;
      }
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > expected.size) {
          stream.destroy();
          return false;
        }
        hash.update(bytes);
      }
      return size === expected.size && hash.digest("hex") === expected.hash.toLowerCase();
    } catch {
      stream?.destroy();
      return false;
    }
  }

  private storageFromStoredReference(reference: string) {
    const parsed = parseStorageReference(reference);
    if (parsed) {
      return {
        key: parsed.key,
        storage: configuredFileStorageForProvider(this.config, "reports", parsed.provider)
      };
    }
    const storage = configuredFileStorageForProvider(this.config, "reports", "local");
    if (!("rootPath" in storage) || typeof storage.rootPath !== "string") {
      throw new InvalidStorageKeyError();
    }
    return {
      key: legacyLocalPathToKey(reference, storage.rootPath),
      storage
    };
  }

  private reconciliationStorageFromStoredReference(reference: string) {
    const parsed = parseStorageReference(reference);
    if (parsed?.provider === this.storage.provider) {
      return { key: parsed.key, storage: this.storage };
    }
    return this.storageFromStoredReference(reference);
  }

  private explicitCurrentReference(reference: string) {
    const parsed = parseStorageReference(reference);
    if (!parsed || parsed.provider !== this.storage.provider) {
      throw new InvalidStorageKeyError();
    }
    return parsed;
  }

  private get storage() {
    return (this.fileStorage ??= configuredFileStorage(this.config, "reports"));
  }

  private get maxStoredReportBytes() {
    const configured = Number(this.config.get<string>("SUPABASE_STORAGE_MAX_OBJECT_BYTES") ?? 52_428_800);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 52_428_800;
  }

  private get temporaryStorageBudgetBytes() {
    const configured = Number(
      this.config.get<string>("TEMP_STORAGE_BUDGET_BYTES") ?? DEFAULT_TEMP_STORAGE_BUDGET_BYTES
    );
    return Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_TEMP_STORAGE_BUDGET_BYTES;
  }

  private get downloadMaxLifetimeMs() {
    const configured = Number(this.config.get<string>("REPORT_DOWNLOAD_MAX_LIFETIME_MS") ?? 300_000);
    return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 300_000
      ? configured
      : 300_000;
  }

}

function reportIntegrityUnavailable() {
  return new ServiceUnavailableException({
    code: "REPORT_STORAGE_INTEGRITY_FAILED",
    message: "The stored report failed integrity verification."
  });
}

async function verifyDownloadBeforePublication(
  stored: Awaited<ReturnType<FileStorage["getStream"]>>,
  expectedHashSha256: string,
  maxBytes: number,
  temporaryStorageBudgetBytes: number,
  downloadMaxLifetimeMs: number
) {
  if (!Number.isSafeInteger(stored.size) || stored.size < 0 || stored.size > maxBytes) {
    stored.stream.destroy();
    throw new StorageIntegrityError();
  }
  let lease: ReturnType<typeof temporaryStorageBudget.acquire>;
  try {
    lease = temporaryStorageBudget.acquire(stored.size, temporaryStorageBudgetBytes);
  } catch (error) {
    stored.stream.destroy();
    throw error;
  }
  let root: string | undefined;
  try {
    root = await mkdtemp(path.join(tmpdir(), "meta-report-download-"));
    const target = path.join(root, "verified-object");
    const hash = createHash("sha256");
    let size = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes || size > stored.size) return callback(new StorageIntegrityError());
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(stored.stream, measure, createWriteStream(target, { flags: "wx", mode: 0o600 }));
    if (size !== stored.size || hash.digest("hex") !== expectedHashSha256.toLowerCase()) {
      throw new StorageIntegrityError();
    }
    const stream = createReadStream(target);
    let cleaned = false;
    let lifetimeTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      void rm(root as string, { recursive: true, force: true })
        .catch(() => undefined)
        .finally(() => lease.release());
    };
    lifetimeTimer = setTimeout(() => {
      stream.destroy(new StorageIntegrityError());
    }, downloadMaxLifetimeMs);
    lifetimeTimer.unref();
    stream.once("close", cleanup);
    stream.once("error", cleanup);
    return { stream, size };
  } catch (error) {
    try {
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      lease.release();
    }
    if (error instanceof StorageIntegrityError) throw error;
    throw new StorageIntegrityError();
  }
}

function parseReportType(value?: string): ReportType {
  const text = String(value ?? ReportType.PERIOD_XLSX).toUpperCase();
  if (text in ReportType) {
    return ReportType[text as keyof typeof ReportType];
  }
  throw new BadRequestException({ code: "INVALID_REPORT_TYPE", message: "보고서 타입이 올바르지 않습니다." });
}

function fmt(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : Math.round(value).toLocaleString("ko-KR");
}

function valueAt(row: unknown, pathKey: string) {
  return pathKey.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in acc) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, row);
}

function table(rows: unknown[], columns: string[]) {
  const head = `<tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(String(valueAt(row, column) ?? "-"))}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

export function addRows(sheet: ExcelJS.Worksheet, rows: unknown[][]) {
  rows.forEach((row) => sheet.addRow(row.map(safeExportCellValue)));
}

export function addObjectRows(sheet: ExcelJS.Worksheet, rows: unknown[]) {
  if (rows.length === 0) {
    sheet.addRow(["No data"]);
    return;
  }
  const flattened = rows.map((row) => flatten(row));
  const columns = Array.from(new Set(flattened.flatMap((row) => Object.keys(row))));
  sheet.addRow(columns.map(safeExportCellValue));
  flattened.forEach((row) => sheet.addRow(columns.map((column) => safeExportCellValue(row[column] ?? ""))));
}

function flatten(value: unknown, prefix = ""): Record<string, string | number | boolean | null> {
  if (value === null || value === undefined) {
    return { [prefix || "value"]: null };
  }
  if (typeof value !== "object" || value instanceof Date) {
    return { [prefix || "value"]: value instanceof Date ? value.toISOString().slice(0, 10) : (value as string | number | boolean) };
  }
  if (Array.isArray(value)) {
    return { [prefix || "items"]: JSON.stringify(value) };
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string | number | boolean | null>>((acc, [key, child]) => {
    const childKey = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "object" && child !== null && !(child instanceof Date) && !Array.isArray(child)) {
      Object.assign(acc, flatten(child, childKey));
    } else if (Array.isArray(child)) {
      acc[childKey] = JSON.stringify(child);
    } else if (child instanceof Date) {
      acc[childKey] = child.toISOString().slice(0, 10);
    } else {
      acc[childKey] = child as string | number | boolean | null;
    }
    return acc;
  }, {});
}
