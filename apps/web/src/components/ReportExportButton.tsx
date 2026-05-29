"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { apiPost } from "@/lib/api";
import { usePeriod } from "@/lib/usePeriod";

export function ReportExportButton({ reportType }: { reportType: string }) {
  const { from, to } = usePeriod();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => apiPost("/reports/export", { reportType, from, to }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["reports"] })
  });

  return (
    <button className="btn primary" type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
      <Download size={17} />
      {reportType}
    </button>
  );
}
