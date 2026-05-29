"use client";

import { Download, FileDown } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, reportDownloadUrl } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

export default function ReportsPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const reports = useQuery({ queryKey: ["reports"], queryFn: () => apiGet<Array<Record<string, any>>>("/reports") });
  const create = useMutation({
    mutationFn: (reportType: string) => apiPost("/reports/export", { ...range, reportType }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] })
  });
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Reports</h1>
          <p>선택 기간 HTML/XLSX 보고서를 생성하고 다운로드합니다.</p>
        </div>
      </div>
      <div className="panel">
        <h2>Report Export</h2>
        <div className="toolbar">
          <button className="button primary" type="button" onClick={() => create.mutate("DAILY_HTML")}><FileDown size={16} />일일 HTML</button>
          <button className="button" type="button" onClick={() => create.mutate("PERIOD_XLSX")}><FileDown size={16} />기간 XLSX</button>
          <button className="button" type="button" onClick={() => create.mutate("CHANGE_LOG_XLSX")}><FileDown size={16} />변경 로그 XLSX</button>
          <button className="button" type="button" onClick={() => create.mutate("CPA_RULE_XLSX")}><FileDown size={16} />CPA rule XLSX</button>
        </div>
      </div>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>생성 이력</h2>
        <DataTable rows={reports.data ?? []} columns={[
          { key: "type", header: "Type", render: (row) => row.reportType },
          { key: "period", header: "Period", render: (row) => `${String(row.periodStart).slice(0, 10)} ~ ${String(row.periodEnd).slice(0, 10)}` },
          { key: "status", header: "Status", render: (row) => row.status },
          { key: "hash", header: "Hash", render: (row) => row.fileHashSha256 ? String(row.fileHashSha256).slice(0, 16) : "-" },
          { key: "download", header: "Download", render: (row) => row.filePath ? <a className="button" href={reportDownloadUrl(row.id)}><Download size={15} />다운로드</a> : "-" }
        ]} />
      </div>
    </section>
  );
}
