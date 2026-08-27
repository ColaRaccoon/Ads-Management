import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { inventory, fileSha256, REQUIRED_RELEASE_FILES, verifyLocalRelease, verifyRuntimeClosure } from "./verify-local-release.mjs";

const args=new Map(process.argv.slice(2).map((arg)=>{const i=arg.indexOf("=");if(!arg.startsWith("--")||i<3)throw new Error("ARGUMENT_INVALID");return[arg.slice(2,i),arg.slice(i+1)]}));
const root=path.resolve(args.get("root")??"");const releaseId=args.get("release-id")??"";
if(!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId))throw new Error("RELEASE_ID_INVALID");
const files=await inventory(root,true);const byName=new Map(files.map((item)=>[item.relative,item]));
for(const name of REQUIRED_RELEASE_FILES)if(!byName.has(name))throw new Error(`RELEASE_REQUIRED_FILE_MISSING:${name}`);
await verifyRuntimeClosure(root,files);
const hashes={};for(const item of files)hashes[item.relative]=await fileSha256(item.full);
const migrationLines=Object.keys(hashes).filter((name)=>/^api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(name)).sort().map((name)=>`${name.slice("api/prisma/migrations/".length)}=${hashes[name]}`);
if(migrationLines.length===0)throw new Error("RELEASE_MIGRATIONS_MISSING");
const migrationDigest=createHash("sha256").update(migrationLines.join("\n"),"utf8").digest("hex");
const manifestPath=path.join(root,"release-manifest.json");let handle;
try{handle=await open(manifestPath,"wx");await writeFile(handle,JSON.stringify({version:3,releaseId,targetPlatform:process.platform,targetArch:process.arch,nodeModulesAbi:process.versions.modules,migrationDigest,files:hashes})+"\n",{encoding:"utf8"});}finally{await handle?.close();}
const verified=await verifyLocalRelease(root);
process.stdout.write(`${JSON.stringify({event:"local-release.packaged",releaseId,manifestSha256:verified.manifestSha256,migrationDigest,fileCount:verified.fileCount})}\n`);
