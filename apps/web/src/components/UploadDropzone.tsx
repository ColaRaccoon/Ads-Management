"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadCloud } from "lucide-react";
import { useState } from "react";
import { uploadCsv } from "@/lib/api";
import { PermissionGate } from "@/components/permission-gate";

export function UploadDropzone({ onUploaded }: { onUploaded?: (result: any) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [recovering, setRecovering] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (!file) {
        throw new Error("CSV 파일이 필요합니다.");
      }
      setRecovering(false);
      return uploadCsv(file, "SKIP", () => setRecovering(true));
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["uploads"] });
      onUploaded?.(result);
    }
  });

  return (
    <PermissionGate permission="imports.manage" fallback={<div className="warning-strip"><span>읽기 전용 계정입니다.</span></div>}>
      <div className="dropzone">
        <input className="input" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        <div className="toolbar">
          <button className="btn primary" type="button" onClick={() => mutation.mutate()} disabled={!file || mutation.isPending}>
            <UploadCloud size={17} />
            Upload
          </button>
        </div>
        {mutation.isError ? <div className="badge risk">{(mutation.error as any).message ?? "업로드 실패"}</div> : null}
        {mutation.isPending ? <div role="status">{recovering
          ? "서버의 처리 결과를 확인하고 있습니다. 파일을 다시 업로드하지 마세요."
          : "광고 데이터를 저장하고 있습니다. 몇 분 걸릴 수 있습니다."}</div> : null}
        {mutation.isSuccess ? <div className="badge good">{mutation.data.status}</div> : null}
      </div>
    </PermissionGate>
  );
}
