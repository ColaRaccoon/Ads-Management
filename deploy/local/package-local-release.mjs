import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inventory, hashInventory, REQUIRED_RELEASE_FILES, verifyLocalRelease, verifyRuntimeClosure, windowsHostBundleDigest, runtimeSmokeContractDigest } from "./verify-local-release.mjs";

export async function packageLocalRelease(rootValue,releaseId,{afterSmoke}={}){
  const root=path.resolve(rootValue??"");
  if(!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId))throw new Error("RELEASE_ID_INVALID");
  const filesBefore=await inventory(root,true);const byName=new Map(filesBefore.map((item)=>[item.relative,item]));
  for(const name of REQUIRED_RELEASE_FILES)if(!byName.has(name))throw new Error(`RELEASE_REQUIRED_FILE_MISSING:${name}`);
  await verifyRuntimeClosure(root,filesBefore);
  const hashesBefore=await hashInventory(filesBefore);
  await assertTrustedValidationScript(root,"deploy/local/smoke-local-release.mjs",path.join(import.meta.dirname,"smoke-local-release.mjs"));
  await assertTrustedValidationScript(root,"deploy/windows/Test-HostBundleSyntax.ps1",path.join(import.meta.dirname,"../windows/Test-HostBundleSyntax.ps1"));
  await verifyWindowsHostSyntax(root);
  await runStagedSmoke(root,releaseId);
  await afterSmoke?.(root);
  const filesAfter=await inventory(root,true);const hashesAfter=await hashInventory(filesAfter);
  assertUnchangedInventory(filesBefore,hashesBefore,filesAfter,hashesAfter);
  const migrationLines=Object.keys(hashesAfter).filter((name)=>/^api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name)).sort().map((name)=>`${name.slice("api/prisma/migrations/".length)}=${hashesAfter[name]}`);
  if(migrationLines.length===0)throw new Error("RELEASE_MIGRATIONS_MISSING");
  const migrationDigest=createHash("sha256").update(migrationLines.join("\n"),"utf8").digest("hex");
  const manifestPath=path.join(root,"release-manifest.json");let handle;
  try{handle=await open(manifestPath,"wx");await writeFile(handle,JSON.stringify({version:4,releaseId,targetPlatform:process.platform,targetArch:process.arch,nodeModulesAbi:process.versions.modules,migrationDigest,windowsHostBundleDigest:windowsHostBundleDigest(hashesAfter),runtimeSmokeContractDigest:runtimeSmokeContractDigest(hashesAfter),runtimeSmokeVerified:true,files:hashesAfter})+"\n",{encoding:"utf8"});}finally{await handle?.close();}
  return await verifyLocalRelease(root);
}

function assertUnchangedInventory(before,beforeHashes,after,afterHashes){
  if(before.length!==after.length)throw new Error("RELEASE_CHANGED_DURING_VALIDATION");
  for(let index=0;index<before.length;index++)if(before[index].relative!==after[index].relative||before[index].size!==after[index].size||beforeHashes[before[index].relative]!==afterHashes[after[index].relative])throw new Error("RELEASE_CHANGED_DURING_VALIDATION");
}
async function assertTrustedValidationScript(releaseRoot,relative,trustedPath){
  const staged=(await hashInventory([{full:path.join(releaseRoot,...relative.split("/")),relative,size:undefined}]))[relative];
  const trusted=(await hashInventory([{full:path.resolve(trustedPath),relative:"trusted",size:undefined}])).trusted;
  if(staged!==trusted)throw new Error(`RELEASE_VALIDATION_SCRIPT_UNTRUSTED:${relative}`);
}

async function verifyWindowsHostSyntax(releaseRoot){
  const parser=path.join(releaseRoot,"deploy/windows/Test-HostBundleSyntax.ps1");const hostRoot=path.dirname(parser);
  await new Promise((resolve,reject)=>{const child=spawn("pwsh",["-NoProfile","-NonInteractive","-File",parser,"-HostBundleRoot",hostRoot],{cwd:releaseRoot,windowsHide:true,stdio:["ignore","pipe","pipe"]});let bytes=0;let output="";const timer=setTimeout(()=>{child.kill();reject(new Error("RELEASE_WINDOWS_HOST_PARSE_TIMEOUT"));},120000);
    const collect=(chunk)=>{bytes+=chunk.length;if(bytes>1048576){child.kill();clearTimeout(timer);reject(new Error("RELEASE_WINDOWS_HOST_PARSE_OUTPUT_LIMIT"));return}output+=chunk.toString("utf8")};child.stdout.on("data",collect);child.stderr.on("data",collect);child.once("error",(error)=>{clearTimeout(timer);reject(new Error(`RELEASE_WINDOWS_HOST_PARSER_UNAVAILABLE:${error.code??"ERROR"}`))});child.once("exit",(code)=>{clearTimeout(timer);if(code!==0)return reject(new Error(`RELEASE_WINDOWS_HOST_PARSE_FAILED:${output.slice(0,256)}`));try{const result=JSON.parse(output.trim());if(result.result!=="PASS"||result.scriptCount<1)throw new Error();resolve()}catch{reject(new Error("RELEASE_WINDOWS_HOST_PARSE_OUTPUT_INVALID"))}});
  });
}
async function runStagedSmoke(releaseRoot,releaseId){
  const smoke=path.join(releaseRoot,"deploy/local/smoke-local-release.mjs");
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[smoke,`--root=${releaseRoot}`,`--release-id=${releaseId}`],{cwd:releaseRoot,windowsHide:true,stdio:["ignore","pipe","pipe"]});let bytes=0;let output="";const timer=setTimeout(()=>{child.kill();reject(new Error("RELEASE_RUNTIME_SMOKE_TIMEOUT"));},300000);const collect=(chunk)=>{bytes+=chunk.length;if(bytes>1048576){child.kill();clearTimeout(timer);reject(new Error("RELEASE_RUNTIME_SMOKE_OUTPUT_LIMIT"));return}output+=chunk.toString("utf8")};child.stdout.on("data",collect);child.stderr.on("data",collect);child.once("error",(error)=>{clearTimeout(timer);reject(error)});child.once("exit",(code)=>{clearTimeout(timer);if(code!==0)return reject(new Error(`RELEASE_RUNTIME_SMOKE_FAILED:${output.slice(0,256)}`));try{const result=JSON.parse(output.trim());if(result.result!=="PASS"||result.contract!=="source-free-cold-start-v1")throw new Error();resolve()}catch{reject(new Error("RELEASE_RUNTIME_SMOKE_OUTPUT_INVALID"))}})});
}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href){
  const args=new Map(process.argv.slice(2).map((arg)=>{const i=arg.indexOf("=");if(!arg.startsWith("--")||i<3)throw new Error("ARGUMENT_INVALID");return[arg.slice(2,i),arg.slice(i+1)]}));
  const releaseId=args.get("release-id")??"";const verified=await packageLocalRelease(args.get("root"),releaseId);
  process.stdout.write(`${JSON.stringify({event:"local-release.packaged",releaseId,manifestSha256:verified.manifestSha256,migrationDigest:verified.migrationDigest,fileCount:verified.fileCount})}\n`);
}
