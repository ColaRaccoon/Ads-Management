import type { DailyProductsReport } from "./daily-products-model";

export function generateDailyProductsWorkbook(report: DailyProductsReport, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL("./daily-products-xlsx.worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const clean = () => {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate(); signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => { if (settled) return; settled = true; clean(); reject(error); };
    const abort = () => fail(signal?.reason ?? new DOMException("출력을 취소했습니다.", "AbortError"));
    worker.onmessage = (event: MessageEvent<{ workbook?: Uint8Array; error?: string }>) => {
      if (settled) return;
      if (!(event.data?.workbook instanceof Uint8Array)) { fail(new Error(event.data?.error ?? "엑셀 생성 결과를 확인하지 못했습니다.")); return; }
      settled = true; clean(); resolve(event.data.workbook);
    };
    worker.onerror = () => fail(new Error("엑셀 생성 작업을 시작하지 못했습니다. 다시 시도해 주세요."));
    worker.onmessageerror = () => fail(new Error("엑셀 생성 자료를 전달하지 못했습니다."));
    signal?.addEventListener("abort", abort, { once: true });
    try { worker.postMessage(report); } catch (error) { fail(error); }
  });
}
