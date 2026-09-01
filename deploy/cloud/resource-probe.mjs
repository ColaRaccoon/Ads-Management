import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024;
const fixtureRoot = process.env.PROBE_FIXTURE_ROOT ?? "/fixtures";
const scenario = process.argv[2];

if (!scenario) throw new Error("A resource probe scenario is required.");

if (scenario === "generate") {
  await generateFixtures();
  process.stdout.write(`${JSON.stringify({ scenario, result: "PASS", fixtures: fixtureInventory() })}\n`);
} else {
  const result = await measure(scenario, () => runScenario(scenario));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.result !== "PASS") process.exitCode = 1;
}

async function runScenario(name) {
  const preflight = await import(pathToFileURL(
    "/srv/app/apps/api/dist/file-security/upload-preflight.js"
  ).href);
  if (name === "text-max") {
    const buffer = await readFile(path.join(fixtureRoot, "margin-max.csv"));
    return {
      inputBytes: buffer.length,
      inspection: preflight.inspectTextBuffer(buffer, "CSV", ".csv")
    };
  }
  if (name === "xlsx-max") {
    const buffer = await readFile(path.join(fixtureRoot, "workbook-max.xlsx"));
    return {
      inputBytes: buffer.length,
      inspection: await preflight.inspectXlsxBuffer(buffer)
    };
  }
  if (name === "bundle-max") {
    const [sales, ads, margin] = await Promise.all([
      readFile(path.join(fixtureRoot, "bundle-sales.xlsx")),
      readFile(path.join(fixtureRoot, "bundle-ads.xlsx")),
      readFile(path.join(fixtureRoot, "margin-max.csv"))
    ]);
    const file = (fieldname, originalname, mimetype, buffer) => ({
      fieldname,
      originalname,
      encoding: "7bit",
      mimetype,
      size: buffer.length,
      buffer
    });
    const bundle = {
      sales: [file("sales", "sales.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sales)],
      ads: [file("ads", "ads.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ads)],
      margin: [file("margin", "margin.csv", "text/csv", margin)]
    };
    return {
      inputBytes: sales.length + ads.length + margin.length,
      inspection: await preflight.preflightCoupangBundle(bundle)
    };
  }
  if (name === "report-max") return renderMaximumReport();
  if (name === "baseline") return { baseline: true };
  throw new Error(`Unknown resource probe scenario: ${name}`);
}

async function renderMaximumReport() {
  const ExcelJS = (await import("exceljs")).default;
  const reports = await import(pathToFileURL("/srv/app/apps/api/dist/reports/reports.service.js").href);
  const rows = Array.from({ length: 25_000 }, (_, index) => Object.fromEntries(
    Array.from({ length: 24 }, (_unused, column) => [
      `field_${String(column).padStart(2, "0")}`,
      column % 3 === 0 ? index * (column + 1) : `row-${index}-column-${column}`
    ])
  ));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "cloud-resource-probe";
  for (let sheet = 0; sheet < 5; sheet += 1) {
    reports.addObjectRows(
      workbook.addWorksheet(`Rows ${sheet + 1}`),
      rows.slice(sheet * 5_000, (sheet + 1) * 5_000)
    );
  }
  const target = "/tmp/report-max.xlsx";
  const spool = "/tmp/report-max-storage-spool.xlsx";
  await workbook.xlsx.writeFile(target);
  await pipeline(createReadStream(target), createWriteStream(spool, { flags: "wx", mode: 0o600 }));
  const size = (await stat(target)).size;
  if ((await stat(spool)).size !== size || size > 50 * MIB) {
    throw new Error("REPORT_PROBE_OUTPUT_INVALID");
  }
  return { sourceRows: rows.length, columns: 24, outputBytes: size, spooledCopies: 2 };
}

async function generateFixtures() {
  await mkdir(fixtureRoot, { recursive: true });
  for (const entry of await readdir(fixtureRoot)) {
    await rm(path.join(fixtureRoot, entry), { recursive: true, force: true });
  }
  const ExcelJS = (await import("exceljs")).default;
  const basePath = path.join(fixtureRoot, "base.xlsx");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: basePath,
    useStyles: false,
    useSharedStrings: false
  });
  const sheet = workbook.addWorksheet("Rows");
  sheet.addRow(Array.from({ length: 12 }, (_, index) => `column_${index + 1}`)).commit();
  for (let row = 1; row <= 100_000; row += 1) {
    sheet.addRow([
      row,
      `sku-${row}`,
      `campaign-${row % 100}`,
      `adset-${row % 1_000}`,
      row % 17,
      row * 1.01,
      row % 2,
      row % 3,
      row % 5,
      row % 7,
      row % 11,
      `2026-08-${String((row % 28) + 1).padStart(2, "0")}`
    ]).commit();
  }
  await workbook.commit();
  await paddedWorkbook(basePath, path.join(fixtureRoot, "workbook-max.xlsx"), 24 * MIB - 65_536);
  await paddedWorkbook(basePath, path.join(fixtureRoot, "bundle-sales.xlsx"), 20 * MIB);
  await paddedWorkbook(basePath, path.join(fixtureRoot, "bundle-ads.xlsx"), 20 * MIB);
  await generateMarginCsv(path.join(fixtureRoot, "margin-max.csv"));
  await rm(basePath, { force: true });
  const inventory = fixtureInventory();
  const bundleBytes = inventory["bundle-sales.xlsx"] + inventory["bundle-ads.xlsx"] + inventory["margin-max.csv"];
  if (inventory["workbook-max.xlsx"] > 24 * MIB || bundleBytes > 48 * MIB) {
    throw new Error("GENERATED_FIXTURE_EXCEEDS_TRANSPORT_LIMIT");
  }
}

async function paddedWorkbook(source, target, targetBytes) {
  const JSZip = (await import("jszip")).default;
  const sourceBytes = await readFile(source);
  const zip = await JSZip.loadAsync(sourceBytes);
  const paddingBytes = Math.max(0, targetBytes - sourceBytes.length - 16_384);
  zip.file("xl/media/resource-probe.bin", randomBytes(paddingBytes), {
    binary: true,
    compression: "STORE"
  });
  await pipeline(zip.generateNodeStream({
    type: "nodebuffer",
    streamFiles: true,
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  }), createWriteStream(target, { flags: "wx", mode: 0o600 }));
}

async function generateMarginCsv(target) {
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  output.write("sku,margin,description\n");
  const payload = "x".repeat(58);
  for (let row = 1; row <= 100_000; row += 1) {
    if (!output.write(`sku-${row},${row % 1000},${payload}\n`)) {
      await new Promise((resolve) => output.once("drain", resolve));
    }
  }
  await new Promise((resolve, reject) => {
    output.end(resolve);
    output.once("error", reject);
  });
}

async function measure(name, operation) {
  const startedAt = Date.now();
  const before = cgroupSnapshot();
  const peak = { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0, tmpBytes: tmpBytes() };
  const sample = () => {
    const memory = process.memoryUsage();
    peak.rss = Math.max(peak.rss, memory.rss);
    peak.heapUsed = Math.max(peak.heapUsed, memory.heapUsed);
    peak.external = Math.max(peak.external, memory.external);
    peak.arrayBuffers = Math.max(peak.arrayBuffers, memory.arrayBuffers);
    peak.tmpBytes = Math.max(peak.tmpBytes, tmpBytes());
  };
  sample();
  const timer = setInterval(sample, 25);
  let workload;
  let operationError;
  try {
    workload = await operation();
    sample();
  } catch (error) {
    operationError = error instanceof Error ? error.message : "RESOURCE_PROBE_OPERATION_FAILED";
  } finally {
    clearInterval(timer);
  }
  const after = cgroupSnapshot();
  const oomDelta = (after.events.oom ?? 0) - (before.events.oom ?? 0);
  const oomKillDelta = (after.events.oom_kill ?? 0) - (before.events.oom_kill ?? 0);
  const peakLimit = name === "baseline" ? 700 * MIB : 850 * MIB;
  const violations = [];
  if (after.limit !== 1024 * MIB) violations.push("CGROUP_LIMIT_NOT_1GIB");
  if (after.peak > peakLimit) violations.push("CGROUP_MEMORY_PEAK_EXCEEDED");
  if (oomDelta !== 0) violations.push("CGROUP_OOM_EVENT");
  if (oomKillDelta !== 0) violations.push("CGROUP_OOM_KILL_EVENT");
  if (operationError) violations.push("WORKLOAD_FAILED");
  return {
    scenario: name,
    result: violations.length === 0 ? "PASS" : "FAIL",
    durationMs: Date.now() - startedAt,
    workload,
    operationError,
    thresholdBytes: peakLimit,
    violations,
    processPeak: peak,
    cgroup: {
      before,
      after,
      oomDelta,
      oomKillDelta
    }
  };
}

function cgroupSnapshot() {
  const readNumber = (name) => Number(readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim());
  const events = Object.fromEntries(readFileSync("/sys/fs/cgroup/memory.events", "utf8")
    .trim().split(/\r?\n/).map((line) => {
      const [key, value] = line.split(/\s+/);
      return [key, Number(value)];
    }));
  return {
    current: readNumber("memory.current"),
    peak: readNumber("memory.peak"),
    limit: readNumber("memory.max"),
    events
  };
}

function tmpBytes(directory = "/tmp") {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += tmpBytes(target);
    else if (entry.isFile()) total += statSync(target).size;
  }
  return total;
}

function fixtureInventory() {
  mkdirSync(fixtureRoot, { recursive: true });
  return Object.fromEntries(readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => [entry.name, statSync(path.join(fixtureRoot, entry.name)).size]));
}
