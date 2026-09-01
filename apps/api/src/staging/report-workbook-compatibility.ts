import ExcelJS from "exceljs";
import { businessCompatibilityDigest } from "./business-compatibility-contract";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_ROWS = 100_000;
const MAX_REPORT_CELLS = 1_000_000;
const MAX_UUID_CANONICAL_PERMUTATIONS = 100_000;
const EXPECTED_SHEETS = ["Summary", "Product Performance", "Adset Performance", "Decisions", "Unmatched", "Change Logs"];
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SUMMARY_LABELS = [
  "Period", "Report Type", "Spend USD", "Spend KRW", "Purchases", "CPA KRW",
  "Revenue KRW", "Margin KRW", "Unmatched", "Missing Cost Rules", "Missing CPA Rules"
];

export async function reportWorkbookCompatibility(
  bytes: Buffer,
  expected: { from: string; to: string; reportType: string; runId: string }
) {
  if (bytes.length < 1 || bytes.length > MAX_REPORT_BYTES) throw new Error("REPORT_COMPATIBILITY_SIZE_INVALID");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  if (workbook.worksheets.map((sheet) => sheet.name).join("|") !== EXPECTED_SHEETS.join("|")) {
    throw new Error("REPORT_COMPATIBILITY_SHEETS_INVALID");
  }

  const summarySheet = workbook.getWorksheet("Summary")!;
  if (summarySheet.rowCount !== SUMMARY_LABELS.length) throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
  const summary = Object.fromEntries(SUMMARY_LABELS.map((label, index) => {
    const row = summarySheet.getRow(index + 1);
    if (primitive(row.getCell(1).value) !== label) throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
    return [label, normalized(row.getCell(2).value, expected.runId)];
  }));
  if (summary.Period !== `${expected.from} ~ ${expected.to}` || summary["Report Type"] !== expected.reportType) {
    throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
  }
  for (const label of SUMMARY_LABELS.slice(2)) {
    if (typeof summary[label] !== "number" || !Number.isFinite(summary[label])) throw new Error("REPORT_COMPATIBILITY_SUMMARY_INVALID");
  }

  let cellCount = SUMMARY_LABELS.length * 2;
  const products = projectedSheet(workbook.getWorksheet("Product Performance")!, [
    "product.code", "product.name", "product.displayName", "totals.spendUsd", "totals.spendKrw",
    "totals.purchaseCount", "totals.cpaKrw", "totals.revenueKrw", "totals.marginKrw"
  ], expected.runId);
  const adsets = projectedSheet(workbook.getWorksheet("Adset Performance")!, [
    "adsetName", "stage", "product.displayName", "totals.spendUsd", "totals.spendKrw",
    "totals.purchaseCount", "totals.cpaKrw", "totals.revenueKrw", "totals.marginKrw"
  ], expected.runId);
  const decisions = projectedSheet(workbook.getWorksheet("Decisions")!, [
    "scopeType", "decision", "severity", "reason", "recommendedAction"
  ], expected.runId);
  const unmatched = projectedSheet(workbook.getWorksheet("Unmatched")!, [
    "metricDate", "adsetName", "spendUsd", "resultCount"
  ], expected.runId, true);
  const changeLogs = projectedSheet(workbook.getWorksheet("Change Logs")!, [
    "actionDate", "actionType", "entityType", "reason"
  ], expected.runId, true);
  for (const sheet of [products, adsets, decisions, unmatched, changeLogs]) {
    cellCount += sheet.columns.length + sheet.rows.reduce((total, row) => total + Object.keys(row).length, 0);
  }
  if (cellCount > MAX_REPORT_CELLS) throw new Error("REPORT_COMPATIBILITY_CELL_LIMIT");
  if (!products.rows.some((row) => row["product.displayName"] === "Compatibility product")) {
    throw new Error("REPORT_COMPATIBILITY_PRODUCT_MISSING");
  }
  if (!adsets.rows.some((row) => row.adsetName === "Compatibility <RUN_ID>")) {
    throw new Error("REPORT_COMPATIBILITY_ADSET_MISSING");
  }
  if (decisions.rows.length < 1) throw new Error("REPORT_COMPATIBILITY_DECISIONS_MISSING");
  return businessCompatibilityDigest(canonicalizeUuidRelationships({
    summary, products, adsets, decisions, unmatched, changeLogs
  }));
}

type Primitive = string | number | boolean | null;
type ProjectedSheet = { columns: string[]; rows: Record<string, Primitive>[] };
type CompatibilityWorkbook = {
  summary: Record<string, Primitive>;
  products: ProjectedSheet;
  adsets: ProjectedSheet;
  decisions: ProjectedSheet;
  unmatched: ProjectedSheet;
  changeLogs: ProjectedSheet;
};

function canonicalizeUuidRelationships(workbook: CompatibilityWorkbook) {
  const sheets: Array<[keyof Omit<CompatibilityWorkbook, "summary">, ProjectedSheet]> = [
    ["products", workbook.products], ["adsets", workbook.adsets], ["decisions", workbook.decisions],
    ["unmatched", workbook.unmatched], ["changeLogs", workbook.changeLogs]
  ];
  const uuids = new Set<string>();
  for (const [column, value] of Object.entries(workbook.summary)) {
    collectUuids(value, uuids);
  }
  for (const [, sheet] of sheets) {
    for (const row of sheet.rows) {
      for (const column of sheet.columns) collectUuids(row[column], uuids);
    }
  }
  let aliases = new Map([...uuids].map((uuid) => [uuid, "<UUID_1>"]));
  let contexts = collectRelationshipContexts(workbook, sheets, aliases);
  let stable = aliases.size === 0;
  for (let iteration = 0; !stable && iteration < 32; iteration += 1) {
    const fingerprints = new Map([...aliases].map(([uuid, alias]) => [
      uuid, JSON.stringify({ alias, contexts: [...(contexts.get(uuid) ?? [])].sort() })
    ]));
    const orderedFingerprints = [...new Set(fingerprints.values())].sort();
    const fingerprintAliases = new Map(orderedFingerprints.map((fingerprint, index) => [
      fingerprint, `<UUID_${index + 1}>`
    ]));
    const refined = new Map([...fingerprints].map(([uuid, fingerprint]) => [
      uuid, fingerprintAliases.get(fingerprint)!
    ]));
    stable = new Set(refined.values()).size === new Set(aliases.values()).size;
    aliases = refined;
    contexts = collectRelationshipContexts(workbook, sheets, aliases);
  }
  if (!stable) throw new Error("REPORT_COMPATIBILITY_UUID_REFINEMENT_LIMIT");
  const classMembers = new Map<string, string[]>();
  for (const [uuid, alias] of aliases) classMembers.set(alias, [...(classMembers.get(alias) ?? []), uuid]);
  const classes = [...classMembers].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  let permutationCount = 1;
  for (const [, members] of classes) {
    for (let factor = 2; factor <= members.length; factor += 1) {
      if (permutationCount > MAX_UUID_CANONICAL_PERMUTATIONS / factor) {
        throw new Error("REPORT_COMPATIBILITY_UUID_SYMMETRY_LIMIT");
      }
      permutationCount *= factor;
    }
  }
  let best: CompatibilityWorkbook | undefined;
  let bestKey: string | undefined;
  const exactAliases = new Map<string, string>();
  const visitClass = (classIndex: number, aliasOffset: number) => {
    if (classIndex === classes.length) {
      const candidate = canonicalWorkbook(workbook, sheets, exactAliases);
      const key = canonicalJson(candidate);
      if (bestKey === undefined || key < bestKey) { best = candidate; bestKey = key; }
      return;
    }
    const members = classes[classIndex][1];
    forEachPermutation(members, (permutation) => {
      permutation.forEach((uuid, index) => exactAliases.set(uuid, `<UUID_${aliasOffset + index + 1}>`));
      visitClass(classIndex + 1, aliasOffset + members.length);
      for (const uuid of permutation) exactAliases.delete(uuid);
    });
  };
  visitClass(0, 0);
  return best ?? canonicalWorkbook(workbook, sheets, exactAliases);
}

function canonicalWorkbook(
  workbook: CompatibilityWorkbook,
  sheets: Array<[keyof Omit<CompatibilityWorkbook, "summary">, ProjectedSheet]>,
  aliases: Map<string, string>
): CompatibilityWorkbook {
  const summary = Object.fromEntries(Object.entries(workbook.summary).map(([column, value]) => [
    column, aliasUuids(value, aliases)
  ]));
  const canonicalSheets = Object.fromEntries(sheets.map(([name, sheet]) => {
    const rows = sheet.rows.map((row) => Object.fromEntries(sheet.columns.map((column) => [
      column, aliasUuids(row[column], aliases)
    ])));
    rows.sort((left, right) => {
      const leftKey = canonicalJson(left);
      const rightKey = canonicalJson(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    return [name, { columns: sheet.columns, rows }];
  })) as Omit<CompatibilityWorkbook, "summary">;
  return { summary, ...canonicalSheets };
}

function forEachPermutation(values: string[], visit: (permutation: string[]) => void) {
  const permutation = [...values];
  const generate = (index: number) => {
    if (index === permutation.length) { visit(permutation); return; }
    for (let cursor = index; cursor < permutation.length; cursor += 1) {
      [permutation[index], permutation[cursor]] = [permutation[cursor], permutation[index]];
      generate(index + 1);
      [permutation[index], permutation[cursor]] = [permutation[cursor], permutation[index]];
    }
  };
  generate(0);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function collectRelationshipContexts(
  workbook: CompatibilityWorkbook,
  sheets: Array<[keyof Omit<CompatibilityWorkbook, "summary">, ProjectedSheet]>,
  aliases: Map<string, string>
) {
  const contexts = new Map<string, string[]>();
  for (const [column, value] of Object.entries(workbook.summary)) {
    collectUuidContexts(value, JSON.stringify({
      sheet: "summary", column, value: aliasUuids(value, aliases)
    }), contexts);
  }
  for (const [sheetName, sheet] of sheets) {
    for (const row of sheet.rows) {
      const coloredRow = Object.fromEntries(sheet.columns.map((column) => [
        column, aliasUuids(row[column], aliases)
      ]));
      for (const column of sheet.columns) {
        collectUuidContexts(row[column], JSON.stringify({ sheet: sheetName, column, row: coloredRow }), contexts);
      }
    }
  }
  return contexts;
}

function collectUuids(value: Primitive, uuids: Set<string>) {
  if (typeof value !== "string") return;
  for (const uuid of value.match(UUID_PATTERN) ?? []) uuids.add(uuid.toLowerCase());
}

function collectUuidContexts(value: Primitive, context: string, contexts: Map<string, string[]>) {
  if (typeof value !== "string") return;
  for (const uuid of value.match(UUID_PATTERN) ?? []) {
    const key = uuid.toLowerCase();
    contexts.set(key, [...(contexts.get(key) ?? []), context]);
  }
}

function aliasUuids(value: Primitive, aliases: Map<string, string>): Primitive {
  return typeof value === "string"
    ? value.replace(UUID_PATTERN, (uuid) => aliases.get(uuid.toLowerCase()) ?? "<UUID_UNKNOWN>")
    : value;
}

function projectedSheet(
  sheet: ExcelJS.Worksheet,
  selectedColumns: string[],
  runId: string,
  allowEmpty = false
) {
  if (sheet.rowCount < 1 || sheet.rowCount > MAX_REPORT_ROWS) throw new Error("REPORT_COMPATIBILITY_ROW_LIMIT");
  if (primitive(sheet.getRow(1).getCell(1).value) === "No data") {
    if (!allowEmpty) throw new Error("REPORT_COMPATIBILITY_REQUIRED_ROWS_MISSING");
    if (sheet.rowCount !== 1 || sheet.getRow(1).cellCount !== 1) throw new Error("REPORT_COMPATIBILITY_EMPTY_SHEET_INVALID");
    return { columns: ["No data"], rows: [] };
  }
  const header = new Map<string, number>();
  const columns: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
    const value = primitive(cell.value);
    if (typeof value !== "string" || value.length < 1 || header.has(value)) throw new Error("REPORT_COMPATIBILITY_HEADER_INVALID");
    header.set(value, column);
    columns.push(value);
  });
  for (const column of selectedColumns) if (!header.has(column)) throw new Error("REPORT_COMPATIBILITY_COLUMN_MISSING");
  const rows: Record<string, Primitive>[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push(Object.fromEntries(columns.map((column) => [
      column,
      normalized(row.getCell(header.get(column)!).value, runId, column)
    ])));
  }
  return { columns, rows };
}

function primitive(value: ExcelJS.CellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  throw new Error("REPORT_COMPATIBILITY_CELL_INVALID");
}

function normalized(value: ExcelJS.CellValue, runId: string, column = "") {
  const result = primitive(value);
  if (typeof result !== "string") return result;
  if (/(^|\.)(createdAt|updatedAt)$/.test(column)) return "<TIMESTAMP>";
  return result.split(runId).join("<RUN_ID>");
}
