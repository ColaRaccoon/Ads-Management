export type XlsxCellStyle =
  | "Text"
  | "Header"
  | "Number"
  | "Krw"
  | "Usd"
  | "Percent"
  | "Ratio"
  | "TotalText"
  | "TotalNumber"
  | "TotalKrw"
  | "TotalUsd"
  | "TotalPercent"
  | "TotalRatio";

export type XlsxCell = {
  value: string | number | null | undefined;
  style?: XlsxCellStyle;
};

export type XlsxWorkbookInput = {
  sheetName: string;
  columns?: Array<{ width: number }>;
  rows: XlsxCell[][];
  freezeRow?: number;
  autoFilter?: { fromRow: number; toRow?: number };
};

type ZipFile = { name: string; content: string | Uint8Array };

export function buildXlsxWorkbook(input: XlsxWorkbookInput) {
  const modifiedAt = new Date().toISOString();

  return zipFiles([
    { name: "[Content_Types].xml", content: contentTypesXml() },
    { name: "_rels/.rels", content: packageRelationshipsXml() },
    { name: "docProps/app.xml", content: appPropertiesXml() },
    { name: "docProps/core.xml", content: corePropertiesXml(modifiedAt) },
    { name: "xl/workbook.xml", content: workbookXml(input.sheetName) },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelationshipsXml() },
    { name: "xl/styles.xml", content: stylesXml() },
    { name: "xl/worksheets/sheet1.xml", content: worksheetXml(input) }
  ]);
}

export function downloadXlsx(fileName: string, workbook: Uint8Array) {
  const buffer = new ArrayBuffer(workbook.byteLength);
  new Uint8Array(buffer).set(workbook);
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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

function workbookXml(sheetName: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
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
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="#,##0&quot;원&quot;"/>
    <numFmt numFmtId="165" formatCode="$#,##0.00"/>
    <numFmt numFmtId="166" formatCode="0.00&quot;배&quot;"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="맑은 고딕"/></font>
    <font><b/><color rgb="FF18222D"/><sz val="11"/><name val="맑은 고딕"/></font>
    <font><b/><color rgb="FF18222D"/><sz val="11"/><name val="맑은 고딕"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE5F3F0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD5DEE7"/></left><right style="thin"><color rgb="FFD5DEE7"/></right><top style="thin"><color rgb="FFD5DEE7"/></top><bottom style="thin"><color rgb="FFD5DEE7"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="14">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="10" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="49" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="3" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="10" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="166" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function worksheetXml(input: XlsxWorkbookInput) {
  const columnCount = Math.max(input.columns?.length ?? 0, ...input.rows.map((row) => row.length), 1);
  const lastRow = Math.max(input.rows.length, 1);
  const lastCell = `${columnName(columnCount)}${lastRow}`;
  const columnsXml =
    input.columns
      ?.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`)
      .join("") ?? "";
  const rowsXml = input.rows
    .map((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      return `<row r="${excelRow}">${row
        .map((cell, cellIndex) => xlsxCell(cellRef(excelRow, cellIndex + 1), cell.value, cell.style ?? "Text"))
        .join("")}</row>`;
    })
    .join("");
  const freezeRow = input.freezeRow && input.freezeRow > 0 ? input.freezeRow : null;
  const sheetViewsXml = freezeRow
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "";
  const autoFilterXml = input.autoFilter
    ? `<autoFilter ref="A${input.autoFilter.fromRow}:${columnName(columnCount)}${Math.max(input.autoFilter.toRow ?? lastRow, input.autoFilter.fromRow)}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  ${sheetViewsXml}
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columnsXml}</cols>
  <sheetData>${rowsXml}</sheetData>
  ${autoFilterXml}
</worksheet>`;
}

function xlsxCell(ref: string, value: string | number | null | undefined, style: XlsxCellStyle) {
  const styleId = xlsxStyleId(style);
  if (value === null || value === undefined) {
    return xlsxStringCell(ref, "-", styleId);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return xlsxStringCell(ref, "-", styleId);
    }
    return `<c r="${ref}" s="${styleId}"><v>${value}</v></c>`;
  }
  return xlsxStringCell(ref, value, styleId);
}

function xlsxStringCell(ref: string, value: string, styleId: number) {
  return `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t>${escapeXml(value)}</t></is></c>`;
}

function xlsxStyleId(style: XlsxCellStyle) {
  switch (style) {
    case "Header":
      return 1;
    case "Number":
      return 2;
    case "Krw":
      return 3;
    case "Usd":
      return 4;
    case "Percent":
      return 5;
    case "Ratio":
      return 6;
    case "Text":
      return 7;
    case "TotalText":
      return 8;
    case "TotalNumber":
      return 9;
    case "TotalKrw":
      return 10;
    case "TotalUsd":
      return 11;
    case "TotalPercent":
      return 12;
    case "TotalRatio":
      return 13;
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

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
