import { Suspense } from "react";
import { ProductPerformancePage } from "@/features/product-performance/product-performance-page";

export default function Page() {
  return <Suspense fallback={<section className="page" aria-busy="true"><div className="panel">조회 조건을 불러오는 중입니다.</div></section>}><ProductPerformancePage /></Suspense>;
}
