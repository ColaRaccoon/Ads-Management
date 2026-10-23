import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {EXTRA_TEST_OCCURRENCES} from './accelerated-october15-profile.mjs';
// Derive a separate deployable artifact; the reviewed normal v3 stays immutable.
export async function acceleratedRelaySource(){
 const relay=await readFile(new URL('../../../supabase/functions/phase08-scheduled-relay/relay.mjs',import.meta.url),'utf8');
 const index=await readFile(new URL('../../../supabase/functions/phase08-scheduled-relay/index.ts',import.meta.url),'utf8');
 if(createHash('sha256').update(relay).digest('hex')!=='0bdc81c5ae05c6356436a4f7688ee7576f07d455525a01dfd8a15891592e4b4c')throw Error('ACCELERATED_RELAY_REJECTED');
 const added=EXTRA_TEST_OCCURRENCES.map(r=>({key:r.key,anchor:r.anchorAt,days:r.provider==='CAFE24'?1:7,window:r.windowMinutes,oneShot:true}));
 const before="const candidates=readOnly?[...SCHEDULES,...PREVIOUS_TEST_SCHEDULES]:SCHEDULES;";
 const after=`const extra=${JSON.stringify(added)};\n   const candidates=readOnly?[...SCHEDULES,...PREVIOUS_TEST_SCHEDULES,...extra]:[...SCHEDULES,...extra];`;
 const guard='(PREVIOUS_TEST_SCHEDULES.includes(row)?body.scheduledFor===row.anchor:';
 if(relay.split(before).length!==2||relay.split(guard).length!==2)throw Error('ACCELERATED_RELAY_REJECTED');
 return {index,relay:relay.replace(before,()=>after).replace(guard,'(row.oneShot||PREVIOUS_TEST_SCHEDULES.includes(row)?body.scheduledFor===row.anchor:'),remoteChanges:0};
}
