"use client";

import { Save } from "lucide-react";
import { FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, rangeQuery } from "@/lib/api";
import { useRange } from "@/lib/use-range";
import { DataTable } from "@/components/data-table";

export default function ChangeLogsPage() {
  const range = useRange();
  const queryClient = useQueryClient();
  const logs = useQuery({ queryKey: ["change-logs", range], queryFn: () => apiGet<Array<Record<string, any>>>(`/change-logs?${rangeQuery(range)}`) });
  const create = useMutation({
    mutationFn: (body: unknown) => apiPost("/change-logs", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["change-logs"] })
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate(Object.fromEntries(new FormData(event.currentTarget).entries()));
  };
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Change Logs</h1>
          <p>사람이 수행한 운영 변경을 기록합니다. 광고 제어 실행 기능은 제공하지 않습니다.</p>
        </div>
      </div>
      <form className="panel form-grid" onSubmit={submit}>
        <input className="input" name="actionDate" type="date" required />
        <select className="select" name="actionType" defaultValue="NOTE">
          <option>TURN_OFF</option>
          <option>BUDGET_CHANGE</option>
          <option>PROMOTE_STAGE</option>
          <option>DEMOTE_STAGE</option>
          <option>CREATIVE_EXCLUDE</option>
          <option>NOTE</option>
        </select>
        <select className="select" name="targetType" defaultValue="ADSET">
          <option>PRODUCT</option>
          <option>ADSET</option>
          <option>STAGE</option>
        </select>
        <input className="input" name="metaAdsetId" placeholder="metaAdsetId 선택 입력" />
        <input className="input" name="productId" placeholder="productId 선택 입력" />
        <input className="input" name="nextCheckDate" type="date" />
        <textarea className="textarea" name="reason" placeholder="변경 사유" required />
        <button className="button primary" type="submit"><Save size={16} />로그 기록</button>
      </form>
      <div className="panel" style={{ marginTop: 12 }}>
        <h2>운영 변경 이력</h2>
        <DataTable rows={logs.data ?? []} columns={[
          { key: "date", header: "일자", render: (row) => String(row.actionDate).slice(0, 10) },
          { key: "action", header: "Action", render: (row) => row.actionType },
          { key: "target", header: "Target", render: (row) => row.targetType },
          { key: "reason", header: "Reason", render: (row) => row.reason },
          { key: "next", header: "Next Check", render: (row) => row.nextCheckDate ? String(row.nextCheckDate).slice(0, 10) : "-" }
        ]} />
      </div>
    </section>
  );
}
