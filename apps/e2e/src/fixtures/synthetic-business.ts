import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { CAFE24_ORDER_REQUIRED_COLUMNS } from "../../../api/src/domain/cafe24-csv";
import { META_ADSET_REQUIRED_COLUMNS } from "../../../api/src/domain/meta-csv";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createSyntheticBusinessFixture(runId: string) {
  if (!UUID.test(runId)) throw new Error("E2E_RUN_ID_INVALID");
  const marker = `Compatibility ${runId}`;
  const date = "2026-08-25";
  const metaRow: Record<string, string> = {
    "보고 시작": date,
    "보고 종료": date,
    "광고 세트 이름": marker,
    "광고 세트 게재": "active",
    "결과": "2",
    "결과 표시 도구": "구매",
    "도달": "80",
    "지출 금액 (USD)": "20",
    "노출": "100"
  };
  const meta = Buffer.from([
    META_ADSET_REQUIRED_COLUMNS.map(csvCell).join(","),
    META_ADSET_REQUIRED_COLUMNS.map((column) => csvCell(metaRow[column] ?? "")).join(",")
  ].join("\n"), "utf8");
  const cafe24Values = [
    `20260825-${runId.slice(0, 8)}`,
    `20260825-${runId.slice(0, 8)}-01`,
    "138000",
    `P-${runId.slice(0, 8)}`,
    "Compatibility product",
    "Compatibility option",
    "2",
    "69000",
    "카드",
    "2026-08-25 10:20:30"
  ];
  const cafe24 = Buffer.from([
    CAFE24_ORDER_REQUIRED_COLUMNS.map(csvCell).join(","),
    cafe24Values.map(csvCell).join(",")
  ].join("\n"), "utf8");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("sales");
  sheet.addRow(["Option ID", "Option Name", "Product Name", "Sale Method", "Sales(KRW)", "Orders", "Sales Quantity", "Total Sales(KRW)", "Total Sales Quantity", "Cancel Amount(KRW)", "Cancel Quantity", "Instant Cancel Quantity"]);
  sheet.addRow([`A-${runId}`, "Compatibility option", "Compatibility Coupang product", "seller", 100000, 1, 10, 100000, 10, 0, 0, 0]);
  const coupang = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    contractVersion: 1,
    runId,
    date,
    marker,
    files: {
      meta: { name: `meta-${runId}.csv`, mimeType: "text/csv", bytes: meta, sha256: hash(meta) },
      cafe24: { name: `cafe24-${runId}.csv`, mimeType: "text/csv", bytes: cafe24, sha256: hash(cafe24) },
      coupang: { name: `coupang-${runId}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: coupang, sha256: hash(coupang) }
    },
    expectedCounts: { metaRows: 1, cafe24Rows: 1, coupangRows: 1 }
  };
}

function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
