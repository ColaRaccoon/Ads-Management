// Create new rev9->10 tools. All previously consumed tools remain untouched.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const S='scripts/cloud/daily-data-sync/',E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-recovery-20261021-v1';
const sha=v=>createHash('sha256').update(v).digest('hex');
const old='phase10-cafe-pair-recovery-20261020',next='phase10-cafe-pair-renew-20261021';
const names=[old+'.mjs','phase10-cafe-pair-recovery-child-20261020.mjs',old+'.ps1',old+'.test.mjs',old+'.test.ps1'];
const expected=['940a4776c7125050995151a4f90cdd400d53cec7307a3e99eabd358be600996e','6f3c1a7c32966ca3938fcb81b62f4e430a2fc797168f109028e6b9836e4c35ac','98b35736c109e9b35f10ab64788c5b3b591171f749ddcffefc43f488fa69d430'];
const before=names.map((name,i)=>{const bytes=readFileSync(S+name);if(i<3)assert.equal(sha(bytes),expected[i]);return{name,sha256:sha(bytes),text:bytes.toString('utf8')};});
function replace(s,a,b){assert(s.includes(a),'RENEW_SITE_MISSING');return s.replaceAll(a,b);}
function common(s){return s.replaceAll('phase10-cafe-pair-recovery-child-20261020','phase10-cafe-pair-renew-child-20261021').replaceAll(old,next).replaceAll('20261020-cafe08-read-recovery-a','20261021-cafe08-epoch-live-a').replaceAll('cafe-recovery-20261020-v1','cafe-recovery-20261021-v1').replaceAll("'20261020-ROOT'","'20261021-ROOT'");}
let module=common(before[0].text);
for(const [a,b]of [['r.revision!==8','r.revision!==9'],['expectedBeforeRevision:8','expectedBeforeRevision:9'],['expectedAfterRevision:9','expectedAfterRevision:10'],['revision=9','revision=10'],['revision=8','revision=9'],['beforeRevision:8,afterRevision:9','beforeRevision:9,afterRevision:10'],['expectedRevision:9','expectedRevision:10'],['actual.revision!==9','actual.revision!==10'],['revision:9,exactNewPairAuthenticatedDecryption','revision:10,exactNewPairAuthenticatedDecryption']])module=replace(module,a,b);
module=replace(module,'refresh=open(r,key);access=open(a,key);',`refresh=open(r,key);access=open(a,key);
  const prior=input.previousProtectedResponse;
  if(prior?.operationKey!=='20261020-cafe08-read-recovery-a'||prior.httpStatus!==200||prior.complete!==true||prior.providerPosts!==1||prior.eligibleSecretRollback!==false)fail();
  const packet=canonical64(prior.bodyB64,1,32768);let previous;
  try{if(packet.length!==prior.bodyBytes)fail();previous=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(packet));}finally{packet.fill(0);}
  if(previous.mall_id!=='didadi0729'||String(previous.shop_no)!=='1'||previous.client_id!==input.clientId||previous.token_type!=='Bearer'||JSON.stringify(previous.scopes)!==JSON.stringify(['mall.read_order'])||typeof previous.user_id!=='string'||! /^[\\x21-\\x7e]{1,128}$/.test(previous.user_id)||previous.access_token!==access.toString('ascii')||previous.refresh_token!==refresh.toString('ascii'))fail();
  const previousProviderUserId=previous.user_id;previous=undefined;`);
module=replace(module,'snapshot:s,credentialKeyV2:', 'snapshot:s,previousProviderUserId,credentialKeyV2:');
module=replace(module,"typeof token.user_id!=='string'||!/^[\\x21-\\x7e]{1,128}$/.test(token.user_id)","typeof token.user_id!=='string'||!/^[\\x21-\\x7e]{1,128}$/.test(token.user_id)||token.user_id!==plan.previousProviderUserId");
module=replace(module,'previousProviderUserIdAvailable:false,previousProviderUserIdCompared:false','previousProviderUserIdAvailable:true,previousProviderUserIdCompared:true');
let control=common(before[2].text);
control=replace(control,"cafe-resume-20261020-v4/callback-inspect.json","cafe-recovery-20261021-v1/callback-inspect.json");
control=replace(control,"$stage='OFFLINE_PLAN';$plan=",`$stage='CURRENT_REV9_PROVENANCE';$priorResponse=Read-IncidentPrivate 'cafe08-recovery-response-20261020-cafe08-read-recovery-a'
   $stage='OFFLINE_PLAN';$plan=`);
control=replace(control,'snapshot=$cipher;credentialKeyV2=', 'snapshot=$cipher;previousProtectedResponse=$priorResponse;credentialKeyV2=');
control=replace(control,'$live=$null;$gate=$null;$plan=$null;$callback=$null;$baseline=$null;$cipher=$null;$protectedResponse=$null;$prepared=$null;$reply=$null}', '$live=$null;$gate=$null;$plan=$null;$callback=$null;$baseline=$null;$cipher=$null;$priorResponse=$null;$protectedResponse=$null;$prepared=$null;$reply=$null}');
let tests=common(before[3].text).replaceAll('revision:8','revision:9').replaceAll('rev8','rev9').replaceAll('expectedAfterRevision,9','expectedAfterRevision,10').replaceAll('/revision=8/','/revision=9/');
tests=replace(tests,'return{operationKey,credentialKeyV2:',`return{operationKey,previousProtectedResponse:{operationKey:'20261020-cafe08-read-recovery-a',httpStatus:200,complete:true,providerPosts:1,eligibleSecretRollback:false,...(()=>{const raw=Buffer.from(JSON.stringify({mall_id:'didadi0729',shop_no:1,client_id:'SyntheticClient001',token_type:'Bearer',scopes:['mall.read_order'],user_id:'SYNTHETIC_OWNER',access_token:'SYNTHETIC_PRIVATE_OLD_ACCESS_12345',refresh_token:oldRefresh}));return{bodyB64:raw.toString('base64'),bodyBytes:raw.length};})()},credentialKeyV2:`);
tests+=`\ntest('previous verified provider principal cannot change',()=>{const value=token();value.user_id='OTHER_SYNTHETIC_OWNER';assert.throws(()=>finalizeCafe08Recovery(prepareCafe08Recovery(fixture(),now),packet(value),tables,now));});\nfor(const mutate of [x=>delete x.previousProtectedResponse,x=>x.previousProtectedResponse.bodyB64=Buffer.from('{}').toString('base64'),x=>x.previousProtectedResponse.operationKey='wrong'])test('rev9 provenance mismatch blocks before POST',()=>{const value=fixture();mutate(value);assert.throws(()=>prepareCafe08Recovery(value,now));});\n`;
let psTests=common(before[4].text);
psTests=replace(psTests,"if($Name -ceq 'compromised-baseline')", "if($Name -ceq 'cafe08-recovery-response-20261020-cafe08-read-recovery-a'){return @{bodyB64='SYNTHETIC_PROTECTED_BODY_ONLY'}};if($Name -ceq 'compromised-baseline')");
const files=[[next+'.mjs',module],['phase10-cafe-pair-renew-child-20261021.mjs',common(before[1].text)],[next+'.ps1',control],[next+'.test.mjs',tests],[next+'.test.ps1',psTests]];
for(const [name]of files)assert(!existsSync(S+name));assert(!existsSync(E));mkdirSync(E,{recursive:false});
for(const [name,text]of files)writeFileSync(S+name,text,{flag:'wx'});
const proof={kind:'CAFE08_NEW_REV9_TO10_RENEW_TOOLS',at:new Date().toISOString(),sourcePreserved:before.map(({name,sha256})=>({name,sha256})),files:files.map(([name,text])=>({name,sha256:sha(text)})),expectedRevisionBefore:9,expectedRevisionAfter:10,previousVerifiedProviderUserIdCompared:true,providerPosts:0,remoteMutations:0};
writeFileSync(E+'/tools-draft.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({kind:proof.kind,files:files.length,providerPosts:0,remoteMutations:0}));
