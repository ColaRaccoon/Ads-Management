import { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
};

export function DataTable<T>({
  rows,
  columns,
  empty = "데이터가 없습니다.",
  footer,
  onRowClick,
  rowClassName,
  getRowKey
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: string;
  footer?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  getRowKey?: (row: T, rowIndex: number) => string | number;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => {
              const className = [rowClassName?.(row), onRowClick ? "clickable-row" : undefined].filter(Boolean).join(" ");
              return (
                <tr
                  key={getRowKey ? getRowKey(row, rowIndex) : rowIndex}
                  className={className || undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={(event) => {
                    if (!onRowClick) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onRowClick(row);
                    }
                  }}
                  role={onRowClick ? "button" : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(row)}</td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
