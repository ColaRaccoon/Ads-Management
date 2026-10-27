import { Suspense } from "react";
import { GoogleDailyReportPage } from "@/components/google-daily-report-page";

export default function Page() {
  return <Suspense fallback={<p className="page">Google 조회 조건을 읽고 있습니다.</p>}><GoogleDailyReportPage /></Suspense>;
}
