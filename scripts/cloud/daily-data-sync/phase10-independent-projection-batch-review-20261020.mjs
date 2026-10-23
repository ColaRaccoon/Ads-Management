import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const hash=b=>createHash('sha256').update(b).digest('hex');
const nativePath=root+'/independent/performance-relations-20261020-v1/result.json';
const nativeBytes=await readFile(nativePath),native=JSON.parse(nativeBytes);
const handoffBytes=await readFile(root+'/performance-projection-20261020/handoff.json'),handoff=JSON.parse(handoffBytes);
const oracleBytes=await readFile(root+'/performance-projection-20261020/oracle-72.json'),oracle=JSON.parse(oracleBytes);
const expected={...handoff.runtimeSourceHashes,
 'apps/api/src/common/meta-source-read-coverage.ts':'851ef84c88e926311762509d8a6263ff4f18085f2ede4e2f6818a6db74f47763',
 'apps/api/src/storefront/storefront-read.service.ts':'a1d09e3063b8efc480ad7a7f37a7dff314512163fa6c0126d6f8898ce4915d9e',
 'apps/api/src/storefront/storefront.spec.ts':'e20e426fe616ea9a61f537d141aeed541ad964c98f9e3af6b5c4bb8d445cc563'};
const sourceHashes={};for(const [p,h] of Object.entries(expected)){sourceHashes[p]=hash(await readFile(p));if(sourceHashes[p]!==h)throw Error('FROZEN_SOURCE_DRIFT');}
const checks={sevenSourcesBound:Object.keys(sourceHashes).length===7,
 oldReturnGuardUnchanged:hash(await readFile('apps/api/src/daily-sync/old-app-rollback-readiness.ts'))==='f364f848560faef791bcf01470cd8d294966f6165ecf435dd87e795ee4891ade',
 native:native.status==='PASS'&&native.migrations===51&&native.postgresStopExit===0&&native.matrix.matrixCases===62&&native.matrix.cases.every(c=>c.pass===true&&c.newPhysicalQueries===1&&c.batchPhysicalQueries===1&&c.batchKindsEqualOldOracle===true),
 storefront:native.storefront.wholeOutputEqualFrozenV4===true&&native.storefront.verifiedZeroCoverage===14&&native.storefront.sameRepeatableReadConcurrentCommitPreserved===true&&native.storefront.nextRequestFreshEvidenceRejects===true&&native.storefront.latestRunNullAndUuidTieOrderEqual===true&&native.storefront.hundredConnectionsEqual===true&&native.storefront.oneHundredOneConnectionsBothRejected===true,
 collection:native.storefront.metaCollectionWholeOutputEqualFrozenV4===true&&native.storefront.collectionOldPhysical===5&&native.storefront.collectionNewPhysical===4,
 oracle72:oracle.exactCases===72&&oracle.cases.length===72&&oracle.summaryCases===18&&oracle.trendCases===54&&oracle.cases.every(c=>c.exact===true&&c.actualSha256===c.expectedSha256),
 rawNone:oracle.rawResponsesSaved===false&&native.providerCalls===0&&native.remoteWrites===0,
};
const result={kind:'INDEPENDENT_PROJECTION_BATCH_SOURCE_REVIEW',at:new Date().toISOString(),status:Object.values(checks).every(Boolean)?'PASS_LOCAL_CHANGED_IMPACT':'FAIL',checks,sourceHashes,
 localFocused:{passed:51,failed:0,optionalHttpSkipped:1,commands:['node --require phase10-api-offline-test-guard.cjs --import tsx --test phase10-dashboard-decimal.test.ts phase10-dashboard-projection.test.ts phase10-independent-dashboard-boundary.test.ts','node --require phase10-api-offline-test-guard.cjs --import tsx --test storefront.spec.ts phase10-api-storefront-coverage-20261020.test.ts phase10-meta-batch-20261020.test.ts']},
 native:{port:55437,database:native.database,tests:2,metaCases:62,standaloneAndBatchOracleEqual:true,storefrontPhysical:[17,15],relationPhysical:[3,1,2],collectionPhysical:[5,4],postgresStopExit:0},
 review:['Dashboard summary/date/stage read scalar fields; product trends select displayName only; legacy decoration unchanged.','Money implementation changes only its internal relation-aware type; exact Decimal/BigInt boundaries remain.','Batched Meta proofs keep one materialized per-kind query and add explicit dataKind tags with UNION ALL; original count/link/version/unit predicates retained.','Unsupported kinds fail closed; empty inputs use zero SQL; no cross-request cache or freshness change.','Storefront connection101 bound and UUID/null ordering preserved; latestSuccessAt MAX and latestRun LATERAL execute within same RR.','Storefront connection DTO outputs explicit fields; new internal flat columns are not spread into API output.','Seventh changed file is only a3-line raw-query fixture adapter; assertions unchanged.'],
 evidenceHashes:{native:hash(nativeBytes),uiHandoff:hash(handoffBytes),oracle72:hash(oracleBytes)},
 limits:['Physical statement reductions and synthetic tests do not prove the actual40GET/concurrency4 p95<=5000ms acceptance.','Prisma query events include transaction commands; middleware counts are distinct and remained11→11 for Storefront.','Local corruption matrix relaxes two constraints only in its fresh synthetic database.','R4 p955038.68 failure and incident shared/CDN residuals remain preserved.'],
 ownRemoteRequests:0,ownProtectedMaterialReads:0,originalEvidenceModified:0};
const path=root+'/independent/resume-20261020/projection-batch-review-v1.json';await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({status:result.status,checks,path,sha256:hash(await readFile(path))})+'\n');if(result.status!=='PASS_LOCAL_CHANGED_IMPACT')process.exitCode=1;
