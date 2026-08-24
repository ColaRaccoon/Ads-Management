import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { AppFrame } from "@/components/app-frame";

export const metadata: Metadata = {
  title: "Meta Ads Performance Hub",
  description: "CSV 기반 Meta 광고 성과 분석과 운영 판단 보조 도구"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <Providers>
          <AppFrame>{children}</AppFrame>
        </Providers>
      </body>
    </html>
  );
}
