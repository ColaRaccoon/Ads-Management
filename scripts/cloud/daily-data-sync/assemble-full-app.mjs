// Pure local allowlist snapshot of current files, including uncommitted changes.
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const roots=['apps/api/src','apps/api/prisma','apps/api/scripts','apps/web/src','apps/web/public','packages/shared/src'];
const fixed=['package.json','package-lock.json','.npmrc','.dockerignore','tsconfig.base.json',
  'apps/api/package.json','apps/api/tsconfig.json','apps/api/tsconfig.build.json',
  'apps/web/package.json','apps/web/tsconfig.json','apps/web/next.config.mjs','apps/web/next-env.d.ts',
  'packages/shared/package.json','packages/shared/tsconfig.json','deploy/launch-bundle.mjs',
  'deploy/cloud/phase08.Dockerfile','deploy/cloud/phase08-launch.mjs','deploy/cloud/ready-barrier.mjs',
  'deploy/cloud/assert-build-context-clean.mjs','deploy/cloud/assert-runtime-closure.mjs',
  'deploy/cloud/certs/supabase-prod-ca-2021.crt'];
const forbidden = name => /(?:^|\/)(?:node_modules|dist|dist-cafe24|\.next|\.git|coverage|\.security-dev|private)(?:\/|$)/i.test(name) ||
  /^apps\/api\/storage(?:\/|$)/i.test(name) ||
  /(?:^|\/)\.env(?:\.|$)/i.test(name) || /\.(?:dpapi|pfx|p12|key|dump|log)$/i.test(name);
export async function assembleFullApp(output,source=repo) {
  output=resolve(output);source=resolve(source);
  if(output===source || output.startsWith(source+'/') || output.startsWith(source+'\\')) throw new Error('PHASE08_EXTERNAL_OUTPUT_REQUIRED');
  const names=new Set(fixed);
  for(const entry of await readdir(join(source,'scripts'),{withFileTypes:true})) if(entry.isFile()&&/^prisma.*\.mjs$/.test(entry.name)) names.add(`scripts/${entry.name}`);
  const walk=async relative=>{
    const entries=await readdir(join(source,relative),{withFileTypes:true});
    for(const entry of entries) {
      const name=`${relative}/${entry.name}`;
      if(forbidden(name)) continue;
      if(entry.isSymbolicLink()) throw new Error('PHASE08_BUILD_REPARSE_REJECTED');
      if(entry.isDirectory()) await walk(name);
      else if(entry.isFile()) names.add(name);
      else throw new Error('PHASE08_BUILD_SPECIAL_FILE_REJECTED');
    }
  };
  for(const root of roots) {
    try {
      const info=await lstat(join(source,root));if(!info.isDirectory()||info.isSymbolicLink()) throw new Error('PHASE08_BUILD_REPARSE_REJECTED');
      await walk(root);
    } catch(error) { if(root==='apps/web/public'&&error.code==='ENOENT') continue;throw error; }
  }
  for(const optional of ['apps/web/postcss.config.mjs','apps/web/postcss.config.js','apps/web/tailwind.config.ts','apps/web/tailwind.config.js']) {
    try { if((await lstat(join(source,optional))).isFile()) names.add(optional); } catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  const prepared=[];
  for(const name of [...names].sort()) {
    if(forbidden(name)) throw new Error('PHASE08_BUILD_PRIVATE_INPUT_REJECTED');
    const info=await lstat(join(source,name));if(!info.isFile()||info.isSymbolicLink()) throw new Error('PHASE08_BUILD_REPARSE_REJECTED');
    const bytes=await readFile(join(source,name));
    if(name==='.npmrc'&&/(?:_authToken|_password|_auth)\s*=/i.test(bytes.toString('utf8'))) throw new Error('PHASE08_BUILD_NPM_SECRET_REJECTED');
    prepared.push({name,bytes,size:bytes.length,sha256:hash(bytes)});
  }
  const files=prepared.map(({name,size,sha256})=>({name,size,sha256}));
  const sourceContentSha256=hash(JSON.stringify(files));
  // CreateNew output directory; existing snapshots and source files are untouched.
  await mkdir(output,{recursive:false});
  for(const {name,bytes} of prepared) {
    const path=join(output,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes,{flag:'wx'});
  }
  const manifest={version:1,sourceContentSha256,files,includesCurrentDirtyFiles:true,secretsIncluded:false,remoteChanges:0,
    dockerfile:'deploy/cloud/phase08.Dockerfile',buildArgument:'PHASE08_SOURCE_CONTENT_SHA256',
    evidence:'LOCAL_SOURCE_SNAPSHOT_ONLY'};
  await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {output,sourceContentSha256,fileCount:files.length,remoteChanges:0};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const output=process.argv[2];
  if(!output) {console.error('PHASE08_BUILD_OUTPUT_REQUIRED');process.exitCode=1;}
  else assembleFullApp(output).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('PHASE08_BUILD_SNAPSHOT_FAILED');process.exitCode=1;});
}
