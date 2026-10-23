import {createHash} from "node:crypto";
import {Prisma,PrismaClient} from "@prisma/client";
import {assertLiveSetupEnvironment,readExistingIntegrity} from "./cafe24-live-setup";
import {liveChildFailure,parseLiveChildFailure} from "./cafe24-live-failure";

type Client=PrismaClient|Prisma.TransactionClient;
const acknowledgement="EXPAND_ISOLATED_06_DERIVED_OPTION_NAME_256_TO_514_ONLY";
const capacityTable="cafe24_order_api_versions";
type Catalog={tables:Array<{name:string;rls:boolean}>;columns:Array<{table:string;name:string;type:string;notNull:boolean;default:string|null}>;constraints:unknown[];indexes:unknown[];enums:unknown[];triggers:unknown[]};
async function readCatalog(client:Client):Promise<Catalog> {
  const [tables,columns,constraints,indexes,enums,triggers]=await Promise.all([
    client.$queryRaw<Catalog["tables"]>`SELECT c.relname AS name,c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`,
    client.$queryRaw<Catalog["columns"]>`SELECT c.relname AS "table",a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS "notNull",pg_get_expr(d.adbin,d.adrelid) AS "default" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname,a.attnum`,
    client.$queryRaw<unknown[]>`SELECT c.relname AS "table",k.conname AS name,k.convalidated AS valid,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
    client.$queryRaw<unknown[]>`SELECT c.relname AS "table",ci.relname AS name,i.indisvalid AS valid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class ci ON ci.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,ci.relname`,
    client.$queryRaw<unknown[]>`SELECT t.typname AS name,array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' GROUP BY t.typname ORDER BY t.typname`,
    client.$queryRaw<unknown[]>`SELECT c.relname AS "table",t.tgname AS name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`
  ]);
  return {tables,columns,constraints,indexes,enums,triggers};
}
export function assertOptionCapacityCatalog(catalog:Catalog,capacity:256|514) {
  const matches=catalog.columns.filter(column=>column.table===capacityTable&&column.name==="option_name");
  if(matches.length!==1 || matches[0].type!==`character varying(${capacity})` || !matches[0].notNull || matches[0].default!==null)throw new Error("ISOLATED_OPTION_CAPACITY_SHAPE_MISMATCH");
}
export function optionCapacityCatalogDigest(catalog:Catalog) {return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");}
async function rowDigest(client:Client,tables:Catalog["tables"]) {
  const digests:Array<{table:string;digest:string|null}>=[];
  for(const {name} of tables) {
    if(!/^[a-z][a-z0-9_]*$/.test(name))throw new Error("ISOLATED_OPTION_CAPACITY_INVENTORY_MISMATCH");
    const [row]=await client.$queryRawUnsafe<Array<{digest:string|null}>>(`SELECT encode(sha256(convert_to(string_agg(encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex'),'' ORDER BY row_to_json(t)::text),'UTF8')),'hex') AS digest FROM public."${name}" t`);
    digests.push({table:name,digest:row.digest});
  }
  return createHash("sha256").update(JSON.stringify(digests)).digest("hex");
}
async function assertIdleScope(client:Client) {
  const [state]=await client.$queryRaw<Array<{api:number;csv:number;apiLines:number;apiLinks:number;pending:number;activeLeases:number}>>`SELECT
    (SELECT count(*)::int FROM cafe24_order_api_versions) AS api,
    (SELECT count(*)::int FROM cafe24_order_lines WHERE source='CSV') AS csv,
    (SELECT count(*)::int FROM cafe24_order_lines WHERE source='API') AS "apiLines",
    (SELECT count(*)::int FROM source_record_links WHERE source='API') AS "apiLinks",
    (SELECT count(*)::int FROM sync_runs WHERE status IN ('QUEUED','RUNNING')) AS pending,
    (SELECT count(*)::int FROM sync_leases WHERE expires_at>now()) AS "activeLeases"`;
  if(state.api!==0 || state.csv!==477 || state.apiLines!==0 || state.apiLinks!==0 || state.pending!==0 || state.activeLeases!==0)throw new Error("ISOLATED_OPTION_CAPACITY_SCOPE_MISMATCH");
}
async function precheck(client:Client,database:string) {
  await readExistingIntegrity(client,false,database);
  await assertIdleScope(client);
  const catalog=await readCatalog(client);assertOptionCapacityCatalog(catalog,256);
  return {catalog,digest:optionCapacityCatalogDigest(catalog)};
}
export async function precheckCafe24OptionCapacity(prisma:PrismaClient) {
  assertLiveSetupEnvironment(process.env);
  try {const state=await precheck(prisma,process.env.DAILY_SYNC_CAFE24_DB_NAME!);
    return {optionCapacitySchemaDigest:state.digest,currentOptionNameCapacity:256,optionCapacityTransitionReady:true};}
  catch(error){throw parseLiveChildFailure(liveChildFailure(error,"PARENT_OPTION_CAPACITY"));}
}
export async function assertCafe24OptionCapacity(client:Client) {assertOptionCapacityCatalog(await readCatalog(client),514);}
async function expand(prisma:PrismaClient,ack:string,expectedDigest:string,verifiedAt:string,database:string) {
  const verified=Date.parse(verifiedAt);
  if(ack!==acknowledgement || !/^[a-f0-9]{64}$/.test(expectedDigest) || !Number.isFinite(verified) || verified>Date.now() || Date.now()-verified>30*60_000)throw new Error("ISOLATED_OPTION_CAPACITY_ACK_REQUIRED");
  return prisma.$transaction(async tx=> {
    await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;
    const before=await precheck(tx,database);
    if(before.digest!==expectedDigest)throw new Error("ISOLATED_OPTION_CAPACITY_SCHEMA_CHANGED");
    // Every table name is from the independently checked exact 22-table inventory.
    await tx.$executeRawUnsafe(`LOCK TABLE ${before.catalog.tables.map(table=>`public."${table.name}"`).join(",")} IN ACCESS EXCLUSIVE MODE`);
    const locked=await precheck(tx,database);
    if(locked.digest!==expectedDigest)throw new Error("ISOLATED_OPTION_CAPACITY_SCHEMA_CHANGED");
    const preserved=await rowDigest(tx,locked.catalog.tables);
    await tx.$executeRawUnsafe('ALTER TABLE public.cafe24_order_api_versions ALTER COLUMN option_name TYPE VARCHAR(514)');
    const after=await readCatalog(tx);assertOptionCapacityCatalog(after,514);
    const normalized={...after,columns:after.columns.map(column=>column.table===capacityTable&&column.name==="option_name"?{...column,type:"character varying(256)"}:column)};
    if(optionCapacityCatalogDigest(normalized)!==locked.digest || await rowDigest(tx,after.tables)!==preserved)throw new Error("ISOLATED_OPTION_CAPACITY_PRESERVATION_FAILED");
    await readExistingIntegrity(tx,false,database);await assertIdleScope(tx);
    return {optionCapacityExpanded:true,previousOptionNameCapacity:256,currentOptionNameCapacity:514,optionCapacitySchemaDigest:optionCapacityCatalogDigest(after),existingRowsPreserved:true,credentialAndCsvPreserved:true};
  },{timeout:30_000,maxWait:2_000,isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function expandCafe24OptionCapacity(prisma:PrismaClient,ack:string,digest:string,verifiedAt:string) {
  assertLiveSetupEnvironment(process.env);
  try{return await expand(prisma,ack,digest,verifiedAt,process.env.DAILY_SYNC_CAFE24_DB_NAME!);}
  catch(error){throw parseLiveChildFailure(liveChildFailure(error,"PARENT_OPTION_CAPACITY"));}
}
/** Synthetic rollback-only test entry; never accepts an external/private endpoint. */
async function syntheticDatabase(prisma:PrismaClient) {
  const [identity]=await prisma.$queryRaw<Array<{address:string;port:number;database:string;role:string;schema:string}>>`SELECT host(inet_server_addr()) AS address,inet_server_port() AS port,current_database() AS database,current_user AS role,current_schema() AS schema`;
  if(identity.address!=="127.0.0.1" || identity.port!==55437 || identity.database!=="phase06_live_ddl" || identity.role!=="phase06_harness" || identity.schema!=="public")throw new Error("SYNTHETIC_OPTION_CAPACITY_TARGET_REQUIRED");
  if(await prisma.sourceCredential.count({where:{ciphertext:Buffer.from([0]),iv:Buffer.alloc(12),authTag:Buffer.alloc(16)}})!==2)throw new Error("SYNTHETIC_OPTION_CAPACITY_FAKE_CREDENTIALS_REQUIRED");
  return identity.database;
}
export async function expandCafe24OptionCapacitySynthetic(prisma:PrismaClient,digest:string) {
  return expand(prisma,acknowledgement,digest,new Date(Date.now()-1_000).toISOString(),await syntheticDatabase(prisma));
}
export async function precheckCafe24OptionCapacitySynthetic(prisma:PrismaClient) {
  return (await precheck(prisma,await syntheticDatabase(prisma))).digest;
}
