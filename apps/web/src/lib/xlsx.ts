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
  | "TotalRatio"
  | "Percent1";

export type XlsxCellFill =
  | "GROUP_MINT"
  | "GROUP_BLUE"
  | "GROUP_SAND"
  | "GROUP_LILAC"
  | "REPORT_HEADER"
  | "REPORT_TOTAL"
  | "SALES_INCREASE"
  | "SALES_DECREASE";

export type XlsxFontTone =
  | "DEFAULT"
  | "INVERSE"
  | "INCREASE"
  | "DECREASE"
  | "POSITIVE"
  | "NEGATIVE";

export type XlsxBorderTone =
  | "GRID"
  | "BLOCK_START"
  | "INCREASE"
  | "DECREASE"
  | "MERGED_START"
  | "MERGED_MIDDLE"
  | "MERGED_END"
  | "NONE";

export type XlsxCell = {
  value: string | number | null | undefined;
  style?: XlsxCellStyle;
  fill?: XlsxCellFill;
  fontTone?: XlsxFontTone;
  bold?: boolean;
  indent?: number;
  wrapText?: boolean;
  borderTone?: XlsxBorderTone;
};

export type XlsxRow = {
  cells: XlsxCell[];
  height?: number;
};

export type XlsxMergeRange = {
  fromRow: number;
  fromColumn: number;
  toRow: number;
  toColumn: number;
};

export type XlsxWorkbookInput = {
  sheetName: string;
  columns?: Array<{ width: number }>;
  rows: Array<XlsxCell[] | XlsxRow>;
  merges?: XlsxMergeRange[];
  freezeRow?: number;
  autoFilter?: { fromRow: number; toRow?: number };
};

type ZipFile = { name: string; content: string | Uint8Array };
type NormalizedXlsxWorkbookInput = Omit<XlsxWorkbookInput, "rows"> & {
  rows: XlsxRow[];
};

type XlsxResolvedStyle = {
  numFmtId: number;
  fontXml: string;
  fillXml: string;
  borderXml: string;
  alignment?: {
    horizontal?: "left" | "right" | "center";
    indent?: number;
    wrapText?: boolean;
  };
};

type XlsxStyleCatalog = {
  numFmts: string[];
  fonts: string[];
  fills: string[];
  borders: string[];
  cellXfs: string[];
  styleIds: Map<string, number>;
};

const REGULAR_FONT_XML = fontXml(false);
const NO_FILL_XML = `<fill><patternFill patternType="none"/></fill>`;
const GRAY_125_FILL_XML = `<fill><patternFill patternType="gray125"/></fill>`;
const NO_BORDER_XML = `<border><left/><right/><top/><bottom/><diagonal/></border>`;
const LEGACY_GRID_BORDER_XML = gridBorderXml("FFD5DEE7");
const XLSX_MAX_ROW = 1_048_576;
const XLSX_MAX_COLUMN = 16_384;

const LEGACY_STYLE_ORDER: XlsxCellStyle[] = [
  "Header",
  "Number",
  "Krw",
  "Usd",
  "Percent",
  "Ratio",
  "Text",
  "TotalText",
  "TotalNumber",
  "TotalKrw",
  "TotalUsd",
  "TotalPercent",
  "TotalRatio",
  "Percent1"
];

export function buildXlsxWorkbook(input: XlsxWorkbookInput) {
  const modifiedAt = new Date().toISOString();
  const normalizedInput: NormalizedXlsxWorkbookInput = {
    ...input,
    rows: input.rows.map(normalizeXlsxRow)
  };
  const styleCatalog = buildStyleCatalog(normalizedInput.rows);

  return zipFiles([
    { name: "[Content_Types].xml", content: contentTypesXml() },
    { name: "_rels/.rels", content: packageRelationshipsXml() },
    { name: "docProps/app.xml", content: appPropertiesXml() },
    { name: "docProps/core.xml", content: corePropertiesXml(modifiedAt) },
    { name: "xl/workbook.xml", content: workbookXml(input.sheetName) },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelationshipsXml() },
    { name: "xl/styles.xml", content: stylesXml(styleCatalog) },
    { name: "xl/worksheets/sheet1.xml", content: worksheetXml(normalizedInput, styleCatalog) }
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

function stylesXml(catalog: XlsxStyleCatalog) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="${catalog.numFmts.length}">${catalog.numFmts.join("")}</numFmts>
  <fonts count="${catalog.fonts.length}">${catalog.fonts.join("")}</fonts>
  <fills count="${catalog.fills.length}">${catalog.fills.join("")}</fills>
  <borders count="${catalog.borders.length}">${catalog.borders.join("")}</borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${catalog.cellXfs.length}">${catalog.cellXfs.join("")}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function worksheetXml(input: NormalizedXlsxWorkbookInput, catalog: XlsxStyleCatalog) {
  const merges = normalizeMergeRanges(input.merges);
  const columnCount = Math.max(
    input.columns?.length ?? 0,
    ...input.rows.map((row) => row.cells.length),
    ...merges.map((merge) => merge.toColumn),
    1
  );
  const lastRow = Math.max(input.rows.length, ...merges.map((merge) => merge.toRow), 1);
  const lastCell = `${columnName(columnCount)}${lastRow}`;
  const columnsXml =
    input.columns
      ?.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`)
      .join("") ?? "";
  const rowsXml = input.rows
    .map((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      const height = finitePositiveNumber(row.height);
      const heightAttributes = height === null ? "" : ` ht="${height}" customHeight="1"`;
      return `<row r="${excelRow}"${heightAttributes}>${row.cells
        .map((cell, cellIndex) => xlsxCell(cellRef(excelRow, cellIndex + 1), cell, catalog))
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
  const mergeCellsXml = merges.length > 0
    ? `<mergeCells count="${merges.length}">${merges
        .map((merge) => `<mergeCell ref="${mergeRangeRef(merge)}"/>`)
        .join("")}</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCell}"/>
  ${sheetViewsXml}
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columnsXml}</cols>
  <sheetData>${rowsXml}</sheetData>
  ${autoFilterXml}
  ${mergeCellsXml}
</worksheet>`;
}

function xlsxCell(ref: string, cell: XlsxCell, catalog: XlsxStyleCatalog) {
  const value = cell.value;
  const styleId = xlsxStyleId(cell, catalog);
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
  const preserveSpace = /^\s|\s$/.test(value) ? ` xml:space="preserve"` : "";
  return `<c r="${ref}" t="inlineStr" s="${styleId}"><is><t${preserveSpace}>${escapeXml(value)}</t></is></c>`;
}

function xlsxStyleId(cell: XlsxCell, catalog: XlsxStyleCatalog) {
  const styleId = catalog.styleIds.get(resolvedStyleKey(resolveCellStyle(cell)));
  if (styleId === undefined) {
    throw new Error("XLSX style was not registered.");
  }
  return styleId;
}

function normalizeXlsxRow(row: XlsxCell[] | XlsxRow): XlsxRow {
  return Array.isArray(row) ? { cells: row } : row;
}

function buildStyleCatalog(rows: XlsxRow[]): XlsxStyleCatalog {
  const catalog: XlsxStyleCatalog = {
    numFmts: [
      `<numFmt numFmtId="164" formatCode="#,##0&quot;원&quot;"/>`,
      `<numFmt numFmtId="165" formatCode="$#,##0.00"/>`,
      `<numFmt numFmtId="166" formatCode="0.00&quot;배&quot;"/>`,
      `<numFmt numFmtId="167" formatCode="0.0%"/>`
    ],
    fonts: [REGULAR_FONT_XML],
    fills: [NO_FILL_XML, GRAY_125_FILL_XML],
    borders: [NO_BORDER_XML],
    cellXfs: [],
    styleIds: new Map()
  };

  registerResolvedStyle(catalog, {
    numFmtId: 0,
    fontXml: REGULAR_FONT_XML,
    fillXml: NO_FILL_XML,
    borderXml: NO_BORDER_XML
  });
  for (const style of LEGACY_STYLE_ORDER) {
    registerResolvedStyle(catalog, resolveCellStyle({ value: "", style }));
  }
  for (const row of rows) {
    for (const cell of row.cells) {
      registerResolvedStyle(catalog, resolveCellStyle(cell));
    }
  }
  return catalog;
}

function registerResolvedStyle(catalog: XlsxStyleCatalog, style: XlsxResolvedStyle) {
  const styleKey = resolvedStyleKey(style);
  const existingId = catalog.styleIds.get(styleKey);
  if (existingId !== undefined) return existingId;

  const fontId = registerResource(catalog.fonts, style.fontXml);
  const fillId = registerResource(catalog.fills, style.fillXml);
  const borderId = registerResource(catalog.borders, style.borderXml);
  const attributes = [
    `numFmtId="${style.numFmtId}"`,
    `fontId="${fontId}"`,
    `fillId="${fillId}"`,
    `borderId="${borderId}"`,
    `xfId="0"`
  ];
  if (style.numFmtId !== 0) attributes.push(`applyNumberFormat="1"`);
  if (fontId !== 0) attributes.push(`applyFont="1"`);
  if (fillId !== 0) attributes.push(`applyFill="1"`);
  if (borderId !== 0) attributes.push(`applyBorder="1"`);
  if (style.alignment) attributes.push(`applyAlignment="1"`);
  const alignmentXml = style.alignment
    ? `<alignment${style.alignment.horizontal ? ` horizontal="${style.alignment.horizontal}"` : ""}${style.alignment.indent !== undefined ? ` indent="${style.alignment.indent}"` : ""}${style.alignment.wrapText ? ` wrapText="1"` : ""}/>`
    : "";
  const cellXf = alignmentXml.length > 0
    ? `<xf ${attributes.join(" ")}>${alignmentXml}</xf>`
    : `<xf ${attributes.join(" ")}/>`;
  const styleId = catalog.cellXfs.length;
  catalog.cellXfs.push(cellXf);
  catalog.styleIds.set(styleKey, styleId);
  return styleId;
}

function registerResource(resources: string[], resource: string) {
  const existingId = resources.indexOf(resource);
  if (existingId >= 0) return existingId;
  resources.push(resource);
  return resources.length - 1;
}

function resolveCellStyle(cell: XlsxCell): XlsxResolvedStyle {
  const style = cell.style ?? "Text";
  const base = baseStyle(style);
  const indent = finiteNonNegativeInteger(cell.indent);
  const wrapText = cell.wrapText === true;
  return {
    numFmtId: base.numFmtId,
    fontXml: fontXml(
      cell.bold ?? base.bold,
      cell.fontTone ? fontColor(cell.fontTone) : base.fontColor
    ),
    fillXml: cell.fill ? namedFillXml(cell.fill) : base.fillXml,
    borderXml: cell.borderTone ? namedBorderXml(cell.borderTone) : base.borderXml,
    alignment: (indent !== null && indent > 0) || wrapText
      ? {
          ...(indent !== null && indent > 0 ? { horizontal: "left" as const, indent } : {}),
          ...(wrapText ? { wrapText: true } : {})
        }
      : undefined
  };
}

function baseStyle(style: XlsxCellStyle) {
  const isTotal = style.startsWith("Total");
  return {
    numFmtId: numberFormatId(style),
    bold: style === "Header" || isTotal,
    fontColor: style === "Header" || isTotal ? "FF18222D" : undefined,
    fillXml: style === "Header"
      ? solidFillXml("FFE5F3F0")
      : isTotal
        ? solidFillXml("FFF8FAFB")
        : NO_FILL_XML,
    borderXml: LEGACY_GRID_BORDER_XML
  };
}

function numberFormatId(style: XlsxCellStyle) {
  switch (style) {
    case "Header":
      return 0;
    case "Number":
    case "TotalNumber":
      return 3;
    case "Krw":
    case "TotalKrw":
      return 164;
    case "Usd":
    case "TotalUsd":
      return 165;
    case "Percent":
    case "TotalPercent":
      return 10;
    case "Ratio":
    case "TotalRatio":
      return 166;
    case "Percent1":
      return 167;
    case "Text":
    case "TotalText":
      return 49;
  }
}

function fontColor(tone: XlsxFontTone) {
  switch (tone) {
    case "DEFAULT":
      return "FF17221F";
    case "INVERSE":
      return "FFFFFFFF";
    case "INCREASE":
      return "FF1557A0";
    case "DECREASE":
      return "FF7A5A00";
    case "POSITIVE":
      return "FF13744A";
    case "NEGATIVE":
      return "FFB5473B";
  }
}

function namedFillXml(fill: XlsxCellFill) {
  switch (fill) {
    case "GROUP_MINT":
      return solidFillXml("FFE7F3EF");
    case "GROUP_BLUE":
      return solidFillXml("FFEAF2FB");
    case "GROUP_SAND":
      return solidFillXml("FFFBF1DF");
    case "GROUP_LILAC":
      return solidFillXml("FFF1ECF8");
    case "REPORT_HEADER":
      return solidFillXml("FF385951");
    case "REPORT_TOTAL":
      return solidFillXml("FFEDF1F0");
    case "SALES_INCREASE":
      return solidFillXml("FFDCECFF");
    case "SALES_DECREASE":
      return solidFillXml("FFFFF2CC");
  }
}

function namedBorderXml(border: XlsxBorderTone) {
  switch (border) {
    case "GRID":
      return gridBorderXml("FFD8E0DE");
    case "BLOCK_START":
      return `<border><left style="thin"><color rgb="FFD8E0DE"/></left><right style="thin"><color rgb="FFD8E0DE"/></right><top style="medium"><color rgb="FF9BAEAA"/></top><bottom style="thin"><color rgb="FFD8E0DE"/></bottom><diagonal/></border>`;
    case "INCREASE":
      return gridBorderXml("FF6C9ED8");
    case "DECREASE":
      return gridBorderXml("FFE2B93B");
    case "MERGED_START":
      return mergedRowBorderXml("FFD8E0DE", true, false);
    case "MERGED_MIDDLE":
      return mergedRowBorderXml("FFD8E0DE", false, false);
    case "MERGED_END":
      return mergedRowBorderXml("FFD8E0DE", false, true);
    case "NONE":
      return NO_BORDER_XML;
  }
}

function fontXml(bold: boolean, color?: string) {
  return `<font>${bold ? "<b/>" : ""}${color ? `<color rgb="${color}"/>` : ""}<sz val="11"/><name val="맑은 고딕"/></font>`;
}

function solidFillXml(color: string) {
  return `<fill><patternFill patternType="solid"><fgColor rgb="${color}"/><bgColor indexed="64"/></patternFill></fill>`;
}

function gridBorderXml(color: string) {
  return `<border><left style="thin"><color rgb="${color}"/></left><right style="thin"><color rgb="${color}"/></right><top style="thin"><color rgb="${color}"/></top><bottom style="thin"><color rgb="${color}"/></bottom><diagonal/></border>`;
}

function mergedRowBorderXml(color: string, hasLeft: boolean, hasRight: boolean) {
  const left = hasLeft
    ? `<left style="thin"><color rgb="${color}"/></left>`
    : "<left/>";
  const right = hasRight
    ? `<right style="thin"><color rgb="${color}"/></right>`
    : "<right/>";
  return `<border>${left}${right}<top style="thin"><color rgb="${color}"/></top><bottom style="thin"><color rgb="${color}"/></bottom><diagonal/></border>`;
}

function resolvedStyleKey(style: XlsxResolvedStyle) {
  return JSON.stringify(style);
}

function finitePositiveNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteNonNegativeInteger(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(250, Math.floor(value))
    : null;
}

function normalizeMergeRanges(ranges: XlsxMergeRange[] | undefined) {
  const normalized = ranges?.map((range) => {
    const coordinates = [
      range.fromRow,
      range.fromColumn,
      range.toRow,
      range.toColumn
    ];
    if (coordinates.some((coordinate) => !Number.isInteger(coordinate) || coordinate < 1)) {
      throw new Error("XLSX merge coordinates must be positive integers.");
    }
    if (range.fromRow > XLSX_MAX_ROW || range.toRow > XLSX_MAX_ROW) {
      throw new Error(`XLSX merge rows must not exceed ${XLSX_MAX_ROW}.`);
    }
    if (range.fromColumn > XLSX_MAX_COLUMN || range.toColumn > XLSX_MAX_COLUMN) {
      throw new Error(`XLSX merge columns must not exceed ${XLSX_MAX_COLUMN}.`);
    }
    if (range.fromRow > range.toRow || range.fromColumn > range.toColumn) {
      throw new Error("XLSX merge range must start before it ends.");
    }
    return { ...range };
  }) ?? [];
  const references = normalized.map(mergeRangeRef);
  if (new Set(references).size !== references.length) {
    throw new Error("XLSX merge ranges must be unique.");
  }
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      if (mergeRangesOverlap(normalized[leftIndex], normalized[rightIndex])) {
        throw new Error("XLSX merge ranges must not overlap.");
      }
    }
  }
  return normalized;
}

function mergeRangesOverlap(left: XlsxMergeRange, right: XlsxMergeRange) {
  const rowsOverlap = left.fromRow <= right.toRow && right.fromRow <= left.toRow;
  const columnsOverlap =
    left.fromColumn <= right.toColumn && right.fromColumn <= left.toColumn;
  return rowsOverlap && columnsOverlap;
}

function mergeRangeRef(range: XlsxMergeRange) {
  return `${cellRef(range.fromRow, range.fromColumn)}:${cellRef(range.toRow, range.toColumn)}`;
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
