"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { useState } from "react";
import { uploadCsv } from "@/lib/api";

export function UploadDropzone({ onUploaded }: { onUploaded?: (result: any) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState("SKIP");
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (!file) {
        throw new Error("CSV 파일이 필요합니다.");
      }
      return uploadCsv(file, conflictPolicy);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["uploads"] });
      onUploaded?.(result);
    }
  });

  return (
    <div className="dropzone">
      <input className="input" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <div className="toolbar">
        <select className="select" value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value)}>
          <option value="SKIP">SKIP</option>
          <option value="OVERWRITE">OVERWRITE</option>
          <option value="NEW_VERSION">NEW_VERSION</option>
        </select>
        <button className="btn primary" type="button" onClick={() => mutation.mutate()} disabled={!file || mutation.isPending}>
          <UploadCloud size={17} />
          Upload
        </button>
      </div>
      {mutation.isError ? <div className="badge risk">{(mutation.error as any).message ?? "업로드 실패"}</div> : null}
      {mutation.isSuccess ? <div className="badge good">{mutation.data.status}</div> : null}
    </div>
  );
}
