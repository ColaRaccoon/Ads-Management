// Local release snapshot. Never stages or commits the user's checkout.
import { assembleFullApp } from './assemble-full-app.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const sha = b => createHash('sha256').update(b).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const source = process.cwd();
const output = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !output.startsWith('C:\\Users\\seong\\AppData\\Local\\MetaAdsPhase10Evaluation\\')) throw Error('EXTERNAL_PHASE10_OUTPUT_REQUIRED');
const base = git(source, ['rev-parse','HEAD']);
const status = git(source, ['status','--porcelain=v1','-uall']);
const result = await assembleFullApp(output, source);
// Production Dockerfile is review material; the isolated image uses phase08.Dockerfile.
await writeFile(join(output,'deploy/Dockerfile'), await readFile(join(source,'deploy/Dockerfile')), {flag:'wx'});
const manifest = JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
const migrationFiles = manifest.files.filter(f => /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.name));
const review = {kind:'PHASE10_REVIEWED_RUNTIME_SELECTION', base, branch:git(source,['branch','--show-current']),
  sourceContentSha256:result.sourceContentSha256, files:manifest.files,
  migrationDigest:sha(JSON.stringify(migrationFiles)), migrationCount:migrationFiles.length,
  selectedCurrentRuntime:true, excluded:['docs','scripts/cloud execution receipts','maintenance','legacy deployment','private data','generated outputs'],
  originalStatusSha256:sha(status), originalDeleted:status.split('\n').filter(s=>s.startsWith(' D ')).length,
  originalCheckoutMutation:false, productionWrites:0};
await writeFile(join(output,'phase10-selection.json'),JSON.stringify(review,null,2)+'\n',{flag:'wx'});
git(output,['init','-b','codex/daily-data-automation-10-candidate']);
git(output,['add','--all']);
git(output,['-c','user.name=Codex','-c','user.email=codex@local.invalid','commit','-m','Freeze phase 10 isolated runtime candidate from reviewed dirty checkout']);
const commit=git(output,['rev-parse','HEAD']);
await mkdir(resolve(output,'..','evidence'),{recursive:true});
const evidence={...result,commit,base,migrationDigest:review.migrationDigest,migrationCount:review.migrationCount,
  apiVersion:JSON.parse(await readFile(join(output,'apps/api/package.json'),'utf8')).version,
  recordedAt:new Date().toISOString(), originalBranchUnchanged:git(source,['branch','--show-current'])===review.branch,
  originalHeadUnchanged:git(source,['rev-parse','HEAD'])===base, standaloneCandidateRepository:true};
await writeFile(join(output,'..','evidence',output.split(/[\\/]/).at(-1)+'.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(evidence));
