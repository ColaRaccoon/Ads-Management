import {october16Definitions as original} from './october16-profile.mjs';
export function isOctober16RepeatOccurrence(c){return c?.key==='phase08-meta'&&c?.connectionId==='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'&&c?.provider==='META'&&c?.timeZone==='Asia/Seoul'&&c?.targetId==='phase08-full-app'&&c?.anchorAt==='2026-10-16T03:30:00.000Z'&&c?.windowMinutes===90;}
export function october16Definitions(phase){
 if(!['previous','test','normal'].includes(phase))throw Error('OCTOBER16_REPEAT_SCOPE');
 if(phase==='previous')return original('test');
 const defs=original('normal');
 return phase==='test'?defs.map(r=>r.provider==='META'?{...r,anchorAt:'2026-10-16T03:30:00.000Z',windowMinutes:90}:r.provider==='CAFE24'?original('test').find(x=>x.provider==='CAFE24'):r):defs;
}
