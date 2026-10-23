// Archived encrypted evidence only. No database, provider, refresh or runner.
import {createDecipheriv,createHash} from 'node:crypto';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter.ts';
import {withCafe24Diagnostic,isCafe24FailureDiagnosticCode} from '../../../apps/api/src/daily-sync/cafe24-failure-diagnostic.ts';
import {verifiedCafe24V1Statuses,cafe24PaymentMethodCsvMap,requiresCafe24RawAllItemsEvidence,assertCafe24RawAllItemsV1Evidence} from '../../../apps/api/src/daily-sync/sync-contract.ts';
const fail=()=>{throw Error('ARCHIVED_OFFLINE_REJECTED');};
let input,raw='',plain,key;const prior={...process.env};
try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>4*1024*1024)fail();}
 input=JSON.parse(raw);raw='';
 const cp=input.checkpoints;if(!Array.isArray(cp)||cp.length!==1)fail();const row=cp[0];
 if(row.runId!=='a4f7bcea-bfa8-4699-b3f0-34e118889710'||row.connectionId!=='0c35defe-45fc-4a54-bc79-704df7bca5b1'||row.unitKey!=='2026-10-17'||row.revision!==6)fail();
 key=Buffer.from(input.checkpointKey,'base64');if(key.length!==32||key.toString('base64')!==input.checkpointKey)fail();
 const cipher=Buffer.from(row.ciphertextB64,'base64');if(cipher.length!==126852)fail();
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(row.ivB64,'base64'));decipher.setAAD(Buffer.from(`${row.connectionId}:${row.runId}:${row.unitKey}`));decipher.setAuthTag(Buffer.from(row.authTagB64,'base64'));
 plain=Buffer.concat([decipher.update(cipher),decipher.final()]);const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
 if(state.version!==1||state.stage!=='ITEMS_FIRST'||state.count!==269||state.first.length!==269||state.items.length!==60||state.cursor!==60||state.second.length!==0||state.verifiedItems!==0)fail();
 for(const name of ['DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES','DAILY_SYNC_CAFE24_VERIFIED_NORMAL_STATUSES','DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP','DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT']){delete process.env[name];if(input.evidence[name]!==undefined)process.env[name]=input.evidence[name];}
 const diagnostic=(order,items)=>{try{
  const lines=normalizeCafe24Order(order,items,{verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},paymentMethodCsvLabels:withCafe24Diagnostic('CAFE24_EVIDENCE_PAYMENT_MAP',()=>cafe24PaymentMethodCsvMap())});
  const statuses=withCafe24Diagnostic('CAFE24_EVIDENCE_STATUS_SET',()=>verifiedCafe24V1Statuses());
  if(lines.some(l=>[l.orderStatus,l.lineStatus].some(requiresCafe24RawAllItemsEvidence)))withCafe24Diagnostic('CAFE24_EVIDENCE_RAW_ALL_ITEMS',()=>assertCafe24RawAllItemsV1Evidence(state.day));
  if(lines.some(l=>l.providerUpdatedAt&&l.providerUpdatedAt>new Date(state.startedAt)))return 'CAFE24_PROVIDER_TIME_FUTURE';
  if(lines.some(l=>l.orderStatus&&!statuses.has(l.orderStatus)||!statuses.has(l.lineStatus??'')))return 'CAFE24_STATUS_APPROVAL_MISMATCH';
  return 'PASS';
 }catch(e){return isCafe24FailureDiagnosticCode(e?.diagnosticCode)?e.diagnosticCode:'UNCLASSIFIED_SAFE_FAILURE';}};
 const metadata={},items={};const increment=(out,code)=>out[code]=(out[code]??0)+1;
 for(const order of state.first)increment(metadata,diagnostic(order,[{order_item_code:'SYNTHETIC',product_no:'0',product_name:'Synthetic',option_value:'Synthetic',quantity:'0',product_price:'0',order_status:'N00'}]));
 for(let i=0;i<state.items.length;i++)increment(items,diagnostic(state.first[i],state.items[i]));
 process.stdout.write(JSON.stringify({kind:'PHASE10_CAFE_ARCHIVED_OFFLINE_REPLAY',observedAt:new Date().toISOString(),providerRequests:0,refreshes:0,databaseConnections:0,databaseWrites:0,rawValuesReturned:0,checkpointResumed:false,checkpointExpired:true,originalFailureReproduced:false,failedResponseRetained:false,storedOrders:state.first.length,storedItemOrders:state.items.length,nextOrderItemResponsePresent:state.items[state.cursor]!==undefined,metadataPredicates:metadata,itemPredicates:items,encryptedSha256:createHash('sha256').update(cipher).digest('hex'),scope:'ORIGINAL_CONFIG_AND_STORED_PROJECTIONS_ONLY'}));
}catch{process.stdout.write(JSON.stringify({kind:'PHASE10_CAFE_ARCHIVED_OFFLINE_REPLAY_FAILED',rawErrorSuppressed:true,providerRequests:0,databaseConnections:0,databaseWrites:0}));process.exitCode=1;}
finally{raw='';input=undefined;plain?.fill(0);key?.fill(0);for(const name of Object.keys(process.env))if(!(name in prior))delete process.env[name];Object.assign(process.env,prior);}
