// Fresh network-isolated PostgreSQL only. No provider calls or remote credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

test('real migration preserves legacy entities and isolates account uniqueness on the complete schema',()=>{
 const root=resolve('apps/api/prisma/migrations');
 const migration='20261024021144_meta_adset_legacy_external_scope';
 const names=readdirSync(root,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort();
 assert.equal(names.at(-1),migration);assert.equal(names.length,53);
 const sql=readFileSync(resolve(root,migration,'migration.sql'),'utf8');
 const name='meta-index-test-'+randomUUID().slice(0,8);let id;
 function query(input){const r=spawnSync('docker',['exec','-i',id,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-q'],{input,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});assert.equal(r.status,0,r.stderr.slice(-4000));return r.stdout;}
 try{
  id=execFileSync('docker',['run','--detach','--rm','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data','--tmpfs','/var/run/postgresql','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-alpine'],{encoding:'utf8',timeout:30000}).trim();
  let ready=false;for(let i=0;i<20;i++){const r=spawnSync('docker',['exec',id,'pg_isready','-U','postgres'],{encoding:'utf8'});if(r.status===0){ready=true;break;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);}assert(ready);
  query('CREATE SCHEMA meta_ads; SET search_path=meta_ads,pg_catalog;\n'+names.slice(0,-1).map(n=>readFileSync(resolve(root,n,'migration.sql'),'utf8')).join('\n'));
  const seed=`SET search_path=meta_ads,pg_catalog;
INSERT INTO source_connections(id,provider,external_account_id,display_name,currency_code,time_zone,updated_at) VALUES
 ('11111111-1111-4111-8111-111111111111','META','synthetic-1','Synthetic one','USD','Asia/Seoul',now()),
 ('22222222-2222-4222-8222-222222222222','META','synthetic-2','Synthetic two','USD','Asia/Seoul',now());
INSERT INTO meta_adsets(id,external_adset_id,adset_name,adset_name_key,updated_at) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','9001','Legacy synthetic','legacy-synthetic',now());
DO $$ BEGIN
 BEGIN INSERT INTO meta_adsets(id,connection_id,external_adset_id,adset_name,adset_name_key,updated_at) VALUES(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','9001','API','api',now());
 RAISE EXCEPTION 'Original collision was not reproduced'; EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
CREATE TABLE index_test_before AS SELECT to_jsonb(t) AS row FROM meta_adsets t;
BEGIN;
${sql}
ROLLBACK;
DO $$ BEGIN IF (SELECT pg_get_expr(indpred,indrelid) FROM pg_index WHERE indexrelid='meta_adsets_platform_external_adset_id_not_null_uidx'::regclass)<>'(external_adset_id IS NOT NULL)' THEN RAISE EXCEPTION 'DDL rollback failed'; END IF;END $$;
BEGIN;
${sql}
COMMIT;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM meta_adsets t JOIN index_test_before b ON to_jsonb(t)=b.row) THEN RAISE EXCEPTION 'Legacy row changed';END IF;END $$;
INSERT INTO meta_adsets(id,connection_id,external_adset_id,adset_name,adset_name_key,updated_at) VALUES
 (gen_random_uuid(),'11111111-1111-4111-8111-111111111111','9001','API one','api-one',now()),
 (gen_random_uuid(),'22222222-2222-4222-8222-222222222222','9001','API two','api-two',now());
DO $$ DECLARE blocked integer:=0; BEGIN
 BEGIN INSERT INTO meta_adsets(id,external_adset_id,adset_name,adset_name_key,updated_at) VALUES(gen_random_uuid(),'9001','Legacy duplicate','legacy-duplicate',now()); EXCEPTION WHEN unique_violation THEN blocked:=blocked+1; END;
 BEGIN INSERT INTO meta_adsets(id,connection_id,external_adset_id,adset_name,adset_name_key,updated_at) VALUES(gen_random_uuid(),'11111111-1111-4111-8111-111111111111','9001','Account duplicate','account-duplicate',now()); EXCEPTION WHEN unique_violation THEN blocked:=blocked+1; END;
 IF blocked<>2 THEN RAISE EXCEPTION 'Duplicate protection lost';END IF;
 IF (SELECT count(*) FROM meta_adsets)<>3 THEN RAISE EXCEPTION 'Unexpected row count';END IF;
END $$;
SELECT 'FULL_SCHEMA_AND_ROLLBACK_PASS';`;
  assert(query(seed).includes('FULL_SCHEMA_AND_ROLLBACK_PASS'));
  // A missing account guard must fail before the legacy index is changed.
  const unsafe=spawnSync('docker',['exec','-i',id,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-q'],{input:`SET search_path=meta_ads,pg_catalog;BEGIN;DELETE FROM meta_adsets WHERE connection_id IS NOT NULL;DROP INDEX meta_adsets_platform_external_adset_id_not_null_uidx;CREATE UNIQUE INDEX meta_adsets_platform_external_adset_id_not_null_uidx ON meta_adsets(platform,external_adset_id) WHERE external_adset_id IS NOT NULL;DROP INDEX meta_adsets_account_external_key;${sql}`,encoding:'utf8'});
  assert.notEqual(unsafe.status,0);assert(unsafe.stderr.includes('META_ADSET_INDEX_SCOPE_PRECONDITION_FAILED'));
  assert(query("SET search_path=meta_ads,pg_catalog;SELECT to_regclass('meta_adsets_account_external_key') IS NOT NULL AS intact;").includes('t'));
 }finally{if(id)execFileSync('docker',['stop',id],{stdio:'ignore',timeout:30000});}
});
