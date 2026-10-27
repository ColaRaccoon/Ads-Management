import { googleMoney, googleNumber, googleRatio, googleReasons } from "@/lib/google-display";
import type { GoogleCampaignRow, GoogleOptions } from "@/types/google";

export function GoogleCampaignTable({ rows, productName, options, detailed = false }: { rows: GoogleCampaignRow[]; productName: (id: string | null) => string; options: GoogleOptions; detailed?: boolean }) {
  return <div className="table-wrap"><table aria-label={detailed ? "캠페인 원본 및 연결 사유" : "캠페인 성과"}><thead><tr><th>{detailed ? "계정 / 캠페인 ID" : "광고 계정"}</th><th>캠페인</th><th>연결 상품</th><th>광고비</th><th>노출</th><th>클릭</th><th>CTR</th><th>CPC</th><th>{detailed ? "확인 사유" : "연결 상태"}</th></tr></thead><tbody>{rows.map((item) => <tr key={`${item.connectionId}:${item.campaignId}:${item.currencyCode}`}>
    <td>{detailed ? <>{item.customerId}<br />{item.campaignId}</> : options.connections.find(connection => connection.id === item.connectionId)?.displayName ?? item.customerId}</td>
    <td>{item.campaignName}</td><td>{item.productIds.map(productName).join(" / ") || "미배분"}{item.hasUnmapped && item.productIds.length ? " · 일부 미배분" : ""}</td><td>{googleMoney(item.adSpendKrwExact)}</td><td>{googleNumber(item.impressions)}</td><td>{googleNumber(item.clicks)}</td><td>{googleRatio(item.ctr, true)}</td><td>{googleMoney(item.cpcKrw)}</td><td>{detailed ? googleReasons(item.warningCodes) || "—" : item.hasUnmapped || item.warningCodes.length ? "확인 필요" : "연결 완료"}</td>
  </tr>)}{!rows.length ? <tr><td colSpan={9}>선택한 조건의 캠페인이 없습니다.</td></tr> : null}</tbody></table></div>;
}
