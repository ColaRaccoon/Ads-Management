import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, ReportType } from "@prisma/client";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaService } from "../common/prisma.service";
import { parseDateRange } from "../common/date-range";
import { MetricsService } from "../metrics/metrics.service";

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly config: ConfigService
  ) {}

  async export(body: { reportType?: string; from?: string; to?: string; parameters?: Record<string, unknown> }) {
    const reportType = parseReportType(body.reportType);
    const range = parseDateRange(body.from, body.to);
    const report = await this.prisma.reportExport.create({
      data: {
        reportType,
        periodStart: range.fromDate,
        periodEnd: range.toDate,
        parameters: (body.parameters ?? {}) as Prisma.InputJsonObject,
        status: "CREATING"
      }
    });

    const extension = reportType === ReportType.DAILY_HTML ? "html" : "xlsx";
    const relativePath = await this.reportPath(report.id, extension);
    const absolutePath = path.resolve(process.cwd(), relativePath);

    if (extension === "html") {
      const html = await this.renderHtml(range.from, range.to);
      await writeFile(absolutePath, html, "utf8");
    } else {
      const workbook = await this.renderWorkbook(range.from, range.to, reportType);
      await workbook.xlsx.writeFile(absolutePath);
    }

    const hash = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
    return this.prisma.reportExport.update({
      where: { id: report.id },
      data: {
        filePath: relativePath.replace(/\\/g, "/"),
        fileHashSha256: hash,
        status: "CREATED"
      }
    });
  }

  list() {
    return this.prisma.reportExport.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  }

  async download(id: string) {
    const report = await this.prisma.reportExport.findUnique({ where: { id } });
    if (!report?.filePath) {
      throw new NotFoundException({ code: "REPORT_NOT_FOUND", message: "보고서 파일을 찾을 수 없습니다." });
    }
    const absolutePath = path.resolve(process.cwd(), report.filePath);
    const extension = report.reportType === ReportType.DAILY_HTML ? "html" : "xlsx";
    return {
      absolutePath,
      filename: `${report.reportType}-${report.periodStart.toISOString().slice(0, 10)}-${report.periodEnd
        .toISOString()
        .slice(0, 10)}.${extension}`
    };
  }

  private async renderHtml(from: string, to: string) {
    const [summary, products, adsets, unmatched, decisions] = await Promise.all([
      this.metricsService.dashboardSummary(from, to),
      this.metricsService.productMetrics(from, to),
      this.metricsService.adsetMetrics({ from, to }),
      this.metricsService.unmatchedMetrics(from, to),
      this.prisma.decisionLog.findMany({ where: { periodStart: new Date(`${from}T00:00:00.000Z`), periodEnd: new Date(`${to}T00:00:00.000Z`) }, take: 20 })
    ]);
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
  <p>제품별로는 ${bestProduct?.product?.displayName ?? "-"}가 가장 높은 마진을 보였고, ${worstProduct?.product?.displayName ?? "-"}는 점검 후보입니다.</p>
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
    const [summary, products, adsets, unmatched, decisions, changeLogs] = await Promise.all([
      this.metricsService.dashboardSummary(from, to),
      this.metricsService.productMetrics(from, to),
      this.metricsService.adsetMetrics({ from, to }),
      this.metricsService.unmatchedMetrics(from, to),
      this.prisma.decisionLog.findMany({
        where: { periodStart: new Date(`${from}T00:00:00.000Z`), periodEnd: new Date(`${to}T00:00:00.000Z`) },
        orderBy: { createdAt: "desc" }
      }),
      this.prisma.changeLog.findMany({
        where: { actionDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
        orderBy: { actionDate: "desc" }
      })
    ]);

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

  private async reportPath(reportId: string, extension: string) {
    const now = new Date();
    const storageDir = this.config.get<string>("REPORT_STORAGE_DIR") ?? "./storage/reports";
    const targetDir = path.resolve(process.cwd(), storageDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"));
    await mkdir(targetDir, { recursive: true });
    return path.relative(process.cwd(), path.join(targetDir, `${reportId}.${extension}`));
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

function addRows(sheet: ExcelJS.Worksheet, rows: unknown[][]) {
  rows.forEach((row) => sheet.addRow(row));
}

function addObjectRows(sheet: ExcelJS.Worksheet, rows: unknown[]) {
  if (rows.length === 0) {
    sheet.addRow(["No data"]);
    return;
  }
  const flattened = rows.map((row) => flatten(row));
  const columns = Array.from(new Set(flattened.flatMap((row) => Object.keys(row))));
  sheet.addRow(columns);
  flattened.forEach((row) => sheet.addRow(columns.map((column) => row[column] ?? "")));
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
