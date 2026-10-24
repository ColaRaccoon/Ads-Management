import { createHash, createHmac } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { cafe24ObservationKey } from "./cafe24-observed-revision";
import { cafe24StableItemKey } from "./cafe24-reviewed-parity";

/** A protected one-day review binding. The activation caller recomputes it
 * while holding the connection lock, before changing the selected source.
 * No provider token, raw CSV record, or personal field enters this digest. */
export async function computeCafe24ActivationEvidence(client: PrismaClient | Prisma.TransactionClient,
  connectionId: string, day: string, scope: {
    mode: "CSV_REVIEWED" | "API_ONLY";
    couponInputSource: "UNKNOWN" | "API_ACTUAL_PRODUCT_PLUS_SHIPPING"
  }): Promise<string> {
  const date=new Date(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==day)
    throw new Error("CAFE24_ACTIVATION_REVIEW_SCOPE_INVALID");
  const rows=await client.cafe24OrderLine.findMany({ where: { connectionId,isCurrent:true,
    OR:[{orderDate:date},{source:"CSV",orderDate:null}] },orderBy:{id:"asc"},
  select:{id:true,source:true,orderNo:true,lineOrderNo:true,productNo:true,productName:true,optionName:true,
    quantity:true,salePriceKrw:true,totalOrderKrw:true,totalPaidKrw:true,paymentMethod:true,
    providerPaymentCodes:true,providerCouponSignal:true,actualOrderPriceKrw:true,actualPaymentKrw:true,
    actualShippingFeeKrw:true,initialOrderPriceKrw:true,initialPaymentKrw:true,initialShippingFeeKrw:true,
    totalPaidInputSource:true,orderedAt:true,orderDate:true,productId:true,cafe24ProductRuleId:true,
    matchSource:true,validationStatus:true,importVersion:true,orderLineKey:true,syncRunId:true} });
  const keyHash=(row:typeof rows[number]) => createHash("sha256").update(JSON.stringify([
    connectionId,row.orderNo,row.lineOrderNo,row.productNo,row.optionName
  ].map((part) => part.trim()))).digest("hex");
  const apiKeys=new Set(rows.filter((row) => row.source==="API").map(keyHash));
  const apiStableKeys=new Set(rows.filter((row) => row.source==="API").map(cafe24StableItemKey));
  // Include the original undated CSV candidate in the protected review even
  // when a later explicit prefix-space review is needed. This grants no binding.
  const reviewed=rows.filter((row) => row.orderDate!==null || apiKeys.has(keyHash(row)) ||
    apiStableKeys.has(cafe24StableItemKey(row)));
  const hashes=[...new Set(reviewed.map(keyHash))];
  const [versions,links,coverage,policies]=await Promise.all([
    client.cafe24OrderApiVersion.findMany({where:{connectionId,orderDate:date,isCurrent:true},orderBy:{id:"asc"}}),
    client.sourceRecordLink.findMany({where:{connectionId,dataKind:"CAFE24_ORDER",isCurrent:true,
      recordTable:"cafe24_order_lines",canonicalKeyHash:{in:hashes}},orderBy:{id:"asc"}}),
    client.sourceCoverage.findUnique({where:{connectionId_dataKind_metricDate:{connectionId,dataKind:"CAFE24_ORDER",metricDate:date}}}),
    client.sourcePolicy.findMany({where:{connectionId,dataKind:"CAFE24_ORDER",fromDate:{lte:date},
      OR:[{toDate:null},{toDate:{gt:date}}]},orderBy:{id:"asc"}})
  ]);
  const run=coverage?.lastSuccessRunId ? await client.syncRun.findUnique({where:{id:coverage.lastSuccessRunId},
    select:{id:true,connectionId:true,status:true,fromDate:true,toDate:true,rowsFetched:true,rowsPublished:true,
      finishedAt:true}}) : null;
  const observation=cafe24ObservationKey();
  try {
    return createHmac("sha256",observation.key).update("cafe24-06-activation-review-v1\0")
      .update(JSON.stringify({connectionId,day,scope,keyVersion:observation.version,
        rows:reviewed,versions,links,coverage,run,policies})).digest("hex");
  } finally {observation.key.fill(0);}
}
