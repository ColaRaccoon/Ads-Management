// Local public source packaging only. No credential, deployment or remote call.
import {mkdir,open,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {acceleratedRelaySource} from './accelerated-october15-relay.mjs';
export const RELAY_V4_DIRECTORY='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v4';
export const RELAY_V4_SOURCE_SHA='4e51a0e0bbd200876cd2922f422cc1f3aaed0634d882565f6677ef97a9e49a92';
export const RELAY_V4_FILES=Object.freeze({'index.ts':'23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7','relay.mjs':'e7c2975256fbceb766c06747d941b289b3bde78bd17aca7bece2146ae2a831d5'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function prepareAcceleratedRelayBundle(directory=RELAY_V4_DIRECTORY){
 const root=resolve(directory);let cursor=dirname(root);for(;;){const info=await lstat(cursor);if(!info.isDirectory()||info.isSymbolicLink())throw Error('RELAY_V4_DIRECTORY_REJECTED');const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}
 const source=await acceleratedRelaySource(),files={'index.ts':source.index,'relay.mjs':source.relay};
 const manifest=Object.entries(files).map(([path,value])=>({path,sha256:hash(value)}));
 if(manifest.some(row=>row.sha256!==RELAY_V4_FILES[row.path])||hash(JSON.stringify(manifest))!==RELAY_V4_SOURCE_SHA)throw Error('RELAY_V4_SOURCE_REJECTED');
 await mkdir(root);
 for(const [name,value]of [...Object.entries(files),['source-manifest.json',JSON.stringify(manifest)]]){const file=await open(join(root,name),'wx',0o600);try{await file.writeFile(value,'utf8');await file.sync();}finally{await file.close();}}
 return {state:'PHASE08_RELAY_ACCELERATED_BUNDLE_PREPARED',directory:root,sourceSha:RELAY_V4_SOURCE_SHA,files:2,secretsIncluded:false,remoteChanges:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await prepareAcceleratedRelayBundle()));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_RELAY_ACCELERATED_BUNDLE_REJECTED',remoteChanges:0,rawErrorSuppressed:true}));process.exitCode=1;}}
