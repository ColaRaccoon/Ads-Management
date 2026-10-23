import {Prisma} from "@prisma/client";
import {validCurrentMetadata} from "../domain/meta-current-metadata";
type Row={source?:string;actionReportTime?:string|null;purchaseCount?:number|null;purchaseValueUsd?:Prisma.Decimal|null;spendUsd:Prisma.Decimal;currentMetadata?:unknown};
export function hasMetaProviderPurchases(row:Row):boolean{
 return row.source==="API"&&row.actionReportTime==="MCP_PROVIDER_DEFAULT_UNVERIFIED"&&validCurrentMetadata(row.currentMetadata)&&!!row.currentMetadata.sourceContext?.purchaseMeasurement&&Number.isSafeInteger(row.purchaseCount)&&(row.purchaseCount as number)>=0&&row.purchaseValueUsd!=null&&row.purchaseValueUsd.isFinite()&&!row.purchaseValueUsd.isNegative();
}
/** Provider values are separate from legacy product-price revenue, ROAS and margin. */
export function aggregateMetaProviderPurchases(rows:readonly Row[]){
 const complete=rows.length>0&&rows.every(hasMetaProviderPurchases);
 const missing={providerPurchaseCount:null,providerPurchaseValueUsd:null,providerPurchaseRoas:null,providerPurchaseCpaUsd:null,providerPurchaseContext:null,providerPurchaseDerivedZeroCount:null};
 if(!complete)return missing;
 const count=rows.reduce((n,r)=>n+r.purchaseCount!,0),value=rows.reduce((n,r)=>n.plus(r.purchaseValueUsd!),new Prisma.Decimal(0)),spend=rows.reduce((n,r)=>n.plus(r.spendUsd),new Prisma.Decimal(0));
 return {providerPurchaseCount:count,providerPurchaseValueUsd:value.toNumber(),providerPurchaseRoas:spend.isZero()?null:value.div(spend).toNumber(),providerPurchaseCpaUsd:count===0?null:spend.div(count).toNumber(),providerPurchaseContext:"MCP_PROVIDER_DEFAULT_UNVERIFIED",providerPurchaseDerivedZeroCount:rows.filter(r=>validCurrentMetadata(r.currentMetadata)&&r.currentMetadata.sourceContext?.rawPurchaseNull===true).length};
}
