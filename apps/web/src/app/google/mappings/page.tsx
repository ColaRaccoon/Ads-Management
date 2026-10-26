import { GooglePerformancePage } from "@/components/google-performance-page";
import { Suspense } from "react";
export default function Page() { return <Suspense fallback={<p className="page">Google 조회 조건을 읽고 있습니다.</p>}><GooglePerformancePage view="mappings" /></Suspense>; }
