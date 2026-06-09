"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download } from "lucide-react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { apiGet, rangeQuery } from "@/lib/api";
import { money, numberFmt } from "@/lib/date-range";
import { useRange } from "@/lib/use-range";

type CreativePerformanceRow = {
  displayName: string;
  productName: string | null;
  materialNo: string | null;
  deliveryStatus: string | null;
  totals: {
    spendUsd: number;
    purchaseCount: number;
    cpaUsd: number | null;
    ctrLinkPct: number | null;
    cpmUsd: number | null;
  };
  dataDays: number;
};

type SortKey = "product" | "material" | "status" | "dataDays" | "spend" | "purchase" | "cpa" | "ctr" | "cpm";
type SortDirection = "asc" | "desc";
type DeliveryStatusFilter = "active" | "inactive" | "all" | "hasSpend";
type AdsSettings = {
  query: string;
  deliveryStatus: DeliveryStatusFilter;
  sort: { key: SortKey; direction: SortDirection };
};

type SortableColumn = {
  key: SortKey;
  header: string;
  render: (row: CreativePerformanceRow) => ReactNode;
};

const columns: SortableColumn[] = [
  { key: "product", header: "제품", render: (row) => row.productName ?? "-" },
  { key: "material", header: "소재", render: (row) => row.materialNo ?? row.displayName },
  { key: "status", header: "활성상태", render: (row) => formatStatus(row.deliveryStatus) },
  { key: "dataDays", header: "집계일수", render: (row) => numberFmt(row.dataDays) },
  { key: "spend", header: "광고비", render: (row) => money(row.totals?.spendUsd, "USD") },
  { key: "purchase", header: "구매", render: (row) => numberFmt(row.totals?.purchaseCount) },
  { key: "cpa", header: "CPA", render: (row) => money(row.totals?.cpaUsd, "USD") },
  { key: "ctr", header: "CTR", render: (row) => `${numberFmt(row.totals?.ctrLinkPct, 2)}%` },
  { key: "cpm", header: "CPM", render: (row) => money(row.totals?.cpmUsd, "USD") }
];

const ADS_SETTINGS_KEY = "meta-ads-performance:ads-settings:v1";
const DEFAULT_ADS_SETTINGS: AdsSettings = {
  query: "",
  deliveryStatus: "active",
  sort: { key: "product", direction: "asc" }
};

export default function AdsPage() {
  const range = useRange();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [query, setQuery] = useState(DEFAULT_ADS_SETTINGS.query);
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatusFilter>(DEFAULT_ADS_SETTINGS.deliveryStatus);
  const [sort, setSort] = useState(DEFAULT_ADS_SETTINGS.sort);
  const apiDeliveryStatus = deliveryStatus === "hasSpend" ? "all" : deliveryStatus;

  useEffect(() => {
    const settings = readAdsSettings();
    setQuery(settings.query);
    setDeliveryStatus(settings.deliveryStatus);
    setSort(settings.sort);
    setSettingsLoaded(true);
  }, []);

  useEffect(() => {
    if (settingsLoaded) {
      writeAdsSettings({ query, deliveryStatus, sort });
    }
  }, [deliveryStatus, query, settingsLoaded, sort]);

  const creatives = useQuery({
    queryKey: ["ad-creatives", range, query, deliveryStatus],
    queryFn: () =>
      apiGet<CreativePerformanceRow[]>(
        `/metrics/ads/creatives?${rangeQuery(range, { q: query, deliveryStatus: apiDeliveryStatus })}`
      ),
    enabled: settingsLoaded
  });

  const filteredRows = useMemo(() => filterRows(creatives.data ?? [], deliveryStatus), [creatives.data, deliveryStatus]);
  const rows = useMemo(() => sortRows(filteredRows, sort.key, sort.direction), [filteredRows, sort]);

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>광고 소재 성과</h1>
          <p>날짜 · 제품 · 소재명 기준</p>
        </div>
        <div className="toolbar">
          <select
            className="select"
            value={deliveryStatus}
            onChange={(event) => setDeliveryStatus(event.target.value as DeliveryStatusFilter)}
          >
            <option value="active">활성</option>
            <option value="inactive">비활성</option>
            <option value="hasSpend">광고비 존재</option>
            <option value="all">전체</option>
          </select>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="제품명 또는 소재명"
          />
          <button className="button" type="button" onClick={() => downloadAdsExcel(rows, range)} disabled={rows.length === 0}>
            <Download size={15} />
            엑셀 출력
          </button>
        </div>
      </div>

      {creatives.isError ? (
        <div className="warning-strip">
          <span>API 연결 또는 DB 설정을 확인해주세요.</span>
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key}>
                  <SortableHeader
                    activeDirection={sort.key === column.key ? sort.direction : null}
                    label={column.header}
                    onSort={(direction) => setSort({ key: column.key, direction })}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>조건에 맞는 소재 성과가 없습니다.</td>
              </tr>
            ) : (
              rows.map((row, rowIndex) => (
                <tr key={`${row.productName ?? "-"}:${row.materialNo ?? row.displayName}:${rowIndex}`}>
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(row)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortableHeader({
  activeDirection,
  label,
  onSort
}: {
  activeDirection: SortDirection | null;
  label: string;
  onSort: (direction: SortDirection) => void;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span>{label}</span>
      <span style={{ display: "inline-flex", gap: 2 }}>
        <button
          className="icon-button"
          type="button"
          title={`${label} 오름차순`}
          onClick={() => onSort("asc")}
          style={sortButtonStyle(activeDirection === "asc")}
        >
          <ArrowUp size={13} />
        </button>
        <button
          className="icon-button"
          type="button"
          title={`${label} 내림차순`}
          onClick={() => onSort("desc")}
          style={sortButtonStyle(activeDirection === "desc")}
        >
          <ArrowDown size={13} />
        </button>
      </span>
    </div>
  );
}

function sortButtonStyle(active: boolean) {
  return {
    width: 24,
    height: 24,
    minHeight: 24,
    borderColor: active ? "var(--brand)" : "var(--line-strong)",
    background: active ? "var(--brand-weak)" : "#fff",
    color: active ? "var(--brand)" : "var(--text)"
  };
}

function sortRows(rows: CreativePerformanceRow[], key: SortKey, direction: SortDirection) {
  return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key), direction));
}

function filterRows(rows: CreativePerformanceRow[], deliveryStatus: DeliveryStatusFilter) {
  if (deliveryStatus !== "hasSpend") {
    return rows;
  }
  return rows.filter((row) => row.totals.spendUsd > 0);
}

function sortValue(row: CreativePerformanceRow, key: SortKey) {
  switch (key) {
    case "product":
      return row.productName;
    case "material":
      return row.materialNo ?? row.displayName;
    case "status":
      return formatStatus(row.deliveryStatus);
    case "dataDays":
      return row.dataDays;
    case "spend":
      return row.totals.spendUsd;
    case "purchase":
      return row.totals.purchaseCount;
    case "cpa":
      return row.totals.cpaUsd;
    case "ctr":
      return row.totals.ctrLinkPct;
    case "cpm":
      return row.totals.cpmUsd;
  }
}

function compareValues(a: string | number | null | undefined, b: string | number | null | undefined, direction: SortDirection) {
  const aEmpty = a === null || a === undefined || a === "-";
  const bEmpty = b === null || b === undefined || b === "-";
  if (aEmpty && bEmpty) {
    return 0;
  }
  if (aEmpty) {
    return 1;
  }
  if (bEmpty) {
    return -1;
  }

  const result =
    typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), "ko-KR", { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

function readAdsSettings(): AdsSettings {
  if (typeof window === "undefined") {
    return DEFAULT_ADS_SETTINGS;
  }
  try {
    const raw = window.localStorage.getItem(ADS_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_ADS_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<AdsSettings>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : DEFAULT_ADS_SETTINGS.query,
      deliveryStatus: isDeliveryStatus(parsed.deliveryStatus)
        ? parsed.deliveryStatus
        : DEFAULT_ADS_SETTINGS.deliveryStatus,
      sort:
        parsed.sort && isSortKey(parsed.sort.key) && isSortDirection(parsed.sort.direction)
          ? { key: parsed.sort.key, direction: parsed.sort.direction }
          : DEFAULT_ADS_SETTINGS.sort
    };
  } catch {
    return DEFAULT_ADS_SETTINGS;
  }
}

function writeAdsSettings(settings: AdsSettings) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(ADS_SETTINGS_KEY, JSON.stringify(settings));
}

function isDeliveryStatus(value: unknown): value is DeliveryStatusFilter {
  return value === "active" || value === "inactive" || value === "all" || value === "hasSpend";
}

function isSortKey(value: unknown): value is SortKey {
  return columns.some((column) => column.key === value);
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

function downloadAdsExcel(rows: CreativePerformanceRow[], range: { from: string; to: string }) {
  const workbook = buildXlsxWorkbook(rows);
  const blob = new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const datePart = range.from === range.to ? range.from : `${range.from}~${range.to}`;
  link.href = url;
  link.download = `${datePart}_메타_소재성과.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type ExportCellStyle = "Text" | "Number" | "Currency" | "Percent";
type ExportColumn = {
  header: string;
  width: number;
  style: ExportCellStyle;
  value: (row: CreativePerformanceRow) => string | number | null | undefined;
};
type ZipFile = { name: string; content: string | Uint8Array };

function buildXlsxWorkbook(rows: CreativePerformanceRow[]) {
  const exportColumns: ExportColumn[] = [
    { header: "제품", width: 18, style: "Text", value: (row) => row.productName ?? "-" },
    { header: "소재", width: 14, style: "Text", value: (row) => row.materialNo ?? row.displayName },
    { header: "활성상태", width: 12, style: "Text", value: (row) => formatStatus(row.deliveryStatus) },
    { header: "집계일수", width: 11, style: "Number", value: (row) => row.dataDays },
    { header: "광고비", width: 14, style: "Currency", value: (row) => row.totals.spendUsd },
    { header: "구매", width: 10, style: "Number", value: (row) => row.totals.purchaseCount },
    { header: "CPA", width: 14, style: "Currency", value: (row) => row.totals.cpaUsd },
    { header: "CTR", width: 10, style: "Percent", value: (row) => percentValue(row.totals.ctrLinkPct) },
    { header: "CPM", width: 14, style: "Currency", value: (row) => row.totals.cpmUsd }
  ];
  const modifiedAt = new Date().toISOString();

  return zipFiles([
    { name: "[Content_Types].xml", content: contentTypesXml() },
    { name: "_rels/.rels", content: packageRelationshipsXml() },
    { name: "docProps/app.xml", content: appPropertiesXml() },
    { name: "docProps/core.xml", content: corePropertiesXml(modifiedAt) },
    { name: "xl/workbook.xml", content: workbookXml() },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelationshipsXml() },
    { name: "xl/styles.xml", content: stylesXml() },
    { name: "xl/worksheets/sheet1.xml", content: worksheetXml(exportColumns, rows) }
  ]);
}

function contentTypesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}

function packageRelationshipsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function appPropertiesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Meta Ads Performance</Application>
</Properties>`;
}

function corePropertiesXml(modifiedAt: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Meta Ads Performance</dc:creator>
  <cp:lastModifiedBy>Meta Ads Performance</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${modifiedAt}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${modifiedAt}</dcterms:modified>
</cp:coreProperties>`;
}

function workbookXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Ads" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function workbookRelationshipsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="$#,##0.00"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="맑은 고딕"/></font>
    <font><b/><color rgb="FF18222D"/><sz val="11"/><name val="맑은 고딕"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE5F3F0"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD5DEE7"/></left><right style="thin"><color rgb="FFD5DEE7"/></right><top style="thin"><color rgb="FFD5DEE7"/></top><bottom style="thin"><color rgb="FFD5DEE7"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function worksheetXml(exportColumns: ExportColumn[], rows: CreativePerformanceRow[]) {
  const lastRow = Math.max(rows.length + 1, 1);
  const lastCell = `${columnName(exportColumns.length)}${lastRow}`;
  const columnsXml = exportColumns
    .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`)
    .join("");
  const headerXml = `<row r="1">${exportColumns
    .map((column, index) => xlsxStringCell(cellRef(1, index + 1), column.header, 1))
    .join("")}</row>`;
  const rowsXml = rows
    .map((row, rowIndex) => {
      const excelRow = rowIndex + 2;
      return `<row r="${excelRow}">${exportColumns
        .map((column, columnIndex) => xlsxCell(cellRef(excelRow, columnIndex + 1), column.value(row), column.style))
        .join("")}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columnsXml}</cols>
  <sheetData>${headerXml}${rowsXml}</sheetData>
  <autoFilter ref="A1:${lastCell}"/>
</worksheet>`;
}

function xlsxCell(ref: string, value: string | number | null | undefined, style: ExportCellStyle) {
  const styleId = xlsxStyleId(style);
  if (value === null || value === undefined) {
    return xlsxStringCell(ref, "-", 5);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return xlsxStringCell(ref, "-", 5);
    }
    return `<c r="${ref}" s="${styleId}"><v>${value}</v></c>`;
  }
  return xlsxStringCell(ref, value, styleId);
}

function xlsxStringCell(ref: string, value: string, styleId: number) {
  return `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t>${escapeXml(value)}</t></is></c>`;
}

function xlsxStyleId(style: ExportCellStyle) {
  switch (style) {
    case "Number":
      return 2;
    case "Currency":
      return 3;
    case "Percent":
      return 4;
    case "Text":
      return 5;
  }
}

function cellRef(row: number, column: number) {
  return `${columnName(column)}${row}`;
}

function columnName(column: number) {
  let index = column;
  let name = "";
  while (index > 0) {
    const modulo = (index - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    index = Math.floor((index - modulo) / 26);
  }
  return name;
}

function zipFiles(files: ZipFile[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const records = files.map((file) => {
    const fileName = encoder.encode(file.name);
    const content = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
    return { fileName, content, crc: crc32(content) };
  });
  let offset = 0;

  for (const record of records) {
    const localHeader = zipLocalHeader(record.fileName, record.content, record.crc);
    localParts.push(localHeader, record.content);
    centralParts.push(zipCentralHeader(record.fileName, record.content, record.crc, offset));
    offset += localHeader.length + record.content.length;
  }

  const centralDirectory = concatUint8Arrays(centralParts);
  const localDirectory = concatUint8Arrays(localParts);
  const endRecord = zipEndRecord(records.length, centralDirectory.length, localDirectory.length);

  return concatUint8Arrays([localDirectory, centralDirectory, endRecord]);
}

function zipLocalHeader(fileName: Uint8Array, content: Uint8Array, crc: number) {
  const header = new Uint8Array(30 + fileName.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, content.length, true);
  view.setUint32(22, content.length, true);
  view.setUint16(26, fileName.length, true);
  header.set(fileName, 30);
  return header;
}

function zipCentralHeader(fileName: Uint8Array, content: Uint8Array, crc: number, offset: number) {
  const header = new Uint8Array(46 + fileName.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, content.length, true);
  view.setUint32(24, content.length, true);
  view.setUint16(28, fileName.length, true);
  view.setUint32(42, offset, true);
  header.set(fileName, 46);
  return header;
}

function zipEndRecord(entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number) {
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectorySize, true);
  view.setUint32(16, centralDirectoryOffset, true);
  return header;
}

function concatUint8Arrays(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildExcelXml(rows: CreativePerformanceRow[]) {
  const exportColumns = [
    { header: "제품", width: 130, style: "Text", value: (row: CreativePerformanceRow) => row.productName ?? "-" },
    { header: "소재", width: 90, style: "Text", value: (row: CreativePerformanceRow) => row.materialNo ?? row.displayName },
    { header: "활성상태", width: 80, style: "Text", value: (row: CreativePerformanceRow) => formatStatus(row.deliveryStatus) },
    { header: "집계일수", width: 70, style: "Number", value: (row: CreativePerformanceRow) => row.dataDays },
    { header: "광고비", width: 95, style: "Currency", value: (row: CreativePerformanceRow) => row.totals.spendUsd },
    { header: "구매", width: 70, style: "Number", value: (row: CreativePerformanceRow) => row.totals.purchaseCount },
    { header: "CPA", width: 95, style: "Currency", value: (row: CreativePerformanceRow) => row.totals.cpaUsd },
    { header: "CTR", width: 75, style: "Percent", value: (row: CreativePerformanceRow) => percentValue(row.totals.ctrLinkPct) },
    { header: "CPM", width: 95, style: "Currency", value: (row: CreativePerformanceRow) => row.totals.cpmUsd }
  ];

  const columnXml = exportColumns.map((column) => `<Column ss:Width="${column.width}"/>`).join("");
  const headerXml = `<Row>${exportColumns
    .map((column) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(column.header)}</Data></Cell>`)
    .join("")}</Row>`;
  const rowsXml = rows
    .map(
      (row) =>
        `<Row>${exportColumns
          .map((column) => excelCell(column.value(row), column.style))
          .join("")}</Row>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Header">
      <Font ss:Bold="1" ss:Color="#18222D"/>
      <Interior ss:Color="#E5F3F0" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="Text"><NumberFormat ss:Format="@"/></Style>
    <Style ss:ID="Number"><NumberFormat ss:Format="#,##0"/></Style>
    <Style ss:ID="Currency"><NumberFormat ss:Format="$#,##0.00"/></Style>
    <Style ss:ID="Percent"><NumberFormat ss:Format="0.00%"/></Style>
  </Styles>
  <Worksheet ss:Name="Ads">
    <Table>${columnXml}${headerXml}${rowsXml}</Table>
  </Worksheet>
</Workbook>`;
}

function excelCell(value: string | number | null | undefined, style: string) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return `<Cell ss:StyleID="Text"><Data ss:Type="String">-</Data></Cell>`;
  }
  if (typeof value === "number") {
    return `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  return `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function percentValue(value: number | null | undefined) {
  return value === null || value === undefined ? null : value / 100;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatStatus(value: string | null) {
  if (!value) {
    return "-";
  }
  if (value.toLowerCase() === "active") {
    return "활성";
  }
  if (value.toLowerCase() === "inactive" || value.toLowerCase() === "not_delivering") {
    return "비활성";
  }
  return value;
}
