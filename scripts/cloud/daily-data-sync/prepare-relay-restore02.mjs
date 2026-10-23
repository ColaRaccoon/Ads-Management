// Local public source packaging only. It preserves the active repository source and accepts only reviewed v2/v3 bytes.
import {mkdir,open,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {restoredRelay02Source} from './restore-02.mjs';
export const RELAY_V3_DIRECTORY='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v3';
export const RELAY_V3_SOURCE_SHA='8aa0978251a683d24a2877aec3592dfce71354dcd1e2533c6743aec40a947c1f';
export const RELAY_V3_FILES=Object.freeze({'index.ts':'23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7','relay.mjs':'0bdc81c5ae05c6356436a4f7688ee7576f07d455525a01dfd8a15891592e4b4c'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function prepareRelay02Bundle(directory=RELAY_V3_DIRECTORY){
 const root=resolve(directory);let cursor=dirname(root);for(;;){const info=await lstat(cursor);if(!info.isDirectory()||info.isSymbolicLink())throw Error('RELAY_V3_DIRECTORY_REJECTED');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
 const source=await restoredRelay02Source(),files={'index.ts':source.index,'relay.mjs':source.relay};
 const manifest=Object.entries(files).map(([path,value])=>({path,sha256:hash(value)}));
 if(manifest.some(row=>row.sha256!==RELAY_V3_FILES[row.path])||hash(JSON.stringify(manifest))!==RELAY_V3_SOURCE_SHA)throw Error('RELAY_V3_SOURCE_REJECTED');
 await mkdir(root);
 for(const [name,value]of [...Object.entries(files),['source-manifest.json',JSON.stringify(manifest)]]){const file=await open(join(root,name),'wx',0o600);try{await file.writeFile(value,'utf8');await file.sync();}finally{await file.close();}}
 return {state:'PHASE08_RELAY_02_BUNDLE_PREPARED',directory:root,sourceSha:RELAY_V3_SOURCE_SHA,files:2,secretsIncluded:false,remoteChanges:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await prepareRelay02Bundle()));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_RELAY_02_BUNDLE_REJECTED',remoteChanges:0,rawErrorSuppressed:true}));process.exitCode=1;}}
