import { buildDailyProductsXlsx } from "./daily-products-xlsx";
import type { DailyProductsReport } from "./daily-products-model";

// A dedicated worker keeps the screen responsive when thousands of products are exported.
self.addEventListener("message", (event: MessageEvent<DailyProductsReport>) => {
  try {
    const workbook = buildDailyProductsXlsx(event.data);
    self.postMessage({ workbook }, { transfer: [workbook.buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "엑셀 파일을 만들지 못했습니다." });
  }
});
