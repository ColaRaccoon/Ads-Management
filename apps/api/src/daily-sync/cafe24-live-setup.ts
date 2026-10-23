import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const originalTables = ["cafe24_oauth_attempts", "cafe24_observed_day_checkpoints",
  "cafe24_observed_order_revisions", "security_audit_events", "source_connections", "source_credentials"];
const addedTables = ["app_users","cafe24_coupon_rules","cafe24_order_api_versions","cafe24_order_lines",
  "cafe24_product_rules","cafe24_upload_batches","cafe24_upload_row_errors","exchange_rates","product_cost_rules",
  "products","run_units","source_coverage","source_policies","source_record_links","sync_leases","sync_runs"];
const originalTypes = {
  SourceProvider: ["GOOGLE", "META", "CAFE24"],
  SourceAccessState: ["PENDING", "READY", "REAUTH_REQUIRED", "BLOCKED"],
  security_audit_actor_type: ["USER", "SYSTEM", "ANONYMOUS"],
  security_audit_result: ["REQUESTED", "PROVIDER_SUCCEEDED", "SUCCESS", "FAILURE", "PARTIAL"]
} as const;
const expectedColumns: Record<string, Record<string, string>> = {
  source_connections: { id: "uuid", provider: '"SourceProvider"', external_account_id: "character varying(256)",
    shop_key: "character varying(256)", display_name: "character varying(256)", currency_code: "character varying(3)",
    time_zone: "character varying(128)", credential_ref: "character varying(256)", credential_expires_at: "timestamp(3) with time zone",
    access_state: '"SourceAccessState"', enabled: "boolean", created_at: "timestamp(3) with time zone", updated_at: "timestamp(3) with time zone" },
  source_credentials: { id: "uuid", connection_id: "uuid", kind: "character varying(32)", ciphertext: "bytea", iv: "bytea",
    auth_tag: "bytea", key_version: "integer", revision: "integer", refresh_owner: "uuid", refresh_until: "timestamp(3) with time zone",
    expires_at: "timestamp(3) with time zone", created_at: "timestamp(3) with time zone", updated_at: "timestamp(3) with time zone" },
  cafe24_oauth_attempts: { id: "uuid", connection_id: "uuid", state_hash: "character(64)", actor_user_id: "uuid",
    expires_at: "timestamp(3) with time zone", consumed_at: "timestamp(3) with time zone", created_at: "timestamp(3) with time zone" },
  security_audit_events: { id: "uuid", actor_user_id: "uuid", actor_type: "security_audit_actor_type", action: "character varying(96)",
    target_type: "character varying(64)", target_id: "character varying(128)", result: "security_audit_result", before_json: "jsonb",
    after_json: "jsonb", request_id: "uuid", created_at: "timestamp(3) with time zone" },
  cafe24_observed_order_revisions: { connection_id: "uuid", order_key_hash: "character(64)", revision: "integer",
    order_date: "date", content_hash: "character(64)", first_observed_at: "timestamp(3) with time zone",
    last_observed_at: "timestamp(3) with time zone", observation_id: "uuid", is_current: "boolean" },
  cafe24_observed_day_checkpoints: { connection_id: "uuid", order_date: "date", query_started_at: "timestamp(3) with time zone",
    completed_at: "timestamp(3) with time zone", observation_id: "uuid", key_version: "integer", order_count: "integer",
    item_count: "integer", snapshot_hash: "character(64)" }
};
const nullableColumns: Record<string, Set<string>> = {
  source_connections: new Set(["credential_ref", "credential_expires_at"]),
  source_credentials: new Set(["refresh_owner", "refresh_until", "expires_at"]),
  cafe24_oauth_attempts: new Set(["actor_user_id", "consumed_at"]),
  security_audit_events: new Set(["actor_user_id", "target_id", "before_json", "after_json", "request_id"]),
  cafe24_observed_order_revisions: new Set(), cafe24_observed_day_checkpoints: new Set()
};

export function assertLiveSetupEnvironment(env: NodeJS.ProcessEnv) {
  if (env.DAILY_SYNC_FEATURE_ENABLED === "true" || env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true" ||
      env.RAILWAY_PROJECT_ID !== "d72f4256-8632-437a-9dae-9b5d96736fc7" ||
      env.RAILWAY_ENVIRONMENT_ID !== "d261a432-a6a4-4031-b8ea-c619ac263cc3" ||
      env.RAILWAY_SERVICE_ID !== "deaaeaf9-ee5c-42fa-b32f-600c7a90befc" ||
      env.DAILY_SYNC_CAFE24_DB_SERVICE_ID !== "ef46528f-4b59-4ee6-9d9c-b0852b5a9274")
    throw new Error("ISOLATED_LIVE_SETUP_REQUIRED");
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ""); } catch { throw new Error("ISOLATED_DATABASE_REQUIRED"); }
  if (!env.DAILY_SYNC_CAFE24_DB_HOST?.endsWith(".railway.internal") ||
      !env.DAILY_SYNC_CAFE24_DB_NAME || url.hostname !== env.DAILY_SYNC_CAFE24_DB_HOST ||
      url.port !== "5432" || url.pathname !== `/${env.DAILY_SYNC_CAFE24_DB_NAME}` ||
      !["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      [...url.searchParams.keys()].some((key) => key !== "schema") ||
      (url.searchParams.get("schema") ?? "public") !== "public")
    throw new Error("ISOLATED_DATABASE_REQUIRED");
}

type DbClient = PrismaClient | Prisma.TransactionClient;
const liveSqlPath=resolve(__dirname,"../../../../deploy/cafe24-test/live-additive.sql");
export async function readExistingIntegrity(client: DbClient, requireOnlySix: boolean,expectedDatabase=process.env.DAILY_SYNC_CAFE24_DB_NAME) {
  const [identity] = await client.$queryRaw<Array<{ database: string; schema: string }>>`
    SELECT current_database() AS database, current_schema() AS schema`;
  if (identity?.database !== expectedDatabase || identity.schema !== "public")
    throw new Error("ISOLATED_DATABASE_IDENTITY_MISMATCH");
  const tables = await client.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  if (requireOnlySix && JSON.stringify(tables.map((table) => table.name)) !== JSON.stringify(originalTables))
    throw new Error("ISOLATED_EXISTING_TABLE_INVENTORY_MISMATCH");
  if (!requireOnlySix) await assertAddedCatalog(client,tables.map((table) => table.name));
  const columns = await client.$queryRaw<Array<{ table: string; name: string; type: string; notNull: boolean; default: string | null }>>`
    SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS "notNull", pg_get_expr(d.adbin,d.adrelid) AS "default"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname IN (${Prisma.join(originalTables)})
    ORDER BY c.relname,a.attnum`;
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const observed = columns.filter((column) => column.table === table);
    if (observed.length !== Object.keys(expected).length || observed.some((column) => expected[column.name] !== column.type ||
        column.notNull === nullableColumns[table].has(column.name)))
      throw new Error("ISOLATED_EXISTING_COLUMN_SHAPE_MISMATCH");
  }
  const enums = await client.$queryRaw<Array<{ type: string; labels: string[] }>>`
    SELECT t.typname AS type,array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND t.typname IN (${Prisma.join(Object.keys(originalTypes))})
    GROUP BY t.typname ORDER BY t.typname`;
  if (enums.length !== 4 || enums.some((entry) =>
    JSON.stringify(entry.labels) !== JSON.stringify(originalTypes[entry.type as keyof typeof originalTypes])))
    throw new Error("ISOLATED_EXISTING_ENUM_SHAPE_MISMATCH");
  const indexes = await client.$queryRaw<Array<{ table: string; primary: boolean; unique: boolean; valid: boolean;
    definition: string; predicate: string | null }>>`
    SELECT c.relname AS "table",i.indisprimary AS primary,i.indisunique AS unique,i.indisvalid AS valid,
      pg_get_indexdef(i.indexrelid) AS definition,pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i
    JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (${Prisma.join(originalTables)})
    ORDER BY c.relname,i.indexrelid`;
  const mustBeUnique: Record<string, string[][]> = {
    source_connections: [["id"], ["provider", "external_account_id", "shop_key"]],
    source_credentials: [["id"], ["connection_id", "kind"]],
    cafe24_oauth_attempts: [["id"], ["state_hash"]], security_audit_events: [["id"]],
    cafe24_observed_order_revisions: [["connection_id", "order_key_hash", "revision"],
      ["connection_id", "order_key_hash"]],
    cafe24_observed_day_checkpoints: [["connection_id", "order_date"]]
  };
  for (const [table, signatures] of Object.entries(mustBeUnique))
    if (signatures.some((parts) => !indexes.some((index) => index.table === table && index.valid && index.unique &&
      index.definition.includes(`(${parts.join(", ")})`) &&
      (table === "cafe24_observed_order_revisions" && parts.length === 2
        ? ["is_current", "(is_current = true)"].includes(index.predicate ?? "") : index.predicate === null))))
      throw new Error("ISOLATED_EXISTING_UNIQUE_INDEX_SHAPE_MISMATCH");
  const foreignKeys = await client.$queryRaw<Array<{ table: string; definition: string }>>`
    SELECT c.relname AS "table",pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (${Prisma.join(originalTables)}) AND k.contype='f'
    ORDER BY c.relname,k.oid`;
  for (const table of ["source_credentials", "cafe24_oauth_attempts", "cafe24_observed_order_revisions", "cafe24_observed_day_checkpoints"])
    if (!foreignKeys.some((key) => key.table === table &&
      key.definition === "FOREIGN KEY (connection_id) REFERENCES source_connections(id) ON DELETE RESTRICT"))
      throw new Error("ISOLATED_EXISTING_FOREIGN_KEY_SHAPE_MISMATCH");
  const checks=await client.$queryRaw<Array<{name:string;definition:string}>>`
    SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.security_audit_events'::regclass AND contype='c' ORDER BY conname`;
  const expectedAudit=requireOnlySix ?
    "CHECK (((actor_type = 'SYSTEM'::security_audit_actor_type) AND (actor_user_id IS NULL)))" :
    "CHECK ((((actor_type = 'SYSTEM'::security_audit_actor_type) AND (actor_user_id IS NULL)) OR ((actor_type = 'USER'::security_audit_actor_type) AND (actor_user_id IS NOT NULL))))";
  const expectedAuditName=requireOnlySix ? "security_audit_events_system_only_check" : "security_audit_events_system_or_user_check";
  if (checks.length!==1 || checks[0].name!==expectedAuditName || checks[0].definition!==expectedAudit)
    throw new Error("ISOLATED_EXISTING_AUDIT_ACTOR_CHECK_MISMATCH");
  if (!requireOnlySix && !foreignKeys.some((key) => key.table==="security_audit_events" &&
      key.definition==="FOREIGN KEY (actor_user_id) REFERENCES app_users(id) ON DELETE RESTRICT"))
    throw new Error("ISOLATED_AUDIT_ACTOR_FOREIGN_KEY_MISMATCH");
  const rows: Record<string, number> = {};
  const rowDigests:Record<string,string|null>={};
  for (const table of originalTables) {
    const [count] = await client.$queryRawUnsafe<Array<{ count: number }>>(`SELECT COUNT(*)::int AS count FROM public."${table}"`);
    rows[table] = count.count;
    // The database hashes each complete row internally. Ciphertext, OAuth
    // state, audit payloads and observation content are not exported to JS.
    const [digest]=await client.$queryRawUnsafe<Array<{digest:string|null}>>(
      `SELECT encode(sha256(convert_to(string_agg(encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex'), '' ORDER BY row_to_json(t)::text),'UTF8')),'hex') AS digest FROM public."${table}" t`);
    rowDigests[table]=digest.digest;
  }
  const connections = await client.$queryRaw<Array<{ id: string; provider: string; mall: string; shop: string; currency: string; timeZone: string;
    enabled: boolean; state: string; updatedAt: Date }>>`
    SELECT id,provider::text AS provider,external_account_id AS mall,shop_key AS shop,currency_code AS currency,
      time_zone AS "timeZone",enabled,access_state::text AS state,updated_at AS "updatedAt" FROM source_connections`;
  const owner = connections[0];
  if (connections.length !== 1 || owner.provider !== "CAFE24" || owner.mall !== "didadi0729" || owner.shop !== "shop1" ||
      owner.currency !== "KRW" || owner.timeZone !== "Asia/Seoul" || owner.enabled || owner.state !== "READY")
    throw new Error("ISOLATED_EXISTING_CONNECTION_MISMATCH");
  const credentials = await client.$queryRaw<Array<{ id: string; connectionId: string; kind: string; revision: number; keyVersion: number;
    refreshOwner: string | null; refreshUntil: Date | null; updatedAt: Date }>>`
    SELECT id,connection_id AS "connectionId",kind,revision,key_version AS "keyVersion",
      refresh_owner AS "refreshOwner",refresh_until AS "refreshUntil",updated_at AS "updatedAt"
    FROM source_credentials ORDER BY kind`;
  if (credentials.length !== 2 || new Set(credentials.map((credential) => credential.kind)).size !== 2 ||
      credentials.some((credential) => credential.connectionId !== owner.id ||
        !["CAFE24_ACCESS", "CAFE24_REFRESH"].includes(credential.kind) || credential.revision < 1 ||
        credential.keyVersion < 1 || credential.refreshOwner !== null || credential.refreshUntil !== null))
    throw new Error("ISOLATED_EXISTING_CREDENTIAL_OWNER_MISMATCH");
  const privateDigest = createHash("sha256").update(JSON.stringify({ columns,enums,indexes,
    foreignKeys:foreignKeys.filter((key) => key.table!=="security_audit_events"),rows,rowDigests,connections,credentials })).digest("hex");
  return { privateDigest, safe: { databaseIdentityVerified: true, existingTableCount: 6,
    existingRowCounts: rows, columnShapeVerified: true, enumShapeVerified: true,
    uniqueIndexShapeVerified: true, auditActorCheckVerified:true, credentialOwnerSingle: true,
    credentialRevisions: credentials.map((credential) => credential.revision), connectionEnabled: false } };
}

export async function assertAddedCatalog(client:DbClient,inventory:string[]) {
  const expected=[...originalTables,...addedTables].sort();
  if (JSON.stringify(inventory)!==JSON.stringify(expected)) throw new Error("ISOLATED_ADDED_TABLE_INVENTORY_MISMATCH");
  const tables=await client.$queryRaw<Array<{name:string;rls:boolean}>>`
    SELECT c.relname AS name,c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (${Prisma.join(addedTables)}) ORDER BY c.relname`;
  if (tables.length!==16 || tables.some((table) => !table.rls)) throw new Error("ISOLATED_ADDED_TABLE_RLS_MISMATCH");
  const checks=await client.$queryRaw<Array<{name:string;validated:boolean}>>`
    SELECT conname AS name,convalidated AS validated FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN (${Prisma.join(addedTables)})
      AND k.contype='c'`;
  for (const name of ["source_policies_date_range_check","phase06_source_policy_kind","phase06_sync_one_day_check",
    "sync_runs_count_check","run_units_count_check","source_coverage_count_check","phase06_coverage_kind",
    "phase06_source_record_kind","cafe24_order_api_versions_nonnegative_check","cafe24_day_fingerprint_pair",
    "cafe24_order_lines_origin_check"])
    if (!checks.some((check) => check.name===name && check.validated)) throw new Error("ISOLATED_ADDED_CHECK_MISMATCH");
  const indexes=await client.$queryRaw<Array<{name:string;unique:boolean;valid:boolean;definition:string;predicate:string|null}>>`
    SELECT x.relname AS name,i.indisunique AS unique,i.indisvalid AS valid,pg_get_indexdef(i.indexrelid) AS definition,
      pg_get_expr(i.indpred,i.indrelid) AS predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (${Prisma.join(addedTables)})`;
  for (const [name,keys,source] of [
    ["cafe24_order_api_versions_one_current","connection_id, canonical_key_hash",null],
    ["cafe24_order_lines_api_current_key","connection_id, order_line_key","API"],
    ["cafe24_order_lines_csv_account_current_key","connection_id, order_line_key","CSV"],
    ["cafe24_order_lines_csv_legacy_current_key","order_line_key","CSV"],
    ["cafe24_order_lines_api_version_key","connection_id, order_line_key, import_version","API"]
  ] as const) {
    const index=indexes.find((entry) => entry.name===name);
    if (!index?.valid || !index.unique || !index.definition.includes('('+keys+')') || !index.predicate ||
        (source && !index.predicate.includes("'"+source+"'")) ||
        (name!=="cafe24_order_lines_api_version_key" && !index.predicate.includes("is_current")))
      throw new Error("ISOLATED_ADDED_CURRENT_INDEX_MISMATCH");
  }
  const foreignKeys=await client.$queryRaw<Array<{table:string;parent:string;fields:string[];parentFields:string[];deleteAction:string;updateAction:string;validated:boolean}>>`
    SELECT c.relname AS "table",p.relname AS parent,k.convalidated AS validated,
      k.confdeltype::text AS "deleteAction",k.confupdtype::text AS "updateAction",
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY f(num,pos)
        JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=f.num ORDER BY f.pos) AS fields,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY f(num,pos)
        JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=f.num ORDER BY f.pos) AS "parentFields"
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    WHERE n.nspname='public' AND pn.nspname='public' AND c.relname IN (${Prisma.join(addedTables)}) AND k.contype='f'`;
  for (const [table,field,parent] of [
    ["source_policies","connection_id","source_connections"],["source_policies","changed_by_user_id","app_users"],
    ["sync_runs","connection_id","source_connections"],["sync_runs","actor_user_id","app_users"],
    ["run_units","run_id","sync_runs"],["sync_leases","connection_id","source_connections"],
    ["sync_leases","owner_run_id","sync_runs"],["source_coverage","connection_id","source_connections"],
    ["source_coverage","last_attempt_run_id","sync_runs"],["source_coverage","last_success_run_id","sync_runs"],
    ["source_record_links","connection_id","source_connections"],["source_record_links","sync_run_id","sync_runs"],
    ["cafe24_order_api_versions","connection_id","source_connections"],["cafe24_order_api_versions","sync_run_id","sync_runs"],
    ["cafe24_order_lines","connection_id","source_connections"],["cafe24_order_lines","sync_run_id","sync_runs"]
  ]) if (!foreignKeys.some((key) => key.table===table && key.validated &&
    isAddedCafe24ForeignKeyShape(key,field,parent,table==="cafe24_order_lines" ? "a" : "c")))
      throw new Error("ISOLATED_ADDED_FOREIGN_KEY_MISMATCH");
  const [trigger]=await client.$queryRaw<Array<{enabled:string;definition:string}>>`
    SELECT t.tgenabled::text AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t
    WHERE t.tgrelid='public.source_policies'::regclass AND t.tgname='phase06_source_policy_overlap' AND NOT t.tgisinternal`;
  if (trigger?.enabled!=="O" || !trigger.definition.includes("BEFORE INSERT OR UPDATE") ||
      !trigger.definition.includes("phase06_guard_policy_overlap()"))
    throw new Error("ISOLATED_ADDED_POLICY_TRIGGER_MISMATCH");
}

/** Check catalog action codes and column identities, independent of deparse order. */
export function isAddedCafe24ForeignKeyShape(key:{parent:string;fields:string[];parentFields:string[];deleteAction:string;updateAction:string},field:string,parent:string,updateAction:"a"|"c") {
  return key.parent===parent && JSON.stringify(key.fields)===JSON.stringify([field]) &&
    JSON.stringify(key.parentFields)===JSON.stringify(["id"]) && key.deleteAction==="r" && key.updateAction===updateAction;
}

// Split static checked-in PostgreSQL DDL while preserving quoted strings,
// comments, and dollar-quoted DO/function bodies. Input is never request text.
export function splitStaticSql(sql: string) {
  const statements: string[] = [];
  let start = 0, quote = "", dollar = "", lineComment = false, blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index], next = sql[index+1];
    if (lineComment) { if (current === "\n") lineComment = false; continue; }
    if (blockComment) { if (current === "*" && next === "/") { blockComment = false; index++; } continue; }
    if (dollar) { if (sql.startsWith(dollar,index)) { index += dollar.length-1; dollar=""; } continue; }
    if (quote) {
      if (current === quote && next === quote) index++;
      else if (current === quote) quote="";
      continue;
    }
    if (current === "-" && next === "-") { lineComment=true; index++; }
    else if (current === "/" && next === "*") { blockComment=true; index++; }
    else if (current === "'" || current === '"') quote=current;
    else if (current === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) {
      dollar=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))![0]; index += dollar.length-1;
    } else if (current === ";") { statements.push(sql.slice(start,index).trim()); start=index+1; }
  }
  if (quote || dollar || blockComment || sql.slice(start).trim()) throw new Error("STATIC_LIVE_DDL_INVALID");
  return statements.filter(Boolean);
}

export async function precheckCafe24LiveSchema(prisma: PrismaClient) {
  assertLiveSetupEnvironment(process.env);
  const checkedInSchemaDigest=createHash("sha256").update(readFileSync(liveSqlPath)).digest("hex");
  return {...(await readExistingIntegrity(prisma,true)).safe,checkedInSchemaDigest};
}

export type Cafe24LiveSetupDiagnostic={category:"SETUP_BASELINE"|"SETUP_LOCKED_BASELINE"|"SETUP_DDL"|"SETUP_POSTCHECK"|"SETUP_PRESERVATION"|"SETUP_TRANSACTION";
  sqlState:string|null;guard:string|null;statementIndex:number|null};
const setupGuardCodes=new Set(["ISOLATED_ADDED_TABLE_INVENTORY_MISMATCH","ISOLATED_ADDED_TABLE_RLS_MISMATCH",
  "ISOLATED_ADDED_CHECK_MISMATCH","ISOLATED_ADDED_CURRENT_INDEX_MISMATCH","ISOLATED_ADDED_FOREIGN_KEY_MISMATCH",
  "ISOLATED_ADDED_POLICY_TRIGGER_MISMATCH","ISOLATED_EXISTING_AUDIT_ACTOR_CHECK_MISMATCH",
  "ISOLATED_AUDIT_ACTOR_FOREIGN_KEY_MISMATCH","ISOLATED_EXISTING_STATE_CHANGED","ISOLATED_EXISTING_STATE_NOT_PRESERVED"]);
const setupSqlStates=new Set(["42601","42710","42P07","42701","42703","42P01","42804","42883",
  "23503","23514","23505","55P03","57014","25P02","40001","40P01"]);
export function safeCafe24LiveSetupDiagnostic(error:unknown):Cafe24LiveSetupDiagnostic|null {
  if (!(error instanceof Cafe24LiveSetupFailure)) return null;
  return error.diagnostic;
}
class Cafe24LiveSetupFailure extends Error {
  constructor(readonly diagnostic:Cafe24LiveSetupDiagnostic) {super("ISOLATED_SETUP_FAILED");}
}
async function applyLiveSetup(prisma:PrismaClient,expectedSchemaDigest:string,expectedDatabase:string) {
  let category:Cafe24LiveSetupDiagnostic["category"]="SETUP_BASELINE";
  let statementIndex:number|null=null;
  try {
    return await apply();
  } catch(error) {
    const original=error as {message?:unknown;meta?:{code?:unknown}}|null;
    const sqlState=typeof original?.meta?.code==="string" && setupSqlStates.has(original.meta.code) ? original.meta.code : null;
    const guard=typeof original?.message==="string" && setupGuardCodes.has(original.message) ? original.message : null;
    throw new Cafe24LiveSetupFailure({category,sqlState,guard,statementIndex});
  }
  async function apply() {
  const sql = readFileSync(liveSqlPath,"utf8");
  if (!/^[a-f0-9]{64}$/.test(expectedSchemaDigest) || createHash("sha256").update(sql).digest("hex")!==expectedSchemaDigest)
    throw new Error("ISOLATED_SETUP_SCHEMA_DIGEST_MISMATCH");
  const parts = splitStaticSql(sql).filter((statement) => !/^\s*(?:--[^\n]*\n\s*)*(?:BEGIN|COMMIT)\s*$/.test(statement));
  const before = await readExistingIntegrity(prisma,true,expectedDatabase);
  category="SETUP_TRANSACTION";
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM source_connections FOR UPDATE`;
    category="SETUP_LOCKED_BASELINE";
    const locked = await readExistingIntegrity(tx,true,expectedDatabase);
    if (locked.privateDigest !== before.privateDigest) throw new Error("ISOLATED_EXISTING_STATE_CHANGED");
    category="SETUP_DDL";
    for (let index=0;index<parts.length;index++) {statementIndex=index;await tx.$executeRawUnsafe(parts[index]);}
    statementIndex=null;category="SETUP_POSTCHECK";
    const after = await readExistingIntegrity(tx,false,expectedDatabase);
    category="SETUP_PRESERVATION";
    if (after.privateDigest !== locked.privateDigest) throw new Error("ISOLATED_EXISTING_STATE_NOT_PRESERVED");
  }, { timeout: 30_000, maxWait: 2_000 });
  return { ...before.safe, additiveTableCount: 16, existingSixPreserved: true,
    checkedInSchemaDigest:expectedSchemaDigest,
    existingAuditActorCheckExtended:true,existingAuditActorForeignKeyAdded:true,
    tokenCopied: false, fullApplicationMigrationsApplied: false };
  }
}
export async function setupCafe24LiveSchema(prisma: PrismaClient, acknowledgement: string,expectedSchemaDigest:string) {
  assertLiveSetupEnvironment(process.env);
  if (acknowledgement !== "ADD_06_TABLES_AND_EXTEND_AUDIT_ACTOR_CHECK") throw new Error("ISOLATED_SETUP_ACK_REQUIRED");
  return applyLiveSetup(prisma,expectedSchemaDigest,process.env.DAILY_SYNC_CAFE24_DB_NAME!);
}
/** Local reproduction only: actual server address/port/database/role and fake
 * nondecryptable credentials are verified before the same setup implementation. */
export async function setupCafe24LiveSchemaSynthetic(prisma:PrismaClient,acknowledgement:string,expectedSchemaDigest:string) {
  if (acknowledgement!=="SYNTHETIC_06_LIVE_DDL_ONLY") throw new Error("SYNTHETIC_LIVE_DDL_ACK_REQUIRED");
  const [identity]=await prisma.$queryRaw<Array<{address:string;port:number;database:string;role:string;schema:string}>>`
    SELECT host(inet_server_addr()) AS address,inet_server_port() AS port,current_database() AS database,
      current_user AS role,current_schema() AS schema`;
  if (identity?.address!=="127.0.0.1" || identity.port!==55437 || identity.database!=="phase06_live_ddl" ||
      identity.role!=="phase06_harness" || identity.schema!=="public") throw new Error("SYNTHETIC_LIVE_DDL_IDENTITY_REQUIRED");
  if (await prisma.sourceCredential.count({where:{ciphertext:Buffer.from([0]),iv:Buffer.alloc(12),authTag:Buffer.alloc(16)}})!==2)
    throw new Error("SYNTHETIC_LIVE_DDL_FAKE_CREDENTIALS_REQUIRED");
  return applyLiveSetup(prisma,expectedSchemaDigest,"phase06_live_ddl");
}
