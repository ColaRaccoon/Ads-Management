/** SKIP imports reserve the file hash on the server, so retrying cannot apply
 * the same file twice, even if the first response was lost after commit. */
export async function retryCoupangUpload<T>(
  work: () => Promise<T>,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000))
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const failure = error as { status?: number; code?: string | null } | null;
    const proxyFailure = failure?.code == null && [500, 502, 504].includes(failure?.status ?? 0);
    const retryableImport = failure?.status === 503 && failure.code === "COUPANG_IMPORT_RETRYABLE_FAILURE";
    if (!(error instanceof TypeError) && !proxyFailure && !retryableImport) throw error;
    await wait();
    return work();
  }
}
