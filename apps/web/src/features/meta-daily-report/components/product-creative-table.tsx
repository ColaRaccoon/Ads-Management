import { renderColumnValue } from "../daily-report-value";
import { findPreviousRow } from "../report-model";
import type { ColumnDefinition, CreativePerformanceRow, PreviousIndexes } from "../types";

export function ProductCreativeTable({
  columns,
  previousIndexes,
  rows
}: {
  columns: ColumnDefinition[];
  previousIndexes: PreviousIndexes;
  rows: CreativePerformanceRow[];
}) {
  return (
    <div className="daily-product-table-wrap">
      <table className="daily-product-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="daily-product-table-empty" colSpan={columns.length}>
                표시할 Meta 소재가 없습니다.
              </td>
            </tr>
          ) : rows.map((row) => {
            const previous = findPreviousRow(row, previousIndexes);
            return (
              <tr key={row.creativeKey || row.displayName}>
                {columns.map((column) => (
                  <td key={column.key}>{renderColumnValue(column, row, previous)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
