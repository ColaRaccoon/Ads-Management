// Public file evidence only. No Docker, process launch, SQL, provider or private files.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const out=E+'/independent/resume-20261020/epoch-c7-final-public-audit-v1.json';
assert(!existsSync(out));
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const release='a49bec345f995ec71f25f9e569caa5fe20578235';
const source='70a7c8cd00c2dd592f632dd35312e283011ef648c5926b5aac4273edb8cea6f2';
const image='sha256:e3fb7eedf91ef64d6c26590856d2c979e5644b644109d4fb9549ad8ad66fa964';
const map=', map: "cafe24_epoch_revisions_checkpoint_fkey"';
const strip=s=>{assert.equal(s.split(map).length,2);return s.replace(map,'');};
const manifests=['v6','v7'].map(v=>read(E+'/candidate-20261020-'+v+'/source-content-manifest.json'));
for(const [i,m]of manifests.entries()){
  assert.equal(m.files.length,495);assert.equal(sha(JSON.stringify(m.files)),m.sourceContentSha256);
  assert.equal(new Set(m.files.map(f=>f.name)).size,495);
  for(const f of m.files){assert(!f.name.includes('..')&&!f.name.startsWith('/'));const b=readFileSync(E+'/candidate-20261020-v'+(i+6)+'/'+f.name);assert.equal(b.length,f.size);assert.equal(sha(b),f.sha256);}
}
assert.equal(manifests[1].sourceContentSha256,source);
assert.deepEqual(manifests[0].files.map(f=>f.name),manifests[1].files.map(f=>f.name));
const changed=manifests[1].files.filter((f,i)=>f.sha256!==manifests[0].files[i].sha256).map(f=>f.name);
assert.deepEqual(changed,['apps/api/prisma/schema.prisma']);
const c6=E+'/candidate-20261020-v6',c7=E+'/candidate-20261020-v7';
assert.equal(strip(readFileSync(c7+'/apps/api/prisma/schema.prisma','utf8')),readFileSync(c6+'/apps/api/prisma/schema.prisma','utf8'));
const sql=manifests[1].files.filter(f=>/^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.name));assert.equal(sql.length,52);
const compiledPaths=['v2','v3'].map(v=>E+'/portable-build-20261020-'+v);
const compiled=compiledPaths.map(p=>read(p+'/compiled-proof.json'));
assert.equal(compiled[1].release,release);assert.equal(compiled[1].source,source);assert.equal(compiled[1].image,image);
assert.equal(compiled[0].files.length,272);assert.deepEqual(compiled[0].files,compiled[1].files);
for(const [i,p]of compiledPaths.entries())for(const f of compiled[i].files){const b=readFileSync(p+'/api-dist/'+f.name);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
const linuxRoot=E+'/cafe-epoch-linux-20261020-v1',linux=read(linuxRoot+'/result.json');
assert.equal(linux.status,'PASS');assert.equal(linux.afterImage,image);assert.equal(linux.afterRelease,release);
assert.equal(linux.files.length,14);assert.equal(linux.linuxEngineFilesByteIdentical,1);
const prop=(s,n)=>JSON.parse(s.match(new RegExp('"'+n+'": ("(?:\\\\.|[^"\\\\])*")'))[1]);
const runtime=s=>JSON.parse(s.match(/config\.runtimeDataModel = JSON\.parse\(("(?:\\.|[^"\\])*")\)/)[1]);
const normalize=s=>s.replace(/"inlineSchema": ("(?:\\.|[^"\\])*")/,'"inlineSchema": "MAP_ONLY"').replace(/"inlineSchemaHash": "[a-f0-9]{64}"/,'"inlineSchemaHash": "MAP_ONLY"');
for(const row of linux.files){const a=readFileSync(linuxRoot+'/c6/'+row.name),b=readFileSync(linuxRoot+'/c7/'+row.name);assert.equal(sha(a),row.beforeSha256);assert.equal(sha(b),row.afterSha256);if(a.equals(b))continue;
  const old=a.toString('utf8'),next=b.toString('utf8');
  if(row.name==='schema.prisma')assert.equal(strip(next),old);
  else if(['index.js','edge.js'].includes(row.name)){
    assert.equal(normalize(next),normalize(old));assert.equal(strip(prop(next,'inlineSchema')),prop(old,'inlineSchema'));assert.equal(runtime(next),runtime(old));
    // Exact algorithm from the installed Prisma generator, not hash-shape acceptance.
    for(const s of [old,next])assert.equal(sha(Buffer.from(prop(s,'inlineSchema'),'utf8').toString('base64')),prop(s,'inlineSchemaHash'));
  }else if(row.name==='package.json'){
    const p=JSON.parse(old),q=JSON.parse(next);assert.equal(p.name,'prisma-client-'+sha(readFileSync(linuxRoot+'/c6/schema.prisma')));assert.equal(q.name,'prisma-client-'+sha(readFileSync(linuxRoot+'/c7/schema.prisma')));assert.equal(next.replace(q.name,p.name),old);
  }else assert.fail('UNEXPECTED_LINUX_GENERATED_DELTA');
}
assert.deepEqual(linux.changedFiles,['edge.js','index.js','package.json','schema.prisma']);
for(const k of ['containerStarts','applicationRequests','databaseRequests','providerRequests','credentialsInjected'])assert.equal(linux[k],0);
const smoke=read(E+'/portable-build-20261020-v3/epoch-image-smoke.json');assert.equal(smoke.image,image);assert.equal(smoke.source,source);assert.equal(smoke.status,'PASS');assert.equal(smoke.smoke.passed,6);assert.equal(smoke.smoke.databaseRequests,0);assert.equal(smoke.smoke.networkAttempts,0);
const nativeRoot=E+'/cafe-epoch-eval-20261020-v3/attempt-95ac96fb-e588-4f28-8943-e53042d51b73';
const n=read(nativeRoot+'/result.json'),privacy=read(nativeRoot+'/privacy-proof.json');
assert.equal(n.status,'PASS');assert.equal(n.cases.length,38);assert.equal(new Set(n.cases.map(c=>c.name)).size,38);assert(n.cases.every(c=>c.status==='PASS'));
assert.equal(n.candidateBinding.release,release);assert.equal(n.candidateBinding.runtimeSourceSha256,source);assert.equal(n.candidateBinding.runtimeFiles,495);assert.equal(n.candidateBinding.migrations,52);
assert.deepEqual(n.old68Before,n.old68After);assert.equal(n.old68Before.tableCount,68);
assert.equal(n.native.inheritedDefaultGrantsInjected,true);assert.equal(n.native.newTablesDefaultNonownerGrants,0);assert.equal(n.native.newTablesForcedRls,2);assert.equal(n.native.wrongOrMissingPasswordDenied,3);assert.equal(n.native.postgresStopExit,0);assert.equal(n.native.temporaryPasswordFileRemaining,false);
const expectedCounts={FIELD_UNSUPPORTED:14,RECONCILIATION_FAILED:8,LEASE_LOST:4};
for(const [code,count]of Object.entries(expectedCounts)){const rows=n.cases.filter(c=>c.expectedRejection===code);assert.equal(rows.length,count);assert(rows.every(c=>c.safeRejection===code));}
const fk=n.native.checkpointForeignKey;assert.equal(fk.name,'cafe24_epoch_revisions_checkpoint_fkey');assert.deepEqual(fk.childColumns,['connection_id','key_version','order_date']);assert.deepEqual(fk.parentColumns,fk.childColumns);assert.equal(fk.deferrable,true);assert.equal(fk.initiallyDeferred,true);assert.equal(fk.onDelete,'RESTRICT');assert.equal(fk.onUpdate,'CASCADE');
for(const a of n.approvalManifests){assert.equal(sha(JSON.stringify(a.manifest)),a.sha256);assert.equal(a.manifest.sourceClosureSha256,source);assert.equal(a.manifest.explicitManualDaysOnly,true);}
assert.deepEqual(n.approvalManifests[0].manifest.approvedDays,['2026-10-16','2026-10-17']);assert.deepEqual(n.approvalManifests[1].manifest.approvedDays,['2026-10-16']);assert.notEqual(n.approvalManifests[0].manifest.epochReference,n.approvalManifests[1].manifest.epochReference);
assert.equal(n.observationOnly,true);assert.equal(n.canonicalWrites,0);assert.equal(n.continuityRestored,false);assert.equal(n.sealedNormalizedInputUsed,false);for(const k of ['remoteRequests','providerRequests','rawValuesReturned'])assert.equal(n[k],0);
assert.equal(privacy.allHbaScramSha256,true);assert.equal(privacy.temporaryPasswordRemaining,0);assert.equal(privacy.temporarySyntheticPasswordFilesCreated,1);assert.equal(privacy.aclEvidence.length,4);assert(privacy.aclEvidence.every(p=>p.otherAllowedPrincipals===0));assert.equal(privacy.liveCustomerInputUsed,false);
const finalPath=E+'/continuation-20261020/c7-epoch-final-binding.json',binding=read(finalPath);assert.equal(binding.status,'PASS_PREPARATION_AND_LOCAL_VALIDATION_ONLY');assert.equal(binding.candidateSource,source);assert.equal(binding.image,image);for(const p of binding.inputs)assert.equal(sha(readFileSync(p.path)),p.sha256);assert.equal(binding.performance.actualC7FortyReadRerun,false);assert.equal(binding.performance.p95Ms,2847.49);assert.equal(binding.remoteMigrationApplied,false);assert.equal(binding.remoteEpochActivated,false);assert.equal(binding.stages11And12Started,false);
const proof={kind:'INDEPENDENT_CURRENT_C7_EPOCH_AND_BOUNDED_REUSE_AUDIT',at:new Date().toISOString(),status:'PASS_PREPARATION_AND_LOCAL_VALIDATION_ONLY',release,source,image,sourceFilesVerified:495,onlySourceDeltaFromMeasuredC6:changed,compiledApiFilesByteIdentical:272,migrationSqlFilesByteIdentical:52,linuxPrisma:{filesVerified:14,engineFilesByteIdentical:1,runtimeDataModelCopiesByteIdentical:2,changedFiles:linux.changedFiles,inlineSchemaHashesRecomputedByPrismaAlgorithm:true,packageNamesDerivedFromExactSchemaSha256:true},imageCompiledSmoke:6,currentC7FreshNative:{cases:38,correctNegativeCodes:expectedCounts,old68RowsPkRlsAclAndDefaultAclPreserved:true,newTablesForcedRls:2,inheritedGrantsRemoved:true,newNonownerGrants:0,checkpointFkExact:true,approvedDays:['2026-10-16','2026-10-17'],temporaryPasswordFiles:0,wrongPasswordDenied:3,postgresStop:0,privateAclOtherPrincipals:0},measuredC6Mixed:{p95Ms:2847.49,requests:40,concurrency:4,errors:0,actualC7FortyRerun:false,boundedReuse:true},originalNativeFailuresRetained:2,remoteMigrationApplied:false,remoteEpochActivated:false,oldV1ContinuityRestored:false,independentDockerSqlProviderDpapiRequests:0,scope:'Independent source/hash/numeric review of public root-run evidence. No new workload or external request.',limits:['Synthetic raw fixtures and permissive local RLS are not production authorization or live shared recovery.','Fresh C7 native directly exercises current observation code; C6 mixed reuse is limited to the proven unchanged compiled/runtime/DDL path.','Trusted approval caller and a separate actual isolated epoch activation gate remain required.','Coherent privileged deletion has no external anti-deletion anchor.'],inputs:Object.fromEntries([finalPath,nativeRoot+'/result.json',nativeRoot+'/privacy-proof.json',linuxRoot+'/result.json',E+'/portable-build-20261020-v3/epoch-image-smoke.json'].map(p=>[p,sha(readFileSync(p))]))};
writeFileSync(out,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({path:out,sha256:sha(readFileSync(out)),status:proof.status,native:38,compiled:272,linux:14}));
