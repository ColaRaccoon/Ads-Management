"use client";

import { Trash2, UploadCloud } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  apiDelete,
  apiGet,
  uploadCoupangAdsXlsx,
  uploadCoupangMarginCsv,
  uploadCoupangPromotionXlsx,
  uploadCoupangSalesXlsx
} from "@/lib/api";
import { DataTable } from "@/components/data-table";

type CoupangUploadBatch = {
  id: string;
  sourceType: string;
  originalFilename: string;
  status: string;
  rowCount: number;
  validRowCount: number;
  warningCount: number;
  errorCount: number;
  dataStart?: string | null;
  dataEnd?: string | null;
};

export default function CoupangUploadsPage() {
  const [salesFile, setSalesFile] = useState<File | null>(null);
  const [adsFile, setAdsFile] = useState<File | null>(null);
  const [marginFile, setMarginFile] = useState<File | null>(null);
  const [promotionFile, setPromotionFile] = useState<File | null>(null);
  const [reportDate, setReportDate] = useState(todayInputValue());
  const [effectiveFrom, setEffectiveFrom] = useState(todayInputValue());
  const queryClient = useQueryClient();
  const uploads = useQuery({
    queryKey: ["coupang-uploads"],
    queryFn: () => apiGet<CoupangUploadBatch[]>("/coupang/uploads")
  });

  const salesUpload = useMutation({
    mutationFn: () => {
      if (!salesFile) throw new Error("Sales XLSX file is required.");
      return uploadCoupangSalesXlsx(salesFile, { reportDate });
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const adsUpload = useMutation({
    mutationFn: () => {
      if (!adsFile) throw new Error("Ads XLSX file is required.");
      return uploadCoupangAdsXlsx(adsFile);
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const marginUpload = useMutation({
    mutationFn: () => {
      if (!marginFile) throw new Error("Sale price and margin CSV/TSV file is required.");
      return uploadCoupangMarginCsv(marginFile, { effectiveFrom });
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const promotionUpload = useMutation({
    mutationFn: () => {
      if (!promotionFile) throw new Error("Promotion XLSX file is required.");
      return uploadCoupangPromotionXlsx(promotionFile);
    },
    onSuccess: () => void queryClient.invalidateQueries()
  });
  const deleteUpload = useMutation({
    mutationFn: (id: string) => apiDelete(`/coupang/uploads/${id}`),
    onSuccess: () => void queryClient.invalidateQueries()
  });

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Coupang Uploads</h1>
          <p>Upload sales, ad performance, sale price and margin, and promotion files.</p>
        </div>
      </div>

      <div className="grid two">
        <UploadPanel
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={salesFile}
          title="Sales Analysis XLSX"
          isPending={salesUpload.isPending}
          onFile={setSalesFile}
          onUpload={() => salesUpload.mutate()}
        >
          <input className="input" type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
          <MutationMessage mutation={salesUpload} />
        </UploadPanel>
        <UploadPanel
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={adsFile}
          title="Ads Performance XLSX"
          isPending={adsUpload.isPending}
          onFile={setAdsFile}
          onUpload={() => adsUpload.mutate()}
        >
          <MutationMessage mutation={adsUpload} />
        </UploadPanel>
      </div>

      <div className="grid two" style={{ marginTop: 12 }}>
        <UploadPanel
          accept=".csv,.tsv,text/csv,text/tab-separated-values"
          file={marginFile}
          title="Sale Price & Product Margin CSV/TSV"
          isPending={marginUpload.isPending}
          onFile={setMarginFile}
          onUpload={() => marginUpload.mutate()}
        >
          <input className="input" type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
          <MutationMessage mutation={marginUpload} />
        </UploadPanel>
        <UploadPanel
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          file={promotionFile}
          title="Promotion XLSX"
          isPending={promotionUpload.isPending}
          onFile={setPromotionFile}
          onUpload={() => promotionUpload.mutate()}
        >
          <MutationMessage mutation={promotionUpload} />
        </UploadPanel>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <h2>Coupang Batch History</h2>
        <DataTable
          rows={uploads.data ?? []}
          columns={[
            { key: "file", header: "File", render: (row) => row.originalFilename },
            { key: "source", header: "Source", render: (row) => row.sourceType },
            { key: "status", header: "Status", render: (row) => row.status },
            { key: "period", header: "Period", render: (row) => `${formatDate(row.dataStart)} ~ ${formatDate(row.dataEnd)}` },
            { key: "rows", header: "Rows", render: (row) => row.rowCount },
            { key: "valid", header: "Valid", render: (row) => row.validRowCount },
            { key: "warnings", header: "Warnings", render: (row) => row.warningCount },
            { key: "errors", header: "Errors", render: (row) => row.errorCount },
            {
              key: "actions",
              header: "",
              render: (row) => (
                <button
                  className="icon-button danger"
                  type="button"
                  title="Delete upload"
                  disabled={deleteUpload.isPending}
                  onClick={() => {
                    if (window.confirm(`${row.originalFilename} upload data will be deleted.`)) {
                      deleteUpload.mutate(row.id);
                    }
                  }}
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

function UploadPanel({
  accept,
  children,
  file,
  isPending,
  onFile,
  onUpload,
  title
}: {
  accept: string;
  children?: ReactNode;
  file: File | null;
  isPending: boolean;
  onFile: (file: File | null) => void;
  onUpload: () => void;
  title: string;
}) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="dropzone">
        <input className="input" type="file" accept={accept} onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
        {children}
        <button className="button primary" type="button" disabled={!file || isPending} onClick={onUpload}>
          <UploadCloud size={16} />
          Upload
        </button>
      </div>
    </div>
  );
}

function MutationMessage({ mutation }: { mutation: { data: unknown; error: Error | null; isError: boolean } }) {
  if (mutation.isError) {
    return <span style={{ color: "#b42318" }}>{mutation.error?.message}</span>;
  }
  return mutation.data ? <pre>{JSON.stringify(mutation.data, null, 2)}</pre> : null;
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function formatDate(value?: string | null) {
  return value ? value.slice(0, 10) : "-";
}
