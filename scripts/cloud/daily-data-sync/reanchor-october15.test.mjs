import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {relayTransportPatchSql} from './relay-transport-patch.mjs';
import {reanchorOctober15Sql} from './reanchor-october15.mjs';
test('one shot test reanchor derives only reviewed existing relay call and preserves old attempts with real clock cutoff',async()=>{
 const base=await relayTransportPatchSql({expectedProsrcMd5:'a'.repeat(32),reviewedRelaySourceSha256:'b'.repeat(64)});
 const start=base.indexOf('CREATE OR REPLACE FUNCTION daily_data_sync_ops.call('),end=base.indexOf('\nREVOKE ALL ON FUNCTION',start),fn=base.slice(start,end).trim();
 const prosrc=fn.match(/AS \$\$([\s\S]*)\$\$;/)[1];const md5=createHash('md5').update(prosrc).digest('hex');
 const sql=reanchorOctober15Sql({currentCallDefinition:fn,expectedProsrcMd5:md5});
 const pgDefinition=fn.replaceAll('$$','$function$').replace(/;$/, '');
 const pgSql=reanchorOctober15Sql({currentCallDefinition:pgDefinition,expectedProsrcMd5:md5});
 assert.match(pgSql,/\$function\$;\s+UPDATE daily_data_sync_ops/);
 assert.match(sql,/00:59:30Z/);assert.match(sql,/clock_timestamp\(\)>=timestamptz '2026-10-15T01:00:00Z'/);
 assert.match(sql,/WHEN query_canceled THEN/);assert.match(sql,/2026-10-15T03:00:00Z/);
 assert.equal((sql.match(/SELECT cron\.alter_job\(jobid,schedule:=/g)||[]).length,149);assert.equal((sql.match(/UPDATE daily_data_sync_ops.schedules SET anchor_at=/g)||[]).length,3);
 assert.doesNotMatch(sql,/DELETE FROM|TRUNCATE|INSERT INTO vault|UPDATE daily_data_sync_ops.attempts|UPDATE phase08_meta_ads|UPDATE cron\.job/);
 assert.throws(()=>reanchorOctober15Sql({currentCallDefinition:fn,expectedProsrcMd5:'0'.repeat(32)}));
});
