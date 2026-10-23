import {FIXED_CONNECTIONS} from './deployment-evidence.mjs';
export const OCTOBER16_OCCURRENCES=Object.freeze([
 {key:'phase08-cafe24',connectionId:'0c35defe-45fc-4a54-bc79-704df7bca5b1',provider:'CAFE24',anchorAt:'2026-10-16T01:15:00.000Z',windowMinutes:110},
 {key:'phase08-meta',connectionId:'1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6',provider:'META',anchorAt:'2026-10-16T01:20:00.000Z',windowMinutes:90}
].map(Object.freeze));
export function isOctober16Occurrence(c){return c?.timeZone==='Asia/Seoul'&&c?.targetId==='phase08-full-app'&&OCTOBER16_OCCURRENCES.some(r=>Object.entries(r).every(([k,v])=>c?.[k]===v));}
export function october16Definitions(phase){
 if(!['previous','test','normal'].includes(phase))throw Error('OCTOBER16_PROFILE_REJECTED');
 return FIXED_CONNECTIONS.map((s,i)=>{const r={key:'phase08-'+s.provider.toLowerCase(),connectionId:s.connectionId,provider:s.provider,timeZone:'Asia/Seoul',anchorAt:`2026-10-14T17:0${i}:00.000Z`,windowMinutes:s.provider==='CAFE24'?110:90,targetId:'phase08-full-app'};
 if(phase==='previous'&&s.provider!=='GOOGLE')return {...r,anchorAt:s.provider==='CAFE24'?'2026-10-15T06:40:00.000Z':'2026-10-15T07:00:00.000Z'};
 if(phase==='test'&&s.provider!=='GOOGLE')return {...r,...OCTOBER16_OCCURRENCES.find(x=>x.provider===s.provider)};
 if(phase==='normal'&&s.provider==='META')return {...r,anchorAt:'2026-10-15T17:02:00.000Z'};
 return r;});
}
