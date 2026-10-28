import "reflect-metadata";
import { productionCafe24Db } from "./cafe24-production-context";
import { CredentialVault } from "../apps/api/src/daily-sync/credential-vault";
import { Cafe24OauthService } from "../apps/api/src/daily-sync/cafe24-oauth.service";
import { Cafe24OrderPreflightClient } from "../apps/api/src/daily-sync/cafe24-order-preflight.client";
import { cafe24OriginalOptionItems } from "../apps/api/src/daily-sync/cafe24-option-backfill";
import { accountAllowlist, accountKey } from "../apps/api/src/daily-sync/source-connections.service";
import { Prisma } from "@prisma/client";

// Run with the existing production service environment. Never print credentials,
// order identifiers or provider response bodies. Default is a read-only preview.
const connectionId = "be140e7e-3994-406e-94ff-b50dfc7ac7b2";
const apply = process.argv.includes("--apply");
const productNo = process.argv.find(v => v.startsWith("--product-no="))?.slice(13);
const maxOrders = Number(process.argv.find(v => v.startsWith("--limit-orders="))?.slice(15) ?? 100_000);
if ((!productNo && !process.argv.includes("--all")) || !Number.isSafeInteger(maxOrders) || maxOrders < 1) throw Error("EXPLICIT_SCOPE_REQUIRED");
if (process.env.SUPABASE_DATABASE_PROJECT_REF !== "iygjmosbelbosfxidqxv" || process.env.SUPABASE_DATABASE_SCHEMA !== "meta_ads")
  throw Error("PRODUCTION_TARGET_MISMATCH");
class OptionClient extends Cafe24OrderPreflightClient {
  async page(mall: string, shop: string, token: string, orders: string[], from: string, to: string) {
    const url = new URL(`https://${mall}.cafe24api.com/api/v2/admin/orders`);
    for (const [k,v] of Object.entries({shop_no:shop.slice(4),order_id:orders.join(","),
      start_date:from,end_date:to,date_type:"order_date",limit:"100",embed:"items",fields:"order_id,items"})) url.searchParams.set(k,v);
    const result = await this.getJson(url, token, Date.now()+60_000);
    const raw = (result.body as {orders?: unknown[]}).orders;
    if (!Array.isArray(raw)) throw Error("OPTION_ORDERS_REQUIRED");
    return raw.map(v => {
      const order = v as {order_id?:unknown;items?:unknown};
      if (typeof order.order_id !== "string" || !orders.includes(order.order_id)) throw Error("OPTION_ORDER_SCOPE_MISMATCH");
      return {orderNo:order.order_id,items:cafe24OriginalOptionItems(order.items)};
    });
  }
}
const {db,close} = productionCafe24Db();
let stage="CONNECTION";
async function main() {
  const connection = await db.sourceConnection.findUniqueOrThrow({where:{id:connectionId}});
  if(connection.provider!=="CAFE24" || connection.shopKey!=="shop1" ||
      !accountAllowlist().has(accountKey("CAFE24",connection.externalAccountId,connection.shopKey))) throw Error("CONNECTION_SCOPE_MISMATCH");
  const oauth=new Cafe24OauthService(db,new CredentialVault(db));
  const client=new OptionClient(db,oauth);
  stage="SELECT_LINES";
  const lines=await db.cafe24OrderLine.findMany({where:{isCurrent:true,optionValue:null,
    ...(productNo?{productNo}:{}),OR:[{connectionId},{connectionId:null,source:"CSV"}]},
    select:{id:true,source:true,connectionId:true,orderNo:true,lineOrderNo:true,productNo:true,orderDate:true},
    orderBy:[{orderDate:"asc"},{id:"asc"}]});
  const orders=[...new Set(lines.map(l=>l.orderNo))].slice(0,maxOrders);
  let received=0,updated=0,missing=0;
  console.log(JSON.stringify({mode:apply?"APPLY":"PREVIEW",targetOrders:orders.length,targetLines:lines.length}));
  for(let offset=0;offset<orders.length;offset+=50) {
    const batch=orders.slice(offset,offset+50),selected=lines.filter(l=>batch.includes(l.orderNo));
    const dates=selected.map(l=>l.orderDate?.toISOString().slice(0,10)).filter((v):v is string=>!!v).sort();
    stage="ACCESS_TOKEN";
    const token=await oauth.accessToken(connectionId,connection.externalAccountId,connection.shopKey);
    stage="PROVIDER_PAGE";
    const result=await client.page(connection.externalAccountId,connection.shopKey,token,batch,dates[0]??"2026-06-01",dates.at(-1)??"2026-10-27");
    const byOrder=new Map(result.map(o=>[o.orderNo,o.items]));
    const changes:Array<{id:string;optionValue:string}>=[];
    for(const line of selected) {
      const matches=(byOrder.get(line.orderNo)??[]).filter(i=>i.lineOrderNo===line.lineOrderNo && i.productNo===line.productNo);
      if(matches.length!==1){missing++;continue;}
      const optionValue=matches[0].optionValue;
      received++;
      changes.push({id:line.id,optionValue});
    }
    stage="APPLY_OPTION";
    if(apply && changes.length) await db.$transaction(async tx=>{
        const outcome=await tx.$queryRaw<Array<{id:string;source:string;order_no:string;line_order_no:string;product_no:string}>>(Prisma.sql`
          UPDATE cafe24_order_lines l SET option_value=v.option_value
          FROM jsonb_to_recordset(${JSON.stringify(changes.map(v=>({id:v.id,option_value:v.optionValue})))}::jsonb) AS v(id uuid,option_value text)
          WHERE l.id=v.id AND l.is_current AND l.option_value IS NULL
          RETURNING l.id,l.source::text,l.order_no,l.line_order_no,l.product_no`);
        if(outcome.length!==changes.length) throw Error("OPTION_BACKFILL_CONCURRENT_CHANGE");
        // Enrich the matching current API version as well, retaining its existing
        // source fingerprint so the next normal snapshot can version the V3 form.
        const api=outcome.filter(line=>line.source==="API");
        if(api.length) {
          const versions=await tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
            UPDATE cafe24_order_api_versions a SET option_value=l.option_value
            FROM cafe24_order_lines l WHERE l.id IN (${Prisma.join(api.map(v=>Prisma.sql`${v.id}::uuid`))})
              AND a.connection_id=${connectionId}::uuid AND a.is_current AND a.option_value IS NULL
              AND a.order_no=l.order_no AND a.line_order_no=l.line_order_no AND a.product_no=l.product_no AND a.version=l.import_version
            RETURNING a.id`);
          if(versions.length!==api.length) throw Error("OPTION_VERSION_IDENTITY_MISMATCH");
        }
        await tx.securityAuditEvent.createMany({data:changes.map(line=>({actorType:"SYSTEM",action:"CAFE24_ORIGINAL_OPTION_RECOVERED",
          targetType:"CAFE24_ORDER_LINE",targetId:line.id,result:"SUCCESS",beforeJson:{available:false},afterJson:{available:true}}))});
      },{timeout:20_000});
    if(apply)updated+=changes.length;
    console.log(JSON.stringify({processedOrders:Math.min(offset+batch.length,orders.length),received,updated,missing}));
    await new Promise(resolve=>setTimeout(resolve,550));
  }
  console.log(JSON.stringify({complete:missing===0,received,updated,missing,financialFieldsChanged:0,mappingFieldsChanged:0}));
}
main().catch(error=>{const response=error?.getResponse?.();const message=String(error?.message??"");let tls=message.includes("TLS")?message.slice(message.lastIndexOf("TLS")).split("\n")[0]:undefined;
  if(tls)for(const value of Object.values(process.env).filter((v):v is string=>!!v&&v.length>8).sort((a,b)=>b.length-a.length))tls=tls.replaceAll(value,"[REDACTED]");
  console.error(JSON.stringify({status:"FAILED",stage,name:error?.constructor?.name,code:error?.safeCode??error?.code??error?.errorCode??response?.code??(/^[A-Z_]{5,80}$/.test(message)?message:"OPTION_BACKFILL_FAILED"),tls:tls?.slice(0,300)}));process.exitCode=1;})
  .finally(close);
