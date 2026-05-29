"use client";

import { AlertTriangle, UploadCloud } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, uploadCsv } from "@/lib/api";
import { DataTable } from "@/components/data-table";

export default function UploadsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState("SKIP");
  const queryClient = useQueryClient();
  const uploads = useQuery({ queryKey: ["uploads"], queryFn: () => apiGet<Array<Record<string, any>>>("/uploads") });
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("CSV 파일을 선택하세요.");
      return uploadCsv(file, conflictPolicy);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["uploads"] })
  });

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Uploads</h1>
          <p>메타 광고 세트 CSV 26개 컬럼을 검증하고 원본 row와 metric을 저장합니다.</p>
        </div>
      </div>
      <div className="grid two">
        <div className="panel">
          <h2>CSV 업로드</h2>
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
            {upload.data ? <pre>{JSON.stringify(upload.data, null, 2)}</pre> : null}
          </div>
        </div>
        <div className="panel">
          <h2>검증 정책</h2>
          <div className="warning-strip">
            <span><AlertTriangle size={15} />필수 컬럼 누락 시 metric import 차단</span>
            <span><AlertTriangle size={15} />동일 파일 SHA-256 중복 감지</span>
            <span><AlertTriangle size={15} />원본 row와 column schema 저장</span>
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
            { key: "rows", header: "Rows", render: (row) => row.rowCount },
            { key: "valid", header: "Valid", render: (row) => row.validRowCount },
            { key: "warn", header: "Warnings", render: (row) => row.warningCount },
            { key: "err", header: "Errors", render: (row) => row.errorCount },
            { key: "hash", header: "Hash", render: (row) => String(row.fileHashSha256).slice(0, 16) }
          ]}
        />
      </div>
    </section>
  );
}
