import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
const name = '20261105011930_google_daily_creatives';
const bytes = readFileSync(new URL(`../apps/api/prisma/migrations/${name}/migration.sql`, import.meta.url));
const checksum = createHash('sha256').update(bytes).digest('hex');
const rollback = process.argv.includes('--rollback');
if (!process.argv[2]) throw Error('OUTPUT_REQUIRED');
const sql = `BEGIN;
SET LOCAL search_path=meta_ads,pg_catalog;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $pre$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
 OR to_regclass('meta_ads.google_campaign_daily_costs') IS NULL
 OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='meta_ads' AND table_name='google_campaign_daily_costs' AND column_name='creative_metrics')
 OR EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE migration_name='${name}')
 OR pg_has_role('postgres','meta_ads_app','SET')
 THEN RAISE EXCEPTION 'GOOGLE_CREATIVE_MIGRATION_PRECONDITION'; END IF;
END $pre$;
CREATE TEMP TABLE google_creative_baseline ON COMMIT DROP AS
 SELECT count(*) rows,md5(string_agg(to_jsonb(t)::text,'' ORDER BY id)) fingerprint FROM meta_ads.google_campaign_daily_costs t;
CREATE TEMP TABLE google_creative_memberships ON COMMIT DROP AS SELECT * FROM pg_auth_members
 WHERE roleid='meta_ads_app'::regrole AND member='postgres'::regrole;
GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
SET LOCAL ROLE meta_ads_app;
LOCK TABLE meta_ads._prisma_migrations IN SHARE ROW EXCLUSIVE MODE;
${bytes.toString('utf8')}
INSERT INTO meta_ads._prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count)
 VALUES('${randomUUID()}','${checksum}',clock_timestamp(),'${name}',transaction_timestamp(),1);
RESET ROLE;
REVOKE meta_ads_app FROM postgres GRANTED BY postgres;
DO $post$ BEGIN
 IF EXISTS(SELECT count(*),md5(string_agg((to_jsonb(t)-'creative_metrics')::text,'' ORDER BY id)) FROM meta_ads.google_campaign_daily_costs t
 EXCEPT SELECT rows,fingerprint FROM google_creative_baseline)
 OR (SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) FROM pg_auth_members a WHERE roleid='meta_ads_app'::regrole AND member='postgres'::regrole)
 IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(b) ORDER BY oid) FROM google_creative_memberships b)
 THEN RAISE EXCEPTION 'GOOGLE_CREATIVE_MIGRATION_PRESERVATION_FAILED'; END IF;
END $post$;
SELECT '${name}' migration,'${checksum}' checksum,${!rollback} committed;
${rollback ? 'ROLLBACK' : 'COMMIT'};
`;
writeFileSync(process.argv[2], sql, { flag: 'wx' });
console.log(JSON.stringify({ migration: name, checksum, rollback, sqlSha256: createHash('sha256').update(sql).digest('hex') }));
