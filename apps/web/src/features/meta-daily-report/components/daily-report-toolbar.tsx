import { Download, Printer, Search, Settings2 } from "lucide-react";
import { META_DAILY_COLUMNS } from "@/lib/meta-daily-columns";
import type { ColumnKey, DeliveryStatusFilter } from "../types";

export function DailyReportToolbar({
  deliveryStatus,
  exportDisabled,
  query,
  visibleColumns,
  onDeliveryStatusChange,
  onExportXlsx,
  onPrint,
  onQueryChange,
  onToggleColumn
}: {
  deliveryStatus: DeliveryStatusFilter;
  exportDisabled: boolean;
  query: string;
  visibleColumns: ColumnKey[];
  onDeliveryStatusChange: (value: DeliveryStatusFilter) => void;
  onExportXlsx: () => void;
  onPrint: () => void;
  onQueryChange: (value: string) => void;
  onToggleColumn: (value: ColumnKey) => void;
}) {
  return (
    <div className="daily-report-controls">
      <select
        className="select"
        value={deliveryStatus}
        onChange={(event) => onDeliveryStatusChange(event.target.value as DeliveryStatusFilter)}
      >
        <option value="active">활성</option>
        <option value="inactive">비활성</option>
        <option value="hasSpend">광고비 존재</option>
        <option value="all">전체</option>
      </select>
      <label className="daily-report-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="제품명 또는 소재명"
        />
      </label>
      <div className="daily-column-picker">
        <span>
          <Settings2 size={15} />
          표시 항목
        </span>
        <div className="daily-column-options">
          {META_DAILY_COLUMNS.map((column) => (
            <label key={column.key}>
              <input
                checked={visibleColumns.includes(column.key)}
                type="checkbox"
                onChange={() => onToggleColumn(column.key)}
              />
              {column.label}
            </label>
          ))}
        </div>
      </div>
      <button className="button" type="button" onClick={onPrint}>
        <Printer size={15} />
        출력
      </button>
      <button className="button primary" type="button" disabled={exportDisabled} onClick={onExportXlsx}>
        <Download size={15} />
        XLSX
      </button>
    </div>
  );
}

export function DailyReportPrintHeader({ previousDate, reportDate }: { previousDate: string; reportDate: string }) {
  return (
    <header className="daily-report-print-header">
      <div>
        <h1>Daily Report</h1>
        <p>보고 기준일: {reportDate}</p>
      </div>
      <span>전일 기준일: {previousDate}</span>
    </header>
  );
}
