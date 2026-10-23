import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { validatedMetaApiDays } from "../../../apps/api/src/common/meta-source-read-coverage";

test("EXPLAIN current template exactly matches current product SQL after whitespace normalization", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const script = `. './scripts/cloud/daily-data-sync/phase10-meta-explain-readonly-20261020.ps1'; $rows=@();foreach($kind in @('META_AD','META_ADSET')){foreach($range in @(@('2026-10-13','2026-10-14'),@('2026-10-09','2026-10-15'))){$rows+=@{kind=$kind;from=$range[0];to=$range[1];sql=(New-ExplainSql '${id}' $kind $range[0] $range[1] CURRENT)}}}; ConvertTo-Json -InputObject $rows -Compress`;
  const templates = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }));
  assert.equal(templates.length, 4);
  for (const row of templates) {
    let captured: any;
    await validatedMetaApiDays({ $queryRaw: async (sql: any) => { captured = sql; return []; } } as any,
      row.kind, [id], new Date(`${row.from}T00:00:00Z`), new Date(`${row.to}T00:00:00Z`));
    const rendered = captured.strings.reduce((text: string, part: string, i: number) => text + part +
      (i < captured.values.length ? `'${String(captured.values[i]).replaceAll("'", "''")}'` : ""), "");
    assert.equal(row.sql.replace(/\s/g, ""), rendered.replace(/\s/g, ""), `${row.kind}/${row.from}/${row.to}`);
  }
});
