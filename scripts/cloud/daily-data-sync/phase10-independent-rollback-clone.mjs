// Copy only existing synthetic harnesses; change their dedicated loopback targets.
// Never changes the developer's frozen files or restores a deleted test.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const label=process.argv[2];assert.match(label??'',/^20261020-[a-z0-9-]{3,35}$/);
const dir='scripts/cloud/daily-data-sync',prefix=`phase10-independent-generated-${label}`;
const evidence=`C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/rollback-${label}`;
assert(!existsSync(evidence),'fresh cluster label required');
const main=`${prefix}-rollback.mjs`,cafe=`${prefix}-before-image.test.ts`,multi=`${prefix}-multi-source.test.ts`;
const names=[['phase10-api-rollback-20261020.mjs',main],['phase10-api-before-image-20261020-postgres.test.ts',cafe],['phase10-multisource-rollback-20261020.test.ts',multi]];
const copies=[];const sha=b=>createHash('sha256').update(b).digest('hex');
for(const [source,target] of names){
 const original=readFileSync(`${dir}/${source}`);let text=original.toString('utf8');const replacements=[];
 const substitute=(from,to,required=true)=>{const count=text.split(from).length-1;if(required)assert(count>0,`target literal missing ${source}`);if(count){text=text.split(from).join(to);replacements.push({from,to,count});}};
 substitute('55436','55437');substitute('phase10_api_synthetic_20261020','phase10_independent_rollback_20261020');
 if(source.endsWith('.mjs')){
  substitute('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-${runId}','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/rollback-${runId}');
  substitute('phase10-api-before-image-20261020-postgres.test.ts',cafe);substitute('phase10-multisource-rollback-20261020.test.ts',multi);
 }
 writeFileSync(`${dir}/${target}`,text,{flag:'wx'});copies.push({source,target,originalSha256:sha(original),copySha256:sha(Buffer.from(text)),onlyExplicitReplacements:replacements});
}
const planPath='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-20261020';mkdirSync(planPath,{recursive:true});
const plan={kind:'PHASE10_INDEPENDENT_TARGET_ONLY_SYNTHETIC_HARNESS_COPY',at:new Date().toISOString(),label,target:{host:'127.0.0.1',port:55437,database:'phase10_independent_rollback_20261020'},copies,originalFilesModified:0,deletedTestsRestored:0,remoteRequests:0,runCommand:`TSX_TSCONFIG_PATH=apps/api/tsconfig.json node --import tsx ${dir}/${main} ${label}`,resultPath:`${evidence}/result.json`};
writeFileSync(`${planPath}/rollback-copy-${label}.json`,JSON.stringify(plan,null,2),{flag:'wx'});console.log(JSON.stringify({kind:plan.kind,copies:copies.length,main,runLabel:label,resultPath:plan.resultPath}));
