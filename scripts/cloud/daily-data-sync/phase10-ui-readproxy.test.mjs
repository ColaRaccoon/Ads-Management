import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
test('read proxy refuses mutating and nonallowlisted requests without remote calls',async()=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('./phase10-ui-readproxy.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
 child.stdin.end(JSON.stringify({origin:'https://phase08-daily-data-sync-production.up.railway.app',projectRef:'ehnfrrmbkvlsbpvqcvkr',schema:'phase08_meta_ads',cookie:'__Host-phase08-meta_access='+('synthetic'.repeat(30))}));
 let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);
 try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('not-ready')),5000);child.stdout.on('data',()=>{if(stdout.includes('\n')){clearTimeout(timer);resolve();}});child.once('error',reject);});
  const ready=JSON.parse(stdout.split('\n')[0]);assert.equal(ready.kind,'PHASE10_UI_READ_PROXY_READY');
  const base='http://127.0.0.1:'+ready.port;
  assert.equal((await fetch(base+'/api/auth/login')).status,403);
  assert.equal((await fetch(base+'/api/uploads/meta-ad-daily-csv',{method:'POST',body:'synthetic'})).status,403);
  assert.equal((await fetch(base+'/api/storefront/connections/test/enabled',{method:'PATCH',body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/auth/me?secret=forbidden')).status,403);
  assert.equal((await fetch(base+'/__phase10/close',{method:'POST',headers:{'x-phase10-local':'test-only'}})).status,200);
  const [code]=await once(child,'exit');assert.equal(code,0);
  const closed=JSON.parse(stdout.trim().split('\n').at(-1));assert.equal(closed.kind,'PHASE10_UI_READ_PROXY_CLOSED');assert.deepEqual(closed.calls,[]);assert.equal(closed.remoteMutations,0);
 }finally{if(child.exitCode===null)child.kill();}
});
