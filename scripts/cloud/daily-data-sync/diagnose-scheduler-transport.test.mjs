import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulerTransportDiagnosticSql} from './diagnose-scheduler-transport.mjs';
test('local-preparation diagnostics retain original six stages and no HTTP/provider/table mutation or error text',()=>{
 const sql=schedulerTransportDiagnosticSql();
 assert.match(sql,/^BEGIN READ ONLY;/);assert.match(sql,/ROLLBACK;$/);
 for(const step of ['VAULT_LOOKUP','TIMEOUT_MS','CONNECTTIMEOUT_MS','FOLLOWLOCATION','HEADER_BUILD','RESET_OPTIONS'])assert(sql.includes(`'${step}'`));
 assert.match(sql,/GET STACKED DIAGNOSTICS safe_state=RETURNED_SQLSTATE/);
 assert.doesNotMatch(sql,/SQLERRM|MESSAGE_TEXT|PG_EXCEPTION|extensions\.http\s*\(|INSERT INTO|UPDATE\s+daily|CREATE\s+FUNCTION|RAISE NOTICE/i);
 assert.match(sql,/WHERE name='daily_data_sync_08_machine'/);assert.match(sql,/secret:=NULL/);
});
