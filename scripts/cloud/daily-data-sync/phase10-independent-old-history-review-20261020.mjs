import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const base=root+'/api-20261020-old-history-v10';
const bytes=await readFile(base+'/lifecycle-result.json'), report=JSON.parse(bytes);
const mainBytes=await readFile(base+'/result.json'), main=JSON.parse(mainBytes);
const hash=b=>createHash('sha256').update(b).digest('hex');
const path='apps/api/src/uploads/upload-lifecycle.service.ts';
const git=execFileSync('git',['show','HEAD:'+path],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const archived=await readFile(base+'/old-source/'+path);
const groups=Object.fromEntries(['API_HIGHEST','CSV_HIGHEST','NO_API_CONTROL'].map(v=>[v,report.cases.filter(x=>x.variant===v)]));
const checks={
 baseline:main.baselineCommit==='9e9a1f82bb02346575565b031a43e17e13758dc8'&&main.oldSchemaMigrations===37&&main.currentMigrations===51,
 exactOldSource:git.equals(archived)&&hash(git)==='d7e51963b70c91e03c9e21a31bfc69be7452b51432ef8df7b6e6d939027e6259'&&main.oldLifecycleSourceSha256===hash(git),
 twelveCases:report.caseCount===12&&report.cases.length===12&&new Set(report.cases.map(x=>x.kind+':'+x.operation+':'+x.variant)).size===12&&Object.values(groups).every(x=>x.length===4),
 oldGateWasPermissive:report.cases.every(x=>x.gateReady===true&&x.retainedApiHistoryAllowed===true),
 csvHighestCommitsApiTimestampChange:groups.CSV_HIGHEST.every(x=>x.completed===true&&x.code===null&&x.apiFullHashPreserved===false&&x.apiPayloadPreserved===true&&JSON.stringify(x.changedApiKeys)==='["updatedAt"]'&&x.apiStillNoncurrent===true),
 apiHighestRollsBack:groups.API_HIGHEST.every(x=>x.completed===false&&x.code==='P2032'&&x.allTablesHashEqual===true&&x.apiFullHashPreserved===true),
 csvOnlyCommits:groups.NO_API_CONTROL.every(x=>x.completed===true&&x.code===null),
 unrelatedPreserved:report.cases.every(x=>x.laterCsvPayloadAndCurrentPreserved===true&&x.unrelatedCsvProductPolicyLinksCoverageHashesPreserved===true&&x.policyVersionCasStillMatches===true),
 externalNone:main.providerCalls===0&&main.remoteWrites===0&&main.appHttp===0&&main.dockerCalls===0&&report.cases.every(x=>x.storageCalls===0)&&main.postgresStopExit===0,
};
const result={kind:'INDEPENDENT_OLD_LIFECYCLE_API_HISTORY_REVIEW',at:new Date().toISOString(),status:Object.values(checks).every(Boolean)?'CONFIRMED_OLD_GATE_GAP':'FAIL_AUDIT',checks,oldSourceSha256:hash(git),sourceReceiptSha256:hash(bytes),mainReceiptSha256:hash(mainBytes),
 counts:{total:12,apiTimestampCommitChanges:4,apiHighestP2032FullRollback:4,csvOnlyControlCommits:4},
 scope:'Actual tracked HEAD restoreCurrentAdMetrics/restoreCurrentAdsetMetrics and deleteUpload with generated37-schema Prisma on fresh51-DDL synthetic PG; no actual image switch or general legacy business regression.',
 conclusion:'API current0 plus CSV policy does not make old-app return safe when noncurrent API history remains. Gate must fail closed, preserve history and avoid rewriting data for old-client compatibility.',
 limits:['Only fixture API updatedAt changed in CSV-highest cases; payload/current/links/coverage remain intact.','P2032 cases rolled back the full transaction; they do not prove old-app functionality.','New fail-closed gate requires independent focused/fresh native verification.'],
 ownRemoteRequests:0,ownProtectedMaterialReads:0,originalEvidenceModified:0};
const out=root+'/independent/resume-20261020/old-history-gap-review-v1.json';await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({status:result.status,checks,path:out,sha256:hash(await readFile(out))})+'\n');if(result.status==='FAIL_AUDIT')process.exitCode=1;
