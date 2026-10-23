// User-approved isolated real-clock occurrences; never an arbitrary clock override.
import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
export const EXTRA_TEST_OCCURRENCES=Object.freeze([
 {key:'phase08-meta',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',provider:'META',anchorAt:'2026-10-15T06:00:00.000Z',windowMinutes:35},
 {key:'phase08-cafe24',connectionId:'0c35defe-45fc-4a54-bc79-704df7bca5b1',provider:'CAFE24',anchorAt:'2026-10-15T06:40:00.000Z',windowMinutes:110},
 {key:'phase08-meta',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',provider:'META',anchorAt:'2026-10-15T07:00:00.000Z',windowMinutes:90}
].map(Object.freeze));
export function isExtraTestOccurrence(c){return EXTRA_TEST_OCCURRENCES.some(row=>Object.entries(row).every(([key,value])=>c?.[key]===value))&&c?.timeZone==='Asia/Seoul'&&c?.targetId==='phase08-full-app';}
export function acceleratedDefinitions(phase){
 if(!['outage','collection','normal'].includes(phase))throw Error('ACCELERATED_PROFILE_REJECTED');
 return FIXED_CONNECTIONS.map((source,index)=>{
  const normal={key:'phase08-'+source.provider.toLowerCase(),connectionId:source.connectionId,provider:source.provider,timeZone:'Asia/Seoul',anchorAt:`2026-10-14T17:0${index}:00.000Z`,windowMinutes:source.provider==='CAFE24'?110:90,targetId:'phase08-full-app'};
  if(phase==='normal'||source.provider==='GOOGLE')return normal;
  return {...normal,...EXTRA_TEST_OCCURRENCES.find(row=>row.provider===source.provider&&(source.provider==='CAFE24'||row.windowMinutes===(phase==='outage'?35:90)))};
 });
}
