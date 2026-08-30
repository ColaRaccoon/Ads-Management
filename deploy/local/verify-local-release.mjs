import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 1_073_741_824;
const MAX_RELEASE_BYTES = 17_179_869_184;
const MAX_MANIFEST_BYTES = 134_217_728;
export const WINDOWS_HOST_FILES = Object.freeze([
  "deploy/windows/Activate-ServerCertificate.ps1","deploy/windows/approval-plan.ps1","deploy/windows/approval-plan.runtime.test.ps1","deploy/windows/Backup-Local.ps1","deploy/windows/edge-drain-identity.ps1","deploy/windows/edge-drain-identity.runtime.test.ps1","deploy/windows/edge-service.xml.template","deploy/windows/Finalize-SupabaseRollback.ps1","deploy/windows/host-instance.ps1","deploy/windows/Manage-Acl.ps1","deploy/windows/Manage-BackupSchedule.ps1","deploy/windows/Manage-ClientTrust.ps1","deploy/windows/Manage-Firewall.ps1","deploy/windows/Manage-LegacyQuiesce.ps1","deploy/windows/Manage-Maintenance.ps1","deploy/windows/Manage-PrincipalRights.ps1","deploy/windows/Manage-RecoveryKit.ps1","deploy/windows/Manage-Service.ps1","deploy/windows/Manage-SupabaseMigration.ps1","deploy/windows/Manage-SupabaseRollbackRestore.ps1","deploy/windows/Merge-ClientTrustEvidence.ps1","deploy/windows/nas-identity.ps1","deploy/windows/nas-identity.runtime.test.ps1","deploy/windows/New-InternalCa.ps1","deploy/windows/New-LegacyRunningBaseline.ps1","deploy/windows/Publish-BackupReceipt.ps1","deploy/windows/Publish-PendingBackupReceipt.ps1","deploy/windows/Publish-RestoreEvidence.ps1","deploy/windows/recovery-process-tree.ps1","deploy/windows/recovery-process-tree.runtime.test.ps1","deploy/windows/Renew-ServerCertificate.ps1","deploy/windows/Restore-Verify.ps1","deploy/windows/service.xml.template","deploy/windows/Stage-LegacyLocalStorage.ps1","deploy/windows/Switch-LocalRelease.ps1","deploy/windows/Test-BackupTarget.ps1","deploy/windows/Test-HostBundleSyntax.ps1","deploy/windows/Test-InitialCutoverCompatibility.ps1","deploy/windows/Test-RebootReadiness.ps1","deploy/windows/Test-ReleaseCompatibility.ps1","deploy/windows/Test-SupabaseDatabaseBoundary.ps1"
]);
export const LOCAL_HOST_TOOL_FILES = Object.freeze([
  "deploy/local/api-config.mjs","deploy/local/api.env.example","deploy/local/config.example.json","deploy/local/config.schema.json","deploy/local/https-edge.mjs","deploy/local/launch-local-bundle.mjs","deploy/local/new-backup-schedule-authorization.mjs","deploy/local/new-bootstrap-authorization.mjs","deploy/local/new-signing-key.mjs","deploy/local/recovery-kit.mjs","deploy/local/runtime-config.mjs","deploy/local/sign-attestation.mjs","deploy/local/sign-backup-receipt.mjs","deploy/local/smoke-local-release.mjs","deploy/local/start-edge.mjs","deploy/local/verify-attestation.mjs","deploy/local/verify-https-release.mjs","deploy/local/verify-local-release.mjs","deploy/local/verify-runtime-readiness.mjs","deploy/local/verify-tls-material.mjs"
]);
export const REQUIRED_RELEASE_FILES = Object.freeze([
  "api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/dist/staging/business-compatibility-smoke.cli.js","api/dist/staging/legacy-business-compatibility-smoke.cli.js","api/dist/staging/auth-role-matrix-smoke.cli.js","api/package.json","api/prisma/schema.prisma",
  "api/node_modules/@prisma/client/package.json","api/node_modules/.prisma/client/package.json","api/node_modules/prisma/package.json","api/node_modules/prisma/build/index.js",
  "web/server.js","web/package.json","web/.next/BUILD_ID","web/.next/required-server-files.json",
  ...LOCAL_HOST_TOOL_FILES,
  ...WINDOWS_HOST_FILES
]);
export const FORBIDDEN_RELEASE_FILES = Object.freeze([
  "api/dist/auth/bootstrap-super-admin.cli.js"
]);

export async function verifyLocalRelease(rootValue, expectedManifestSha256) {
  const root = path.resolve(rootValue);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("RELEASE_ROOT_INVALID");
  const manifestPath = path.join(root, "release-manifest.json");
  const manifestBytes = await boundedRead(manifestPath, MAX_MANIFEST_BYTES);
  const manifestSha256 = sha256(manifestBytes);
  if (expectedManifestSha256 && (!/^[0-9a-f]{64}$/i.test(expectedManifestSha256) || manifestSha256 !== expectedManifestSha256.toLowerCase())) fail("RELEASE_MANIFEST_HASH_MISMATCH");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("RELEASE_MANIFEST_INVALID"); }
  exactKeys(manifest, ["version","releaseId","targetPlatform","targetArch","nodeModulesAbi","migrationDigest","windowsHostBundleDigest","runtimeSmokeContractDigest","runtimeSmokeVerified","files"]);
  if (manifest.version !== 4 || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(manifest.releaseId) || !/^[a-z0-9_-]{2,32}$/.test(manifest.targetPlatform) || !/^[a-z0-9_-]{2,32}$/.test(manifest.targetArch) || !/^[0-9]{2,4}$/.test(manifest.nodeModulesAbi) || !/^[0-9a-f]{64}$/.test(manifest.migrationDigest) || !/^[0-9a-f]{64}$/.test(manifest.windowsHostBundleDigest) || !/^[0-9a-f]{64}$/.test(manifest.runtimeSmokeContractDigest) || manifest.runtimeSmokeVerified!==true || !plainObject(manifest.files)) fail("RELEASE_MANIFEST_INVALID");
  if (manifest.targetPlatform !== process.platform || manifest.targetArch !== process.arch || manifest.nodeModulesAbi !== process.versions.modules) fail("RELEASE_PLATFORM_ABI_MISMATCH");
  const actual = await inventory(root, true);
  const expectedNames = Object.keys(manifest.files).sort((a,b)=>a.localeCompare(b,"en"));
  if (actual.map((item) => item.relative).join("\n") !== expectedNames.join("\n")) fail("RELEASE_FILE_SET_MISMATCH");
  const actualHashes=await hashInventory(actual);
  for (const item of actual) {
    const expected = manifest.files[item.relative];
    if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actualHashes[item.relative]) fail("RELEASE_FILE_HASH_MISMATCH");
  }
  if (manifest.windowsHostBundleDigest !== windowsHostBundleDigest(manifest.files)) fail("RELEASE_WINDOWS_HOST_BUNDLE_DIGEST_MISMATCH");
  if (manifest.runtimeSmokeContractDigest !== runtimeSmokeContractDigest(manifest.files)) fail("RELEASE_RUNTIME_SMOKE_CONTRACT_MISMATCH");
  await verifyRuntimeClosure(root, actual);
  const migrationLines = actual.filter((item) => /^api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(item.relative))
    .map((item) => `${item.relative.slice("api/prisma/migrations/".length)}=${manifest.files[item.relative]}`);
  if (migrationLines.length === 0 || sha256(Buffer.from(migrationLines.join("\n"),"utf8")) !== manifest.migrationDigest) fail("RELEASE_MIGRATION_DIGEST_MISMATCH");
  return Object.freeze({ root, releaseId: manifest.releaseId, targetPlatform:manifest.targetPlatform, targetArch:manifest.targetArch, nodeModulesAbi:manifest.nodeModulesAbi, migrationDigest: manifest.migrationDigest, manifestSha256, fileCount: actual.length });
}

export async function verifyRuntimeClosure(rootValue, filesValue) {
  const root=path.resolve(rootValue);const files=filesValue??await inventory(root,true);const names=new Set(files.map((item)=>item.relative));
  for(const name of FORBIDDEN_RELEASE_FILES)if(names.has(name))fail(`RELEASE_FORBIDDEN_LEGACY_AUTH_EXECUTABLE:${name}`);
  for(const name of REQUIRED_RELEASE_FILES)if(!names.has(name))fail(`RELEASE_REQUIRED_FILE_MISSING:${name}`);
  const actualWindows=[...names].filter((name)=>name.startsWith("deploy/windows/")).sort();
  if(actualWindows.join("\n")!==[...WINDOWS_HOST_FILES].sort().join("\n"))fail("RELEASE_WINDOWS_HOST_FILE_SET_MISMATCH");
  const actualLocal=[...names].filter((name)=>name.startsWith("deploy/local/")).sort();
  if(actualLocal.join("\n")!==[...LOCAL_HOST_TOOL_FILES].sort().join("\n"))fail("RELEASE_LOCAL_HOST_TOOL_SET_MISMATCH");
  if(![...names].some((name)=>name.startsWith("web/.next/server/"))||![...names].some((name)=>name.startsWith("web/.next/static/")))fail("RELEASE_WEB_RUNTIME_ASSETS_MISSING");
  const engineNames=[...names].filter((name)=>/^api\/node_modules\/\.prisma\/client\/(?:lib)?query_engine[^/]*\.(?:node|dll\.node|so\.node|dylib\.node)$/.test(name));
  if(engineNames.length<1)fail("RELEASE_PRISMA_ENGINE_MISSING");
  if(process.platform==="win32"&&!engineNames.some((name)=>name.endsWith(".dll.node")))fail("RELEASE_PRISMA_ENGINE_PLATFORM_MISMATCH");
  if(process.platform==="linux"&&!engineNames.some((name)=>name.endsWith(".so.node")))fail("RELEASE_PRISMA_ENGINE_PLATFORM_MISMATCH");
  if(process.platform==="darwin"&&!engineNames.some((name)=>name.endsWith(".dylib.node")))fail("RELEASE_PRISMA_ENGINE_PLATFORM_MISMATCH");
  let requiredServerFiles;
  try{requiredServerFiles=JSON.parse((await boundedRead(path.join(root,"web/.next/required-server-files.json"),4*1024*1024)).toString("utf8"));}catch{fail("RELEASE_NEXT_REQUIRED_FILES_INVALID")}
  if(!Array.isArray(requiredServerFiles?.files)||requiredServerFiles.files.length<1||requiredServerFiles.files.length>20_000)fail("RELEASE_NEXT_REQUIRED_FILES_INVALID");
  for(const entry of requiredServerFiles.files){
    if(typeof entry!=="string"||entry.length<1||entry.length>1024||entry.includes(":")||path.posix.isAbsolute(entry)||path.win32.isAbsolute(entry))fail("RELEASE_NEXT_REQUIRED_FILES_INVALID");
    const normalized=path.posix.normalize(entry.replace(/\\/g,"/").replace(/^\.\//,""));
    if(normalized===".."||normalized.startsWith("../"))fail("RELEASE_NEXT_REQUIRED_FILES_INVALID");
    if(!names.has(`web/${normalized}`))fail(`RELEASE_NEXT_REQUIRED_FILE_MISSING:${normalized}`);
  }
  for(const app of ["api","web"]){
    const appRoot=path.join(root,app);const packagePath=path.join(appRoot,"package.json");
    await assertPackageDependencies(packagePath,appRoot,root,root,names);
    const packageManifests=files.filter((item)=>item.relative.startsWith(`${app}/node_modules/`)&&/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(item.relative));
    if(packageManifests.length<1)fail("RELEASE_RUNTIME_DEPENDENCIES_MISSING");
    for(const item of packageManifests)await assertPackageDependencies(item.full,path.dirname(item.full),appRoot,root,names);
  }
}

export function windowsHostBundleDigest(files){
  return sha256(Buffer.from([...WINDOWS_HOST_FILES].sort().map((name)=>`${name}=${files[name]??""}`).join("\n"),"utf8"));
}
export function runtimeSmokeContractDigest(files){
  const names=[...LOCAL_HOST_TOOL_FILES,"api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/dist/staging/business-compatibility-smoke.cli.js","api/dist/staging/legacy-business-compatibility-smoke.cli.js","api/dist/staging/auth-role-matrix-smoke.cli.js","api/node_modules/prisma/build/index.js","web/server.js"];
  return sha256(Buffer.from(["source-free-cold-start-v1",...names.map((name)=>`${name}=${files[name]??""}`)].join("\n"),"utf8"));
}

async function assertPackageDependencies(packagePath, packageDirectory, boundaryRoot, releaseRoot, names){
  let value;try{value=JSON.parse((await boundedRead(packagePath,1024*1024)).toString("utf8"));}catch{fail("RELEASE_PACKAGE_MANIFEST_INVALID")}
  if(!plainObject(value)||!plainObject(value.dependencies??{}))fail("RELEASE_PACKAGE_MANIFEST_INVALID");
  for(const dependency of Object.keys(value.dependencies??{})){
    if(!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(dependency)||!await dependencyManifestExists(packageDirectory,boundaryRoot,dependency))fail(`RELEASE_DEPENDENCY_CLOSURE_MISSING:${dependency}`);
  }
  assertPackageEntrypoints(value,packagePath,releaseRoot,names);
}

function assertPackageEntrypoints(value,packagePath,releaseRoot,names){
  const targets=[];
  const packagePrefix=path.relative(releaseRoot,path.dirname(packagePath)).split(path.sep).join("/");
  const isInstalledDependency=packagePrefix.split("/").includes("node_modules");
  for(const key of ["main","module"]){if(typeof value[key]==="string"&&value[key].length)targets.push(value[key]);}
  // CommonJS package resolution falls back to index.js only when neither a
  // main field nor an exports map defines the package root.  A release that
  // omits that implicit file can otherwise pass closure verification and fail
  // only on a clean host during require("package").
  if(isInstalledDependency&&typeof value.main!=="string"&&value.exports===undefined&&!explicitlyNonCommonJsPackage(value))targets.push("./index.js");
  if(typeof value.main!=="string")collectRuntimeTargets(value.exports,targets);
  if(typeof value.browser==="string"&&value.browser.length)targets.push(value.browser);else if(plainObject(value.browser))for(const candidate of Object.values(value.browser))if(typeof candidate==="string"&&candidate.length)targets.push(candidate);
  if(typeof value.bin==="string"&&value.bin.length)targets.push(value.bin);else if(plainObject(value.bin))for(const candidate of Object.values(value.bin))if(typeof candidate==="string"&&candidate.length)targets.push(candidate);
  if(plainObject(value.binary)&&typeof value.binary.module_path==="string"&&typeof value.binary.module_name==="string")targets.push(`${value.binary.module_path}/${value.binary.module_name}.node`.replace(/\{[^}]+\}/g,"*"));
  for(const target of new Set(targets))assertPackagedEntrypoint(packagePrefix,target,names);
}
function explicitlyNonCommonJsPackage(value){
  if(typeof value.name==="string"&&value.name.startsWith("@types/"))return true;
  if(typeof value.name==="string"&&value.name.startsWith("@esbuild/")&&Array.isArray(value.os)&&Array.isArray(value.cpu))return true;
  if(!Array.isArray(value.files)||value.files.length===0)return false;
  return value.files.every((entry)=>typeof entry==="string"&&(/^(?:licen[cs]e|readme|history|authors)(?:\.|$)/i.test(entry)||/\.(?:json|d\.ts|js\.flow)$/i.test(entry)||entry==="*.d.ts"));
}
function collectRuntimeTargets(value,targets,key=""){
  if(typeof value==="string"){if(key!=="types"&&value.length)targets.push(value);return}
  if(Array.isArray(value)){for(const child of value)collectRuntimeTargets(child,targets,key);return}
  if(plainObject(value)){
    const entries=Object.entries(value);const hasSubpaths=entries.some(([childKey])=>childKey.startsWith("."));
    if(hasSubpaths){if(Object.hasOwn(value,"."))collectRuntimeTargets(value["."],targets,".");return}
    for(const [childKey,child] of entries)collectRuntimeTargets(child,targets,childKey);
  }
}
function assertPackagedEntrypoint(packagePrefix,target,names){
  if(typeof target!=="string"||target.length<1||target.length>1024||target.includes("\\")||path.posix.isAbsolute(target))fail(`RELEASE_PACKAGE_ENTRYPOINT_INVALID:${packagePrefix}:${String(target)}`);
  const normalized=path.posix.normalize(target.replace(/^\.\//,"")).replace(/\/+$/,"");if(!normalized||normalized===".."||normalized.startsWith("../"))fail(`RELEASE_PACKAGE_ENTRYPOINT_INVALID:${packagePrefix}:${target}`);
  const candidate=`${packagePrefix}/${normalized}`;
  if(candidate.includes("*")){
    const expression=new RegExp(`^${candidate.split("*").map(escapeRegExp).join("[^/]*")}$`);if(![...names].some((name)=>expression.test(name)))fail(`RELEASE_PACKAGE_ENTRYPOINT_MISSING:${packagePrefix}:${target}`);return;
  }
  const alternatives=[candidate,`${candidate}.js`,`${candidate}.cjs`,`${candidate}.mjs`,`${candidate}.json`,`${candidate}.node`,`${candidate}/index.js`,`${candidate}/index.cjs`,`${candidate}/index.mjs`,`${candidate}/index.node`];
  if(!alternatives.some((name)=>names.has(name)))fail(`RELEASE_PACKAGE_ENTRYPOINT_MISSING:${packagePrefix}:${target}`);
}
function escapeRegExp(value){return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
async function dependencyManifestExists(start,boundary,dependency){
  let cursor=path.resolve(start);const limit=path.resolve(boundary);
  while(cursor===limit||cursor.startsWith(`${limit}${path.sep}`)){
    const candidate=path.join(cursor,"node_modules",...dependency.split("/"),"package.json");
    try{const stat=await lstat(candidate);if(stat.isFile()&&!stat.isSymbolicLink())return true;}catch{}
    if(cursor===limit)break;cursor=path.dirname(cursor);
  }
  return false;
}

export async function inventory(rootValue, excludeManifest = false) {
  const root = path.resolve(rootValue); const result=[]; const pending=[root];let totalBytes=0;
  while (pending.length) {
    const current=pending.pop();
    for (const entry of await readdir(current,{withFileTypes:true})) {
      const full=path.join(current,entry.name); const stat=await lstat(full);
      if (stat.isSymbolicLink()) fail("RELEASE_REPARSE_REJECTED");
      if (stat.isDirectory()) { pending.push(full); continue; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail("RELEASE_FILE_INVALID");
      const relative=path.relative(root,full).split(path.sep).join("/");
      if (excludeManifest && relative === "release-manifest.json") continue;
      if (secretMaterialName(relative) && relative !== "deploy/local/new-signing-key.mjs") fail("RELEASE_SECRET_MATERIAL_REJECTED");
      totalBytes+=stat.size;if(totalBytes>MAX_RELEASE_BYTES)fail("RELEASE_TOTAL_BYTES_EXCEEDED");
      result.push({full,relative,size:stat.size}); if(result.length>MAX_FILES)fail("RELEASE_FILE_COUNT_EXCEEDED");
    }
  }
  return result.sort((a,b)=>a.relative.localeCompare(b.relative,"en"));
}
export async function fileSha256(file,expectedSize){
  const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.size>MAX_FILE_BYTES||(expectedSize!==undefined&&before.size!==expectedSize))fail("RELEASE_FILE_INVALID");
  const handle=await open(file,"r");let count=0;const hash=createHash("sha256");
  try{const opened=await handle.stat();if(!opened.isFile()||opened.size!==before.size)fail("RELEASE_FILE_CHANGED");for await(const chunk of handle.createReadStream({autoClose:false})){count+=chunk.length;if(count>MAX_FILE_BYTES||count>before.size)fail("RELEASE_FILE_INVALID");hash.update(chunk)}if(count!==before.size)fail("RELEASE_FILE_CHANGED");const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail("RELEASE_FILE_CHANGED");}
  finally{await handle.close()}
  const finalPath=await lstat(file);if(!finalPath.isFile()||finalPath.isSymbolicLink()||finalPath.size!==before.size||finalPath.mtimeMs!==before.mtimeMs)fail("RELEASE_FILE_CHANGED");return hash.digest("hex");
}
export async function hashInventory(files, concurrency=8){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>32)fail("RELEASE_HASH_CONCURRENCY_INVALID");
  const hashes={};let next=0;
  await Promise.all(Array.from({length:Math.min(concurrency,files.length)},async()=>{
    while(true){const index=next++;if(index>=files.length)return;const item=files[index];hashes[item.relative]=await fileSha256(item.full,item.size)}
  }));
  return hashes;
}
async function boundedRead(file,max){const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.size>max)fail("RELEASE_MANIFEST_INVALID");const handle=await open(file,"r");try{const opened=await handle.stat();if(!opened.isFile()||opened.size!==before.size)fail("RELEASE_MANIFEST_INVALID");const bytes=await handle.readFile();const after=await handle.stat();if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail("RELEASE_MANIFEST_INVALID");return bytes}finally{await handle.close()}}
function sha256(bytes){return createHash("sha256").update(bytes).digest("hex");}
function secretMaterialName(relative){
  const base=path.posix.basename(relative).toLowerCase();
  return /(^|\/)\.env(?:\.|$)/i.test(relative)||/^pgpass(?:\.|$)/.test(base)||/\.(?:key|pfx|p12)$/.test(base)||
    /^(?:\.?secrets?|.*[._-]secrets?)\.(?:txt|json|pem|der|bin|dat)$/.test(base)||/(?:^|[._-])(?:private|server|client|signing)[._-]?key(?:[._-]|$)/.test(base)||
    new Set([".npmrc",".yarnrc",".pypirc",".netrc","credentials.json"]).has(base);
}
function exactKeys(value,keys){if(!plainObject(value)||Object.keys(value).sort().join("|")!==[...keys].sort().join("|"))fail("RELEASE_MANIFEST_KEYS_INVALID");}
function plainObject(value){return typeof value==="object"&&value!==null&&!Array.isArray(value);}
function fail(code){throw new Error(code);}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args=new Map(process.argv.slice(2).map((arg)=>{const i=arg.indexOf("=");if(!arg.startsWith("--")||i<3)fail("ARGUMENT_INVALID");return[arg.slice(2,i),arg.slice(i+1)]}));
  const result=await verifyLocalRelease(args.get("root"),args.get("manifest-sha256"));
  process.stdout.write(`${JSON.stringify({event:"local-release.verified",releaseId:result.releaseId,targetPlatform:result.targetPlatform,targetArch:result.targetArch,nodeModulesAbi:result.nodeModulesAbi,migrationDigest:result.migrationDigest,manifestSha256:result.manifestSha256,fileCount:result.fileCount})}\n`);
}
