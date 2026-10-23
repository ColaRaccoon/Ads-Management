import {createHash} from 'node:crypto';
import {lstat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const sha=x=>createHash('sha256').update(x).digest('hex');
export const CLASSES=['SUPABASE','CAFE','GOOGLE','META'];
export const CAPS=Object.freeze({files:25000,totalBytes:1073741824,fileBytes:134217728,seconds:600,b64Characters:2097152});
export const ROOTS=Object.freeze([
 {label:'CODEX_CONFIG',path:'C:/Users/seong/.codex/config.toml'},
 {label:'CURSOR_CONFIG',path:'C:/Users/seong/.cursor/mcp.json'},
 {label:'CLAUDE_CONFIG',path:'C:/Users/seong/.claude.json'},
 {label:'VSCODE_USER_CONFIG',path:'C:/Users/seong/AppData/Roaming/Code/User/settings.json'},
 {label:'META_LOCAL_SOURCE',path:'C:/Users/seong/AppData/Local/MetaAdsMetaIsolated'},
 {label:'WORKSPACE',path:'C:/Users/seong/Desktop/workspace/Meta-Ads-Performance'}
]);
const REF={SUPABASE:['SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'],CAFE:['DAILY_SYNC_CAFE24_CLIENT_SECRET'],GOOGLE:['PHASE08_GOOGLE_ADC_JSON_B64','source_credentials','application_default_credentials'],META:['PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','MetaAdsMetaIsolated','mcp-access-token.dpapi','inspector-token.dpapi']};
const excluded=new Set(['node_modules','.git']);
function validate(input){if(!input||!input.material||Object.keys(input.material).sort().join()!==[...CLASSES].sort().join())throw Error('INPUT');for(const k of CLASSES){const v=input.material[k];if(!v||!Array.isArray(v.literals)||!Array.isArray(v.encoded)||v.literals.length<1||v.literals.length>8||v.encoded.length>4||[...v.literals,...v.encoded].some(x=>typeof x!=='string'||x.length<8||x.length>524288))throw Error('INPUT');}}
export function makeMatcher(material){
 const found=Object.fromEntries(CLASSES.map(k=>[k,new Set()]));let decodedJsonCandidates=0;
 const match=(text,decoded=false)=>{for(const k of CLASSES){if(material[k].literals.some(n=>text.includes(n)))found[k].add(decoded?'DECODED_JSON_LITERAL':'RAW_LITERAL');if(!decoded&&material[k].encoded.some(n=>text.includes(n)))found[k].add('KNOWN_ENCODED_CAPSULE');if(!decoded&&REF[k].some(n=>text.includes(n)))found[k].add('SOURCE_REFERENCE');}};
 let pending='',tooLong=false;
 const candidate=()=>{if(!tooLong&&pending.length>=32&&pending.length<=CAPS.b64Characters&&pending.length%4===0){try{const b=Buffer.from(pending,'base64');if(b.toString('base64')===pending){const t=new TextDecoder('utf-8',{fatal:true}).decode(b);if(/^\s*[\[{]/.test(t)){JSON.parse(t);decodedJsonCandidates++;match(t,true);}}}catch{}}pending='';tooLong=false;};
 return {maxOverlap:Math.max(256,...CLASSES.flatMap(k=>[...material[k].literals,...material[k].encoded].map(n=>n.length)))+4,
  text:match,b64(text){for(const ch of text){if(/[A-Za-z0-9+/=]/.test(ch)){if(!tooLong){pending+=ch;if(pending.length>CAPS.b64Characters){pending='';tooLong=true;}}}else candidate();}},
  end(){candidate();return {matches:CLASSES.flatMap(k=>found[k].size?[{class:k,forms:[...found[k]].sort()}]:[]),decodedJsonCandidates};}};
}
export function fileClass(p){const leaf=path.basename(p).toLowerCase();if(leaf==='.env'||leaf.startsWith('.env.')||/\.(?:toml|ya?ml|env)$/.test(leaf)||/(?:config|settings|credentials|mcp)\.json$/.test(leaf))return 'CONFIG';if(/\.(?:js|cjs|mjs|ts|tsx|jsx|ps1|py|sh|sql|md)$/.test(leaf))return 'SOURCE';return 'ARTIFACT';}
export async function scanConsumers(input,roots=ROOTS,limits=CAPS){
 validate(input);const start=Date.now();const records=[],coverage=[],seen=new Set();let files=0,bytes=0,skippedBinary=0,skippedLarge=0,reparse=0,inaccessible=0,excludedDirectories=0,capReached=false,decodedJsonCandidates=0;
 const visit=async(p,label)=>{
  if(capReached)return;if(files>=limits.files||bytes>=limits.totalBytes||Date.now()-start>=limits.seconds*1000){capReached=true;return;}
  let info;try{info=await lstat(p);}catch{inaccessible++;return;}if(info.isSymbolicLink()){reparse++;return;}if(info.isDirectory()){if(excluded.has(path.basename(p))){excludedDirectories++;return;}let entries;try{entries=await readdir(p);}catch{inaccessible++;return;}for(const e of entries.sort())await visit(path.join(p,e),label);return;}if(!info.isFile())return;
  const key=path.resolve(p).toLowerCase();if(seen.has(key))return;seen.add(key);if(info.size>limits.fileBytes){skippedLarge++;coverage.push({pathSha256:sha(key),reason:'FILE_SIZE_CAP',size:info.size});return;}if(/\.(?:dpapi|exe|dll|node|wasm|png|jpe?g|gif|webp|ico|pdf|zip|gz|br|woff2?|ttf|mp4|mp3|pack|idx)$/i.test(p)){skippedBinary++;return;}
  const matcher=makeMatcher(input.material),digest=createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true});let overlap='',size=0,binary=false,complete=true;
  try{for await(const b of createReadStream(p,{highWaterMark:65536})){bytes+=b.length;size+=b.length;digest.update(b);if(bytes>limits.totalBytes||Date.now()-start>=limits.seconds*1000){capReached=true;complete=false;break;}if(b.includes(0)){binary=true;break;}const t=decoder.decode(b,{stream:true});matcher.text(overlap+t);matcher.b64(t);overlap=(overlap+t).slice(-matcher.maxOverlap);}if(!binary&&complete){const tail=decoder.decode();matcher.text(overlap+tail);matcher.b64(tail);}}
  catch{complete=false;inaccessible++;}
  if(binary){skippedBinary++;return;}if(!complete){coverage.push({pathSha256:sha(key),reason:capReached?'OPERATION_CAP':'UNREADABLE_OR_NON_UTF8'});return;}files++;const found=matcher.end();decodedJsonCandidates+=found.decodedJsonCandidates;if(found.matches.length)records.push({root:label,pathSha256:sha(key),contentSha256:digest.digest('hex'),bytes:size,fileClass:fileClass(p),matches:found.matches});
 };
 for(const r of roots){let exists=true;try{await lstat(r.path);}catch{exists=false;}coverage.push({root:r.label,present:exists});if(exists){let parent=path.resolve(r.path),safe=true;while(true){try{if((await lstat(parent)).isSymbolicLink()){safe=false;reparse++;coverage.push({root:r.label,reason:'ROOT_PARENT_REPARSE'});break;}}catch{safe=false;inaccessible++;coverage.push({root:r.label,reason:'ROOT_PARENT_UNREADABLE'});break;}const next=path.dirname(parent);if(next===parent)break;parent=next;}if(safe)await visit(r.path,r.label);}}
 const result={kind:'ALL_SHARED_LOCAL_CONSUMER_SCAN',observedAt:new Date().toISOString(),files,bytes,decodedJsonCandidates,records,coverage,skipped:{binary:skippedBinary,large:skippedLarge,reparse,inaccessible,excludedDirectories},capReached,excludedDirectoryNames:[...excluded],limits,allConsumersEnumerated:false,scope:'FIXED_WORKSPACE_INCLUDING_UNTRACKED_ENV_AND_FIVE_FIXED_LOCAL_CONFIG_SOURCE_TARGETS_NO_EXTERNAL_SERVICE_ENUMERATION',protectedFilesModified:0,remoteRequests:0,remoteWrites:0,rawValuesReturned:0};
 const wire=JSON.stringify(result);if(wire.length>4194304)throw Error('OUTPUT_CAP');for(const k of CLASSES)for(const n of [...input.material[k].literals,...input.material[k].encoded])if(wire.includes(n))throw Error('OUTPUT_LITERAL');return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let wire='';try{if(process.env.CONSUMERS_LOCALREADONLY_PARENT!=='20261021-ROOT')throw Error('PARENT');for await(const b of process.stdin){wire+=b.toString('utf8');if(Buffer.byteLength(wire)>4194304)throw Error('INPUT_CAP');}process.stdout.write(JSON.stringify(await scanConsumers(JSON.parse(wire))));}catch{process.stdout.write(JSON.stringify({kind:'ALL_SHARED_LOCAL_CONSUMER_SCAN',status:'SAFE_FAILURE',rawValuesReturned:0,remoteWrites:0}));process.exitCode=1;}finally{wire='';}}
