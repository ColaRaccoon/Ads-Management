// Derive a new consumer closeout scanner without editing any consumed scanner.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir='scripts/cloud/daily-data-sync/';
const base=dir+'phase10-final-secret-scan-v2-20261021.ps1';
const target=dir+'phase10-final-secret-scan-v4-consumer-20261021.ps1';
const source=readFileSync(base,'utf8');
const hash=x=>createHash('sha256').update(x).digest('hex');
if(hash(source)!=='2df3350f47875cb0b6a88e1d0d7d5d81eb0d9cea2ba76a12b518df6c42308b03')throw Error('CONSUMED_V2_SOURCE_DRIFT');
let value=source;
const replace=(before,after)=>{if(!value.includes(before))throw Error('DERIVATION_ANCHOR');value=value.replace(before,()=>after);};
replace("$Label='resume-20261021-secret-scan-v2'","$Label='resume-20261021-consumer-secret-scan-v4'");
replace("'^(incident-|phase10-","'^(incident-|consumers?-|phase10-");
replace("@('.ps1','.mjs','.cjs','.ts','.tsx','.json','.txt')","@('.ps1','.mjs','.cjs','.ts','.tsx','.py','.json','.txt')");
replace("@('continuation-20261021','independent/resume-20261021')","@('continuation-20261021','continuation21','independent/resume-20261021')");
replace("$out=@{knownCurrent21WholeResponseAndNormalizedBase64LiteralsIncluded=","$out=@{consumerReadonlyEvidenceRootsIncluded=$true;consumerSourcePrefixesAndPythonIncluded=$true;derivedFromConsumedV2Sha256='2df3350f47875cb0b6a88e1d0d7d5d81eb0d9cea2ba76a12b518df6c42308b03';knownCurrent21WholeResponseAndNormalizedBase64LiteralsIncluded=");
if(process.argv.includes('--verify-only')){
 const exact=readFileSync(target,'utf8')===value;
 console.log(JSON.stringify({kind:'CONSUMER_V4_SCAN_DERIVATION',exact,sourceSha256:hash(value),protectedReads:0,remoteRequests:0}));
 if(!exact)process.exitCode=1;
}else{
 writeFileSync(target,value,{flag:'wx'});
 console.log(JSON.stringify({kind:'CONSUMER_V4_SCAN_GENERATED',path:target,sha256:hash(value),protectedReads:0,remoteRequests:0}));
}
