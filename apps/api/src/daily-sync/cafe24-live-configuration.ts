import {createHash} from "node:crypto";
import {Prisma,PrismaClient} from "@prisma/client";
import {toCafe24MatcherRules,type Cafe24MatcherRuleRow} from "./cafe24-rule-loader";
import {verifyCsvMappingForDateRepair} from "./cafe24-live-csv-mapping";

export function configurationRow(value: unknown, fields: readonly string[], dateFields: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONFIGURATION_INVALID");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !fields.includes(key)) ||
      Object.values(row).some((cell) => typeof cell === "string" &&
        (cell.length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cell))))
    throw new Error("CONFIGURATION_INVALID");
  const copy = { ...row };
  for (const key of dateFields) {
    if (copy[key] == null) continue;
    if (typeof copy[key] !== "string" || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?Z)?$/.test(copy[key] as string))
      throw new Error("CONFIGURATION_INVALID");
    const converted = new Date(copy[key] as string);
    if (!Number.isFinite(converted.getTime())) throw new Error("CONFIGURATION_INVALID");
    copy[key] = converted;
  }
  return copy;
}

export function prepareConfiguration(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONFIGURATION_REQUIRED");
  const configuration = value as Record<string, unknown>;
  if (Object.keys(configuration).some((key) => !["observedAt", "hash", "products", "costRules", "productRules", "couponRules"].includes(key)) ||
      typeof configuration.observedAt !== "string" || !Number.isFinite(Date.parse(configuration.observedAt)) ||
      typeof configuration.hash !== "string" || !/^[a-f0-9]{64}$/.test(configuration.hash))
    throw new Error("CONFIGURATION_INVALID");
  const sizes = { products: 18, costRules: 24, productRules: 35, couponRules: 2 } as const;
  for (const [key, size] of Object.entries(sizes))
    if (!Array.isArray(configuration[key]) || configuration[key].length !== size)
      throw new Error("CONFIGURATION_INVENTORY_MISMATCH");
  const rawFingerprint = createHash("sha256").update(JSON.stringify({
    products: configuration.products, costRules: configuration.costRules,
    productRules: configuration.productRules, couponRules: configuration.couponRules
  })).digest("hex");
  if (rawFingerprint !== configuration.hash) throw new Error("CONFIGURATION_FINGERPRINT_MISMATCH");
  const products = (configuration.products as unknown[]).map((row) => configurationRow(row,
    ["id", "code", "name", "displayName", "sortOrder", "isActive"]));
  const costRules = (configuration.costRules as unknown[]).map((row) => configurationRow(row,
    ["id", "productId", "salePriceKrw", "vatKrw", "productCostKrw", "shippingKrw", "extraCostKrw",
      "fxRateKrwPerUsd", "effectiveFrom", "effectiveTo"], ["effectiveFrom", "effectiveTo"]));
  const productRules = (configuration.productRules as unknown[]).map((row) => configurationRow(row,
    ["id", "productId", "displayName", "productNumbers", "productNameAliases", "optionIncludeKeywords",
      "optionExcludeKeywords", "adCostSourceProductId", "roasGroup", "salePriceKrwOverride",
      "productCostKrwOverride", "shippingKrwOverride", "extraCostKrwOverride", "priority", "isActive",
      "validFrom", "validTo", "createdAt"], ["validFrom", "validTo", "createdAt"]));
  const couponRules = (configuration.couponRules as unknown[]).map((row) => configurationRow(row,
    ["id", "name", "scope", "productId", "discountKrw", "priority", "validFrom", "validTo", "isActive", "createdAt"],
    ["validFrom", "validTo", "createdAt"]));
  return {configuration,sizes,products,costRules,productRules,couponRules};
}

const configurationFields={
  products:["id","code","name","displayName","sortOrder","isActive"],
  costRules:["id","productId","salePriceKrw","vatKrw","productCostKrw","shippingKrw","extraCostKrw","fxRateKrwPerUsd","effectiveFrom","effectiveTo"],
  productRules:["id","productId","displayName","productNumbers","productNameAliases","optionIncludeKeywords","optionExcludeKeywords","adCostSourceProductId","roasGroup","salePriceKrwOverride","productCostKrwOverride","shippingKrwOverride","extraCostKrwOverride","priority","isActive","validFrom","validTo","createdAt"],
  couponRules:["id","name","scope","productId","discountKrw","priority","validFrom","validTo","isActive","createdAt"]
} as const;
type ConfigDb=PrismaClient|Prisma.TransactionClient;
async function preservedDataDigest(db:ConfigDb) {
  const hashes=[];
  for(const table of ["source_credentials","cafe24_order_lines","cafe24_upload_batches"])
    hashes.push(await db.$queryRawUnsafe(`SELECT encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') AS digest FROM public."${table}" t`));
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
}
export async function readConfigurationRows(db:ConfigDb) {
  const select=(fields:readonly string[])=>Object.fromEntries(fields.map(field=>[field,true]));
  return {
    products:await db.product.findMany({select:select(configurationFields.products),orderBy:{id:"asc"}}),
    costRules:await db.productCostRule.findMany({select:select(configurationFields.costRules),orderBy:{id:"asc"}}),
    productRules:await db.cafe24ProductRule.findMany({select:select(configurationFields.productRules),orderBy:{id:"asc"}}),
    couponRules:await db.cafe24CouponRule.findMany({select:select(configurationFields.couponRules),orderBy:{id:"asc"}})
  };
}
export async function configurationStateDigest(db:ConfigDb) {
  return createHash("sha256").update(JSON.stringify(normalizeConfigurationCell(await readConfigurationRows(db),""))).digest("hex");
}
export function assertConfigurationIdentitySets(expected:readonly Record<string,unknown>[],stored:readonly Record<string,unknown>[]) {
  const inputIds=expected.map(row=>row.id),storedIds=stored.map(row=>row.id);
  if(inputIds.some(id=>typeof id!=="string") || storedIds.some(id=>typeof id!=="string") ||
    new Set(inputIds).size!==inputIds.length || new Set(storedIds).size!==storedIds.length ||
    JSON.stringify([...inputIds].sort())!==JSON.stringify([...storedIds].sort()))throw new Error("CONFIGURATION_DATE_REPAIR_STATE_CHANGED");
}

/** One explicit correction for the confirmed v1 DATE/local-time export defect.
 * Configuration source, old state and every non-date value must match exactly. */
export async function repairConfigurationDates(prisma:PrismaClient,value:unknown,input:{acknowledgement:string;expectedDigest:string;connectionId:string;actorUserId:string}) {
  if(input.acknowledgement!=="CORRECT_CONFIRMED_06_CONFIGURATION_DATE_EXPORT_ONLY" || !/^[a-f0-9]{64}$/.test(input.expectedDigest))throw new Error("CONFIGURATION_DATE_REPAIR_ACK_REQUIRED");
  const prepared=prepareConfiguration(value);
  const raw=value as Record<string,unknown[]>;
  for(const group of ["costRules","productRules","couponRules"] as const)
    for(const row of raw[group] as Record<string,unknown>[])
      for(const field of group==="costRules" ? ["effectiveFrom","effectiveTo"] : ["validFrom","validTo"])
        if(row[field]!==null && (typeof row[field]!=="string" || !/^\d{4}-\d\d-\d\d$/.test(row[field] as string)))throw new Error("CONFIGURATION_DATE_REPAIR_SOURCE_INVALID");
  return prisma.$transaction(async tx=> {
    const locked=await tx.$queryRaw<Array<{id:string;provider:string;mall:string;shop:string}>>`
      SELECT id,provider::text AS provider,external_account_id AS mall,shop_key AS shop FROM source_connections WHERE id=${input.connectionId}::uuid FOR UPDATE`;
    if(locked.length!==1 || locked[0].provider!=="CAFE24" || locked[0].mall!=="didadi0729" || locked[0].shop!=="shop1")throw new Error("CONFIGURATION_DATE_REPAIR_TARGET_INVALID");
    for(const table of ["products","product_cost_rules","cafe24_product_rules","cafe24_coupon_rules"])
      await tx.$queryRawUnsafe(`SELECT id FROM public."${table}" ORDER BY id FOR UPDATE`);
    if(await configurationStateDigest(tx)!==input.expectedDigest)throw new Error("CONFIGURATION_DATE_REPAIR_STATE_CHANGED");
    const preservedBefore=await preservedDataDigest(tx);
    const persisted=await readConfigurationRows(tx);
    const updates:Array<{group:"costRules"|"productRules"|"couponRules";id:string;data:Record<string,Date>}>=[];
    let dateFieldCount=0,timestampFieldCount=0;
    for(const group of ["products","costRules","productRules","couponRules"] as const) {
      const expected=prepared[group];const stored=persisted[group] as unknown as Record<string,unknown>[];
      assertConfigurationIdentitySets(expected,stored);
      for(const row of expected) {
        const current=stored.find(record=>record.id===row.id);
        if(!current)throw new Error("CONFIGURATION_DATE_REPAIR_STATE_CHANGED");
        const data:Record<string,Date>={};
        for(const field of configurationFields[group]) {
          const desired=row[field],actual=current[field];
          const dateOnly=["effectiveFrom","effectiveTo","validFrom","validTo"].includes(field);
          const timestamp=field==="createdAt";
          if(desired instanceof Date && (dateOnly||timestamp)) {
            const old=new Date(desired.getTime()-(dateOnly ? 24 : 9)*60*60_000);
            if(!(actual instanceof Date) || actual.getTime()!==old.getTime())throw new Error("CONFIGURATION_DATE_REPAIR_LEGACY_MISMATCH");
            data[field]=desired;if(dateOnly)dateFieldCount++;else timestampFieldCount++;
          } else if(JSON.stringify(normalizeConfigurationCell(desired,field))!==JSON.stringify(normalizeConfigurationCell(actual,field)))
            throw new Error("CONFIGURATION_DATE_REPAIR_NONDATE_CHANGED");
        }
        if(Object.keys(data).length)updates.push({group:group as "costRules"|"productRules"|"couponRules",id:row.id as string,data});
      }
    }
    if(dateFieldCount!==65 || timestampFieldCount!==37)throw new Error("CONFIGURATION_DATE_REPAIR_EXPECTED_COUNTS_MISMATCH");
    const activeProducts=new Set(prepared.products.filter(row=>row.isActive===true).map(row=>row.id));
    const correctedRules=toCafe24MatcherRules(prepared.productRules.filter(row=>row.isActive===true&&activeProducts.has(row.productId)) as unknown as Cafe24MatcherRuleRow[]);
    const csvMappingEvidence=await verifyCsvMappingForDateRepair(tx,input.connectionId,correctedRules,input.expectedDigest);
    for(const update of updates) {
      const delegate=update.group==="costRules"?tx.productCostRule:update.group==="productRules"?tx.cafe24ProductRule:tx.cafe24CouponRule;
      await (delegate.update as (query:unknown)=>Promise<unknown>)({where:{id:update.id},data:update.data});
    }
    const after=await readConfigurationRows(tx);
    for(const group of ["products","costRules","productRules","couponRules"] as const)
      for(const row of prepared[group]) {
        const stored=(after[group] as unknown as Record<string,unknown>[]).find(record=>record.id===row.id);
        if(!stored || configurationFields[group].some(field=>JSON.stringify(normalizeConfigurationCell(row[field],field))!==
          JSON.stringify(normalizeConfigurationCell(stored[field],field))))throw new Error("CONFIGURATION_DATE_REPAIR_POSTCHECK_FAILED");
      }
    if(await preservedDataDigest(tx)!==preservedBefore)throw new Error("CONFIGURATION_DATE_REPAIR_PRESERVATION_FAILED");
    const afterDigest=await configurationStateDigest(tx);
    await tx.securityAuditEvent.create({data:{actorType:"USER",actorUserId:input.actorUserId,
      action:"CAFE24_06_CONFIGURATION_DATE_EXPORT_CORRECTION",targetType:"SOURCE_CONNECTION",targetId:input.connectionId,result:"SUCCESS",
      beforeJson:{configurationStateDigest:input.expectedDigest},afterJson:{configurationStateDigest:afterDigest,
        sourceFingerprint:String(prepared.configuration.hash),dateFieldCount,timestampFieldCount}}});
    return {configurationDateRepairApplied:true,repairedDateFieldCount:dateFieldCount,
      ...csvMappingEvidence,
      configurationRepairDataPreserved:true,
      repairedTimestampFieldCount:timestampFieldCount,configurationStateDigest:afterDigest,
      configurationObservedAt:prepared.configuration.observedAt,configurationFingerprint:prepared.configuration.hash};
  },{timeout:30000,maxWait:2000,isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export function normalizeConfigurationCell(cell:unknown,key:string):unknown {
  if(cell instanceof Date)return cell.toISOString();
  if(cell instanceof Prisma.Decimal)return cell.toString();
  if(cell!=null && /Krw(?:Override)?$|^fxRateKrwPerUsd$/.test(key))return new Prisma.Decimal(String(cell)).toString();
  if(Array.isArray(cell))return cell.map(value=>normalizeConfigurationCell(value,""));
  if(cell && typeof cell==="object")return Object.fromEntries(Object.entries(cell).sort(([a],[b])=>a.localeCompare(b)).map(([field,value])=>[field,normalizeConfigurationCell(value,field)]));
  return cell;
}
export async function seedConfiguration(prisma: PrismaClient, value: unknown) {
  const {configuration,sizes,products,costRules,productRules,couponRules}=prepareConfiguration(value);
  const existing = await Promise.all([prisma.product.count(), prisma.productCostRule.count(),
    prisma.cafe24ProductRule.count(), prisma.cafe24CouponRule.count()]);
  if (existing.some((count) => count !== 0)) {
    if (JSON.stringify(existing) !== JSON.stringify(Object.values(sizes)))
      throw new Error("CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED");
    for (const [inputRows, delegate] of [[products, prisma.product], [costRules, prisma.productCostRule],
      [productRules, prisma.cafe24ProductRule], [couponRules, prisma.cafe24CouponRule]] as const) {
      for (const row of inputRows) {
        const select = Object.fromEntries(Object.keys(row).map((key) => [key,true]));
        const persisted = await (delegate.findUnique as (query: unknown) => Promise<Record<string, unknown> | null>)({
          where: { id: row.id }, select
        });
        if (!persisted || Object.keys(row).some((key) =>
          JSON.stringify(normalizeConfigurationCell(row[key],key)) !== JSON.stringify(normalizeConfigurationCell(persisted[key],key))))
          throw new Error("CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED");
      }
    }
    return { configurationObservedAt: configuration.observedAt,
      configurationFingerprint: configuration.hash, configurationCounts: sizes };
  }
  await prisma.$transaction(async (tx) => {
    await tx.product.createMany({ data: products as Prisma.ProductCreateManyInput[] });
    await tx.productCostRule.createMany({ data: costRules as Prisma.ProductCostRuleCreateManyInput[] });
    await tx.cafe24ProductRule.createMany({ data: productRules as Prisma.Cafe24ProductRuleCreateManyInput[] });
    await tx.cafe24CouponRule.createMany({ data: couponRules as Prisma.Cafe24CouponRuleCreateManyInput[] });
  });
  // Configuration describes current internal rules. It is not immutable proof
  // of the rules that were present when the historical order was first placed.
  return { configurationObservedAt: configuration.observedAt,
    configurationFingerprint: configuration.hash, configurationCounts: sizes };
}

