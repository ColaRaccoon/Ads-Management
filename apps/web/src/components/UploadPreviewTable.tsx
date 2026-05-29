import { DataTable } from "./DataTable";
import { DecisionBadge } from "./DecisionBadge";

export function UploadPreviewTable({ rows }: { rows: Array<Record<string, any>> }) {
  return (
    <DataTable
      rows={rows}
      columns={[
        { key: "rowNumber", header: "Row" },
        { key: "validationStatus", header: "Status", render: (row) => <DecisionBadge value={row.validationStatus} /> },
        { key: "adsetName", header: "Adset" },
        { key: "stage", header: "Stage" },
        { key: "product", header: "Product", render: (row) => row.product?.displayName ?? "-" },
        { key: "productMatchSource", header: "Match" }
      ]}
    />
  );
}
