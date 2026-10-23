// Rebind the preserved R7 synthetic experiment to the separately frozen C6 image.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',S='scripts/cloud/daily-data-sync/';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const ev=read(E+'/evidence/candidate-20261020-v6.json'),build=read(E+'/portable-build-20261020-v2/result.json'),prior=read(E+'/mixed-20261020-v1/attempt-v7/result.json');
assert.equal(build.status,'PASS_BUILD_ONLY');assert.equal(build.release,ev.commit);assert.equal(build.source,ev.sourceContentSha256);assert.equal(ev.migrationCount,52);assert.equal(ev.remoteMigrationApplied,false);assert.equal(ev.remoteActivation,false);
for(const [name,h]of Object.entries(prior.harnessHashes))assert.equal(sha(readFileSync(S+name)),h,'PRESERVED_R7_HARNESS');
const output=E+'/mixed-20261020-v2';assert(!existsSync(output));mkdirSync(output,{recursive:false});
function change(s,a,b){assert(s.includes(a),'EXPECTED_REBIND_SITE');return s.replaceAll(a,b);}
let run=readFileSync(S+'phase10-resume-mixed-run-v2.mjs','utf8');
run=change(run,'mixed-20261020-v1','mixed-20261020-v2');
run=change(run,'sha256:f5125361197ef99ca7b720ae9489e3cc2af4fd07ff80d7c53b569d10237be19d',build.image.id);
run=change(run,'7e6e03ed8a72c3c7c7cac57ec965e87d4c697c3b',ev.commit);
run=change(run,'candidate-20261020-v5','candidate-20261020-v6');
run=change(run,'phase10-resume-mixed-run-v2.mjs','phase10-resume-mixed-run-v3.mjs');
run=change(run,'assert.equal(migrations.length,51)','assert.equal(migrations.length,52)');
run=change(run,'evidence.migrations=51','evidence.migrations=52');
run=change(run,'for(const {tablename}of tables){assert(/^[a-z0-9_]+$/.test(tablename));await pg.query(`CREATE POLICY',
 'assert.equal(tables.length,70);for(const {tablename}of tables){assert(/^[a-z0-9_]+$/.test(tablename));await pg.query(`ALTER TABLE meta_ads."${tablename}" ENABLE ROW LEVEL SECURITY;ALTER TABLE meta_ads."${tablename}" FORCE ROW LEVEL SECURITY`);await pg.query(`CREATE POLICY');
run=change(run,'evidence.localFixturePolicies=tables.length;',`evidence.localFixturePolicies=tables.length;const forced=(await pg.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity")).rows[0].n;assert.equal(forced,70);evidence.explicitlyForcedRlsTables=forced;`);
const closure=`
const candidate='${E}/candidate-20261020-v6';
const source='${ev.sourceContentSha256}';
const verifyClosure=()=>{const mf=JSON.parse(readFileSync(candidate+'/source-content-manifest.json','utf8'));assert.equal(mf.files.length,495);assert.equal(mf.sourceContentSha256,source);assert.equal(sha(JSON.stringify(mf.files)),source);for(const f of mf.files){const b=readFileSync(candidate+'/'+f.name);assert.equal(b.length,f.size);assert.equal(sha(b),f.sha256);}return {source,files:495,migrations:52};};
evidence.candidateBefore=verifyClosure();evidence.remoteMigrationApplied=false;evidence.epochActivation=false;evidence.actualEpochEntryExercisedByMixed=false;
`;
run=change(run,"const scripts=['phase10-resume-mixed-container-v2.cjs'",closure+"const scripts=['phase10-resume-mixed-container-v2.cjs'");
run=change(run,"evidence.finishedAt=new Date().toISOString();",'evidence.candidateAfter=verifyClosure();evidence.finishedAt=new Date().toISOString();');
let audit=readFileSync(S+'phase10-resume-mixed-audit-v2.mjs','utf8');
audit=change(audit,'mixed-20261020-v1','mixed-20261020-v2');
audit=change(audit,'sha256:f5125361197ef99ca7b720ae9489e3cc2af4fd07ff80d7c53b569d10237be19d',build.image.id);
audit=change(audit,'7e6e03ed8a72c3c7c7cac57ec965e87d4c697c3b',ev.commit);
audit=change(audit,'assert.equal(e.migrations,51);assert.equal(e.localFixturePolicies,68);','assert.equal(e.migrations,52);assert.equal(e.localFixturePolicies,70);assert.equal(e.explicitlyForcedRlsTables,70);assert.deepEqual(e.candidateBefore,e.candidateAfter);');
audit=change(audit,'candidate-20261020-v5/apps/api/dist','portable-build-20261020-v2/api-dist');
audit=change(audit,'runtimeCompiledFilesCompared:Object.keys(m.compiledHashes).length,',`runtimeCompiledFilesCompared:Object.keys(m.compiledHashes).length,release:'${ev.commit}',source:'${ev.sourceContentSha256}',newEpochPathVerifiedSeparately:true,remote52MigrationApplied:false,explicitlyForcedRlsTables:70,`);
const files=[['phase10-resume-mixed-run-v3.mjs',run],['phase10-resume-mixed-audit-v3.mjs',audit]];
for(const [name,body]of files)writeFileSync(S+name,body,{flag:'wx'});
const proof={kind:'C6_SYNTHETIC_MIXED_TOOL_REBIND',at:new Date().toISOString(),release:ev.commit,source:ev.sourceContentSha256,image:build.image.id,originalR7EvidenceSha256:sha(readFileSync(E+'/mixed-20261020-v1/attempt-v7/result.json')),originalR7Unchanged:true,newMigrations:52,newFixtureTables:70,explicitForceRls:true,requests:40,concurrency:4,p95Ms:5000,realProviderRequests:0,protectedReads:0,remoteMigrationApplied:false,remoteActivation:false,scope:'compiled startup/read/write/retry/lease/checkpoint; epoch entry separately tested by focused native harness',files:files.map(([name,body])=>({name,sha256:sha(body)}))};
writeFileSync(output+'/tools.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
