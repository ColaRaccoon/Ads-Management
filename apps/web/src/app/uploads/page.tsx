"use client";

import { AlertTriangle, Trash2, UploadCloud } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiDelete, apiGet, uploadCsv } from "@/lib/api";
import { DataTable } from "@/components/data-table";

type UploadBatchRow = {
  id: string;
  originalFilename: string;
  status: string;
  level: string;
  rowCount: number;
  validRowCount: number;
  warningCount: number;
  errorCount: number;
  fileHashSha256: string;
};

export default function UploadsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState("SKIP");
  const queryClient = useQueryClient();
  const uploads = useQuery({ queryKey: ["uploads"], queryFn: () => apiGet<UploadBatchRow[]>("/uploads") });
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("CSV 파일을 선택하세요.");
      return uploadCsv(file, conflictPolicy);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries();
    }
  });
  const deleteUpload = useMutation({
    mutationFn: (id: string) => apiDelete(`/uploads/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries();
    }
  });
  const summary = upload.data?.previewSummary;

  const handleDelete = (row: UploadBatchRow) => {
    const filename = row.originalFilename || row.id;
    if (!window.confirm(`${filename} 업로드와 가져온 데이터를 삭제할까요?`)) {
      return;
    }
    deleteUpload.mutate(row.id);
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Uploads</h1>
          <p>Meta 광고 단위 CSV를 업로드하고 배치 이력을 관리합니다.</p>
        </div>
      </div>
      <div className="grid two">
        <div className="panel">
          <h2>Meta 광고 단위 CSV 업로드</h2>
          <div className="dropzone">
            <input className="input" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <select className="select" value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value)}>
              <option value="SKIP">SKIP</option>
              <option value="OVERWRITE">OVERWRITE</option>
              <option value="NEW_VERSION">NEW_VERSION</option>
            </select>
            <button className="button primary" type="button" onClick={() => upload.mutate()} disabled={!file || upload.isPending}>
              <UploadCloud size={16} />
              업로드
            </button>
            {upload.isError ? <span style={{ color: "#b42318" }}>{String(upload.error.message)}</span> : null}
            {deleteUpload.isError ? <span style={{ color: "#b42318" }}>{String(deleteUpload.error.message)}</span> : null}
            {summary ? (
              <div className="warning-strip">
                <span>기간 {summary.sampleRows?.[0]?.dateStart ?? "-"} / Rows {summary.rowCount}</span>
                <span>캠페인 {summary.campaignCount} / 광고세트 {summary.adsetCount} / 광고 {summary.adCount}</span>
                <span>지출 ${summary.totalSpendUsd} / 구매 {summary.totalPurchases}</span>
                <span>중복 key {summary.duplicateKeys?.length ?? 0}</span>
              </div>
            ) : upload.data ? (
              <pre>{JSON.stringify(upload.data, null, 2)}</pre>
            ) : null}
          </div>
        </div>
        <div className="panel">
          <h2>검증 정책</h2>
          <div className="warning-strip">
            <span><AlertTriangle size={15} />캠페인, 광고세트, 광고 식별 컬럼 누락 시 import 차단</span>
            <span><AlertTriangle size={15} />동일 파일 SHA-256 중복 감지</span>
            <span><AlertTriangle size={15} />광고 ID가 없으면 synthetic key로 생성하고 경고 표시</span>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Batch History</h2>
        <DataTable
          rows={uploads.data ?? []}
          columns={[
            { key: "file", header: "파일명", render: (row) => row.originalFilename },
            { key: "status", header: "상태", render: (row) => row.status },
            { key: "level", header: "레벨", render: (row) => row.level },
            { key: "rows", header: "Rows", render: (row) => row.rowCount },
            { key: "valid", header: "Valid", render: (row) => row.validRowCount },
            { key: "warn", header: "Warnings", render: (row) => row.warningCount },
            { key: "err", header: "Errors", render: (row) => row.errorCount },
            { key: "hash", header: "Hash", render: (row) => String(row.fileHashSha256).slice(0, 16) },
            {
              key: "actions",
              header: "",
              render: (row) => (
                <button
                  className="icon-button danger"
                  type="button"
                  title="삭제"
                  onClick={() => handleDelete(row)}
                  disabled={deleteUpload.isPending}
                >
                  <Trash2 size={15} />
                </button>
              )
            }
          ]}
        />
      </div>
    </section>
  );
}
