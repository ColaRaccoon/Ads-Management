import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const name='20261028003825_cafe24_separate_product_option';
const bytes=readFileSync(new URL(`../apps/api/prisma/migrations/${name}/migration.sql`,import.meta.url));
const checksum=createHash('sha256').update(bytes).digest('hex');
const output=process.argv[2];if(!output)throw Error('OUTPUT_REQUIRED');
const sql=`BEGIN;
SET LOCAL search_path=meta_ads,pg_catalog;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $pre$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres'
   OR to_regclass('meta_ads.cafe24_order_lines') IS NULL
   OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='meta_ads' AND table_name='cafe24_order_lines' AND column_name='option_value')
   OR EXISTS(SELECT 1 FROM meta_ads._prisma_migrations WHERE migration_name='${name}')
   OR pg_has_role('postgres','meta_ads_app','SET')
 THEN RAISE EXCEPTION 'CAFE_OPTION_MIGRATION_PRECONDITION'; END IF;
END $pre$;
CREATE TEMP TABLE cafe_option_baseline ON COMMIT DROP AS
 SELECT count(*) AS lines,count(*) FILTER(WHERE is_current) AS current_lines,
 sum(quantity) AS quantity,sum(sale_price_krw) AS sale_price,sum(total_paid_krw) AS paid
 FROM meta_ads.cafe24_order_lines;
GRANT meta_ads_app TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
SET LOCAL ROLE meta_ads_app;
LOCK TABLE meta_ads._prisma_migrations IN SHARE ROW EXCLUSIVE MODE;
${bytes.toString('utf8')}
INSERT INTO meta_ads._prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count)
 VALUES('${randomUUID()}','${checksum}',clock_timestamp(),'${name}',transaction_timestamp(),1);
RESET ROLE;
REVOKE meta_ads_app FROM postgres GRANTED BY postgres;
DO $post$ BEGIN
 IF pg_has_role('postgres','meta_ads_app','SET') OR EXISTS(
   SELECT count(*),count(*) FILTER(WHERE is_current),sum(quantity),sum(sale_price_krw),sum(total_paid_krw) FROM meta_ads.cafe24_order_lines
   EXCEPT SELECT lines,current_lines,quantity,sale_price,paid FROM cafe_option_baseline)
 THEN RAISE EXCEPTION 'CAFE_OPTION_MIGRATION_PRESERVATION_FAILED'; END IF;
END $post$;
SELECT '${name}' AS migration,'${checksum}' AS checksum,${process.argv.includes('--rollback')?'false':'true'} AS committed;
${process.argv.includes('--rollback')?'ROLLBACK':'COMMIT'};
`;
writeFileSync(output,sql,{flag:'wx'});
console.log(JSON.stringify({sqlSha256:createHash('sha256').update(sql).digest('hex'),migration:name,checksum,rollback:process.argv.includes('--rollback')}));
