// Independently recompute release bytes; never changes candidate or checkout.
import assert from 'node:assert/strict';
import {readFile,lstat,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const candidate=resolve(process.argv[2]??join(root,'candidate-20261019'));
const label=process.argv[3]??'candidate-review-20261019';assert.match(label,/^[a-z0-9-]+$/);
assert(candidate.startsWith(resolve(root)+'\\'));
const old='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
const repo=process.cwd();
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const [manifest,selection,baseline]=await Promise.all(['source-content-manifest.json','phase10-selection.json'].map(async name=>JSON.parse(await readFile(join(candidate,name),'utf8'))).concat([readFile(join(old,'source-content-manifest.json'),'utf8').then(JSON.parse)]));
assert.equal(manifest.sourceContentSha256,hash(JSON.stringify(manifest.files)));
assert.equal(selection.sourceContentSha256,manifest.sourceContentSha256);
assert.equal(selection.migrationDigest,hash(JSON.stringify(manifest.files.filter(f=>/^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.name)))));
assert.equal(new Set(manifest.files.map(f=>f.name)).size,manifest.files.length);
assert.equal(baseline.sourceContentSha256,'0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1');
const changes=[],workspaceMismatch=[],missingFromCandidate=[];
for(const file of manifest.files){
 assert(!file.name.includes('..')&&!file.name.includes('\\')&&!file.name.startsWith('/'));
 assert(!/(?:^|\/)(?:\.env(?:\.|$)|node_modules|\.git|\.next|dist|private)(?:\/|$)|\.(?:dpapi|pem|key|dump|log)$/.test(file.name));
 const path=join(candidate,file.name),stat=await lstat(path),bytes=await readFile(path);
 assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(bytes.length,file.size);assert.equal(hash(bytes),file.sha256);
 const before=baseline.files.find(f=>f.name===file.name);
 if(!before||before.sha256!==file.sha256)changes.push({name:file.name,kind:before?'CHANGED':'ADDED',beforeSha256:before?.sha256??null,sha256:file.sha256});
 const current=await readFile(join(repo,file.name));if(hash(current)!==file.sha256)workspaceMismatch.push(file.name);
}
for(const before of baseline.files)if(!manifest.files.some(f=>f.name===before.name))missingFromCandidate.push(before.name);
assert.deepEqual(missingFromCandidate,[]);
assert.equal(hash(await readFile(join(candidate,'deploy/Dockerfile'))),hash(await readFile(join(repo,'deploy/Dockerfile'))));
const tracked=git(candidate,['ls-files']).split('\n');
assert.deepEqual(tracked.sort(),[...manifest.files.map(f=>f.name),'source-content-manifest.json','phase10-selection.json','deploy/Dockerfile'].sort());
assert.equal(git(repo,['rev-parse','HEAD']),selection.base);
const lock=JSON.parse(await readFile(join(candidate,'package-lock.json'),'utf8'));
const reviewedDependencies={};for(const name of ['next','multer','proxy-addr','source-map-js','sharp','brace-expansion']){
 reviewedDependencies[name]=Object.entries(lock.packages).filter(([path])=>path===`node_modules/${name}`||path.endsWith(`/node_modules/${name}`)).map(([path,pkg])=>({path,version:pkg.version,integrityPresent:typeof pkg.integrity==='string'}));
}
const out={kind:'PHASE10_INDEPENDENT_CANDIDATE_REVIEW',recordedAt:new Date().toISOString(),candidate,commit:git(candidate,['rev-parse','HEAD']),sourceContentSha256:manifest.sourceContentSha256,migrationDigest:selection.migrationDigest,migrationCount:selection.migrationCount,fileCount:manifest.files.length,allManifestBytesValid:true,gitTrackedClosureValid:true,productionDockerfileReviewedSeparately:true,originalHeadUnchanged:true,workspaceMismatch,missingFromCandidate,changes,reviewedDependencies,removedFrozenFiles:0,providerRequests:0,remoteWrites:0};
await mkdir(join(root,'independent'),{recursive:true});
await writeFile(join(root,'independent',label+'.json'),JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(out));
