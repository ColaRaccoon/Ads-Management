import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startCredentialBridge} from './phase10-ui-credential-bridge.mjs';
const credentials={origin:'https://phase08-daily-data-sync-production.up.railway.app',projectRef:'ehnfrrmbkvlsbpvqcvkr',schema:'phase08_meta_ads',email:'phase08-eval-f0000000-0000-4000-8000-000000000001@example.invalid',password:'synthetic-credential-'+('x'.repeat(23))};
test('only exact isolated account identity is accepted',async()=>{
 await assert.rejects(startCredentialBridge({...credentials,origin:'https://example.com'}),/IDENTITY/);
 await assert.rejects(startCredentialBridge({...credentials,projectRef:'iygjmosbelbosfxidqxv'}),/IDENTITY/);
 await assert.rejects(startCredentialBridge({...credentials,email:'business@example.com'}),/IDENTITY/);
});
test('one top-level loopback navigation; no cross-origin read or repeat',async()=>{
 const bridge=await startCredentialBridge(credentials);
 try {
  const blocked=await fetch(bridge.url);assert.equal(blocked.status,404);
  const crossOrigin=await fetch(bridge.url,{headers:{Origin:'https://example.com','sec-fetch-site':'none','sec-fetch-dest':'document'}});assert.equal(crossOrigin.status,404);
  // Native http keeps the browser navigation headers without fetch overriding them.
  const {get}=await import('node:http');
  const actual=await new Promise((resolve,reject)=>get(bridge.url,{headers:{'sec-fetch-site':'none','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}},res=>{
   let html='';res.on('data',part=>html+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,html}));
  }).on('error',reject));
  assert.equal(actual.status,200);assert.equal(actual.headers['cache-control'],'no-store');
  assert.match(actual.headers['content-security-policy'],/default-src 'none'/);
  assert.equal((actual.html.match(/type="password"/g)||[]).length,2);
  assert.equal(actual.html.includes('<script'),false);assert.equal(actual.html.includes('<form'),false);
  await assert.rejects(fetch(bridge.url));
 } finally {bridge.close();}
});
