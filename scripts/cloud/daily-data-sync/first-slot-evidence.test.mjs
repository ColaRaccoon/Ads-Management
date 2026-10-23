import test from 'node:test';
import assert from 'node:assert/strict';
import {firstSlotEvidenceSql} from './first-slot-evidence.mjs';
import {FIXED_CONNECTIONS,ISOLATED_IDENTITY} from './deployment-evidence.mjs';
const definitions=FIXED_CONNECTIONS.map((row,i)=>({key:`phase08-${row.provider.toLowerCase()}`,connectionId:row.connectionId,provider:row.provider,timeZone:row.timeZone,anchorAt:`2026-10-14T17:0${i}:00.000Z`,windowMinutes:row.provider==='CAFE24'?110:90,targetId:ISOLATED_IDENTITY.targetId}));
test('first-slot plan binds all three original anchors and aggregates complete attempt groups without secret/error/provider payload',()=>{
 const sql=firstSlotEvidenceSql(definitions);assert.match(sql,/^BEGIN READ ONLY;/);assert.match(sql,/ROLLBACK;$/);
 for(const row of definitions)assert(sql.includes(row.anchorAt));
 assert.match(sql,/a.scheduled_for=d.anchor_at/);assert.match(sql,/totalAttempts/);assert.match(sql,/cron\.job_run_details/);
 assert.doesNotMatch(sql,/return_message|SQLERRM|decrypted_secret|ciphertext|provider_request_id|total_amount|http\(|INSERT|UPDATE|DELETE/i);
 assert.throws(()=>firstSlotEvidenceSql(definitions.map((row,i)=>i?row:{...row,connectionId:'00000000-0000-4000-8000-000000000001'})));
 assert.throws(()=>firstSlotEvidenceSql(definitions.map((row,i)=>i?row:{...row,fromDate:'2026-10-01'})));
});
