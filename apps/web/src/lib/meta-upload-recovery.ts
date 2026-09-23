export type MetaUploadBatch = {
  id: string;
  fileHashSha256: string;
  conflictPolicy: string;
  status: string;
  rowCount: number;
  validRowCount: number;
  warningCount: number;
  errorCount: number;
  columnSchema?: { originalFileHashSha256?: string; previewSummary?: unknown } | null;
};

export const UPLOAD_RESULT_UNKNOWN = "응답 연결이 끊겨 업로드 결과를 아직 확인하지 못했습니다. 업로드 이력에서 처리 상태를 확인한 뒤 다시 시도해 주세요.";

// Read-only reconciliation: a gateway failure does not mean the transaction failed.
// Never replay POST or accept an older batch for OVERWRITE/NEW_VERSION.
export async function recoverMetaUpload(input: {
  hash: string;
  policy: string;
  previousIds: Set<string>;
  list: () => Promise<MetaUploadBatch[]>;
  isTemporary: (error: unknown) => boolean;
  wait?: () => Promise<void>;
  attempts?: number;
}) {
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 10_000)));
  for (let attempt = 0; attempt < (input.attempts ?? 90); attempt += 1) {
    if (attempt > 0) await wait();
    let batches: MetaUploadBatch[];
    try { batches = await input.list(); }
    catch (error) {
      if (input.isTemporary(error)) continue;
      throw error;
    }
    const matching = batches.filter((batch) =>
      !input.previousIds.has(batch.id) && batch.conflictPolicy === input.policy &&
      (batch.columnSchema?.originalFileHashSha256 ?? batch.fileHashSha256) === input.hash
    );
    // Multiple concurrent imports cannot be attributed safely to this request.
    if (matching.length > 1) throw new Error(UPLOAD_RESULT_UNKNOWN);
    const batch = matching[0];
    if (!batch || ["PENDING", "VALIDATING"].includes(batch.status)) continue;
    if (batch.status === "IMPORTED" || batch.status === "PARTIAL") {
      return {
        batchId: batch.id, status: batch.status, rowCount: batch.rowCount,
        validRowCount: batch.validRowCount, warningCount: batch.warningCount,
        errorCount: batch.errorCount, previewSummary: batch.columnSchema?.previewSummary,
        recoveredAfterDisconnect: true
      };
    }
    if (batch.status === "FAILED") throw new Error("업로드 검증 또는 저장에 실패했습니다. 업로드 이력에서 오류 내용을 확인해 주세요.");
    throw new Error(UPLOAD_RESULT_UNKNOWN);
  }
  throw new Error(UPLOAD_RESULT_UNKNOWN);
}
