export type CsvColumn<Row> = {
  header: string;
  value: (row: Row) => string | number | null | undefined;
};

export function downloadCsv<Row>(filename: string, columns: CsvColumn<Row>[], rows: Row[]) {
  const blob = new Blob([serializeCsv(columns, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function serializeCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]) {
  const csvRows = [
    columns.map((column) => escapeCsv(column.header)).join(","),
    ...rows.map((row) => columns.map((column) => escapeCsv(column.value(row))).join(","))
  ];
  return `\uFEFF${csvRows.join("\r\n")}`;
}

function escapeCsv(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
