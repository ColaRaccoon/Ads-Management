import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inventory, verifyLocalRelease, verifyRuntimeClosure, WINDOWS_HOST_FILES } from "./verify-local-release.mjs";
import { smokeLocalRelease } from "./smoke-local-release.mjs";
import { packageLocalRelease } from "./package-local-release.mjs";

test("inventory rejects an oversized sparse artifact before hashing it",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"local-release-oversized-"));const file=path.join(root,"oversized.bin");
  try { await writeFile(file,"");await truncate(file,1_073_741_825);await assert.rejects(()=>inventory(root),/RELEASE_FILE_INVALID/); }
  finally { await rm(root,{recursive:true,force:true}); }
});

test("inventory permits runtime private-field helpers but rejects actual secret material",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"local-release-secret-name-"));
  try{
    await mkdir(path.join(root,"node_modules","runtime"),{recursive:true});
    await writeFile(path.join(root,"node_modules","runtime","classPrivateFieldGet.js"),"module.exports=1;");
    assert.equal((await inventory(root)).length,1);
    await writeFile(path.join(root,"node_modules","runtime","signing-private-key.pem"),"not-a-real-key");
    await assert.rejects(()=>inventory(root),/RELEASE_SECRET_MATERIAL_REJECTED/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("package and verify cover the complete release tree and reject extras",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"local-release-"));
  for(const name of [
    "api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/dist/staging/business-compatibility-smoke.cli.js","api/dist/staging/legacy-business-compatibility-smoke.cli.js","api/dist/staging/auth-role-matrix-smoke.cli.js","api/package.json","api/prisma/schema.prisma",
    "api/prisma/migrations/001_init/migration.sql","api/node_modules/pkg/index.js","api/node_modules/pkg/cli.js","api/node_modules/pkg/native/addon.node","api/node_modules/pkg/package.json",
    "api/node_modules/@prisma/client/package.json","api/node_modules/@prisma/client/index.js","api/node_modules/.prisma/client/package.json","api/node_modules/.prisma/client/index.js","api/node_modules/.prisma/client/query_engine-windows.dll.node","api/node_modules/prisma/package.json","api/node_modules/prisma/index.js","api/node_modules/prisma/build/index.js","web/server.js","web/package.json",
    "web/.next/BUILD_ID","web/.next/required-server-files.json","web/.next/server/app.js",
    "web/.next/static/chunks/app.js","web/node_modules/pkg/index.js","web/node_modules/pkg/cli.js","web/node_modules/pkg/native/addon.node","web/node_modules/pkg/package.json",
    "deploy/local/launch-local-bundle.mjs","deploy/local/start-edge.mjs","deploy/local/https-edge.mjs",
    "deploy/local/runtime-config.mjs","deploy/local/api-config.mjs","deploy/local/verify-tls-material.mjs","deploy/local/verify-local-release.mjs","deploy/local/verify-runtime-readiness.mjs","deploy/local/verify-attestation.mjs","deploy/local/verify-https-release.mjs","deploy/local/smoke-local-release.mjs",...WINDOWS_HOST_FILES
  ]){const full=path.join(root,...name.split("/"));await mkdir(path.dirname(full),{recursive:true});const dependencyPackage=name.endsWith("node_modules/pkg/package.json");const body=name.endsWith("package.json")?JSON.stringify(dependencyPackage?{name:"pkg",main:"./index.js",exports:{".":"./index.js","./optional-platform":"./not-shipped-optional.js"},bin:{pkg:"./cli.js"},binary:{module_path:"./native",module_name:"addon"},dependencies:{}}:{name:"fixture",dependencies:name==="api/package.json"||name==="web/package.json"?{pkg:"1.0.0"}:{}}):name.endsWith("required-server-files.json")?JSON.stringify({files:[".next\\BUILD_ID",".next/server/app.js"]}):name.endsWith("Test-HostBundleSyntax.ps1")?await readFixtureParser():name==="deploy/local/smoke-local-release.mjs"?await readFixtureSmoke():name.endsWith(".ps1")?"# fixture\n":name.endsWith(".xml.template")?"<service/>\n":fixtureJavaScript(name);await writeFile(full,body);}
  await mkdir(path.join(root,"api/node_modules/pkg/templates"),{recursive:true});
  await writeFile(path.join(root,"api/node_modules/pkg/templates/package.json"),JSON.stringify({name:"non-package-template",main:"./not-shipped.js"}));
  const packaged=spawnSync(process.execPath,[path.join(import.meta.dirname,"package-local-release.mjs"),`--root=${root}`,"--release-id=release-test"],{encoding:"utf8"});
  assert.equal(packaged.status,0,packaged.stderr);const result=await verifyLocalRelease(root);assert.equal(result.releaseId,"release-test");
  const manifestPath=path.join(root,"release-manifest.json"),manifestBytes=await readFile(manifestPath),legacyManifest={...JSON.parse(manifestBytes.toString("utf8")),version:3};await writeFile(manifestPath,JSON.stringify(legacyManifest));await assert.rejects(()=>verifyLocalRelease(root),/RELEASE_MANIFEST_INVALID/);await writeFile(manifestPath,manifestBytes);
  assert.equal(spawnSync(process.execPath,["-e",`require(${JSON.stringify(path.join(root,"api/node_modules/pkg"))})`],{encoding:"utf8"}).status,0);
  const cli=spawnSync(process.execPath,[path.join(root,"api/node_modules/pkg/cli.js")],{encoding:"utf8"});assert.equal(cli.status,0);assert.equal(cli.stdout,"cli-ok");
  assert.equal(await exists(path.join(root,"api/src")),false);
  await writeFile(path.join(root,"api/node_modules/pkg/package.json"),JSON.stringify({name:"pkg",main:"./missing.js",dependencies:{}}));await assert.rejects(()=>verifyRuntimeClosure(root),/RELEASE_PACKAGE_ENTRYPOINT_MISSING:.*:\.\/missing\.js/);
  await writeFile(path.join(root,"api/node_modules/pkg/package.json"),JSON.stringify({name:"pkg",dependencies:{}}));await rm(path.join(root,"api/node_modules/pkg/index.js"));await assert.rejects(()=>verifyRuntimeClosure(root),/RELEASE_PACKAGE_ENTRYPOINT_MISSING:.*:\.\/index\.js/);
  await writeFile(path.join(root,"api/node_modules/pkg/index.js"),"module.exports='source-free-default-entrypoint-ok';");assert.equal(spawnSync(process.execPath,["-e",`require(${JSON.stringify(path.join(root,"api/node_modules/pkg"))})`],{encoding:"utf8"}).status,0);
  await writeFile(path.join(root,"api/node_modules/pkg/package.json"),JSON.stringify({name:"pkg",main:"./index.js",exports:{".":"./index.js"},bin:{pkg:"./cli.js"},binary:{module_path:"./native",module_name:"addon"},dependencies:{}}));
  const removedHost=path.join(root,"deploy/windows/nas-identity.ps1");await rm(removedHost);await assert.rejects(()=>verifyRuntimeClosure(root),/RELEASE_REQUIRED_FILE_MISSING:deploy\/windows\/nas-identity\.ps1/);await writeFile(removedHost,"# restored fixture\n");
  const unexpectedHost=path.join(root,"deploy/windows/unexpected.ps1");await writeFile(unexpectedHost,"# unexpected\n");await assert.rejects(()=>verifyRuntimeClosure(root),/RELEASE_WINDOWS_HOST_FILE_SET_MISMATCH/);await rm(unexpectedHost);
  const forbidden=path.join(root,"api/dist/auth/bootstrap-super-admin.cli.js");await writeFile(forbidden,"process.exitCode=1;");await assert.rejects(()=>verifyRuntimeClosure(root),/RELEASE_FORBIDDEN_LEGACY_AUTH_EXECUTABLE/);await rm(forbidden);
  const mainPath=path.join(root,"api/dist/main.js");const goodMain=await (await import("node:fs/promises")).readFile(mainPath,"utf8");await writeFile(mainPath,"function broken( {\n");await assert.rejects(()=>smokeLocalRelease(root,"release-test"),/RELEASE_SMOKE_SYNTAX_FAILED:api\/dist\/main\.js/);await writeFile(mainPath,goodMain);
  await writeFile(path.join(root,"unexpected.js"),"tamper");await assert.rejects(()=>verifyLocalRelease(root),/RELEASE_FILE_SET_MISMATCH/);
});

test("package refuses mutation after smoke and before final hashing",async()=>{
  const root=await createCompleteFixture();
  try{
    await assert.rejects(()=>packageLocalRelease(root,"release-race",{afterSmoke:async(candidate)=>{await writeFile(path.join(candidate,"api/dist/main.js"),"// changed after smoke\n")}}),/RELEASE_CHANGED_DURING_VALIDATION/);
    assert.equal(await exists(path.join(root,"release-manifest.json")),false);
  }finally{await rm(root,{recursive:true,force:true})}
});

async function exists(candidate){try{await access(candidate);return true}catch{return false}}
async function readFixtureParser(){return await (await import("node:fs/promises")).readFile(path.join(import.meta.dirname,"../windows/Test-HostBundleSyntax.ps1"),"utf8")}
async function readFixtureSmoke(){return await (await import("node:fs/promises")).readFile(path.join(import.meta.dirname,"smoke-local-release.mjs"),"utf8")}
function fixtureJavaScript(name){
  if(name==="api/dist/main.js")return`process.stderr.write("CONFIG_PATH is required for local_lan production");process.exit(1);`;
  if(name==="api/dist/auth/bootstrap-local-super-admin.cli.js")return`process.stderr.write('{"event":"local-bootstrap.failed","code":"BOOTSTRAP_FAILED"}');process.exit(1);`;
  if(name==="api/dist/staging/business-compatibility-smoke.cli.js")return`process.stderr.write('{"event":"business-compatibility-smoke","result":"FAIL"}');process.exit(1);`;
  if(name==="api/dist/staging/legacy-business-compatibility-smoke.cli.js")return`process.stderr.write('{"event":"legacy-business-compatibility-smoke","result":"FAIL"}');process.exit(1);`;
  if(name==="api/dist/staging/auth-role-matrix-smoke.cli.js")return`process.stdout.write('{"event":"auth-role-matrix-smoke","result":"PASS"}');`;
  if(name==="api/node_modules/prisma/build/index.js")return`process.stdout.write('prisma fixture');`;
  if(name==="web/server.js")return`const http=require('node:http');const server=http.createServer((_q,r)=>{r.statusCode=200;r.end('ok')});server.listen(Number(process.env.PORT),'127.0.0.1',()=>process.stdout.write('Ready'));`;
  if(name.endsWith("index.js"))return"module.exports='cold-start-ok';";
  if(name.endsWith("cli.js"))return"process.stdout.write('cli-ok');";
  return`// fixture:${name}\n`;
}

async function createCompleteFixture(){
  const root=await mkdtemp(path.join(tmpdir(),"local-release-race-"));
  for(const name of ["api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/dist/staging/business-compatibility-smoke.cli.js","api/dist/staging/legacy-business-compatibility-smoke.cli.js","api/dist/staging/auth-role-matrix-smoke.cli.js","api/package.json","api/prisma/schema.prisma","api/prisma/migrations/001_init/migration.sql","api/node_modules/pkg/index.js","api/node_modules/pkg/package.json","api/node_modules/@prisma/client/package.json","api/node_modules/@prisma/client/index.js","api/node_modules/.prisma/client/package.json","api/node_modules/.prisma/client/index.js","api/node_modules/.prisma/client/query_engine-windows.dll.node","api/node_modules/prisma/package.json","api/node_modules/prisma/index.js","api/node_modules/prisma/build/index.js","web/server.js","web/package.json","web/.next/BUILD_ID","web/.next/required-server-files.json","web/.next/server/app.js","web/.next/static/chunks/app.js","web/node_modules/pkg/index.js","web/node_modules/pkg/package.json","deploy/local/launch-local-bundle.mjs","deploy/local/start-edge.mjs","deploy/local/https-edge.mjs","deploy/local/runtime-config.mjs","deploy/local/api-config.mjs","deploy/local/verify-tls-material.mjs","deploy/local/verify-local-release.mjs","deploy/local/verify-runtime-readiness.mjs","deploy/local/verify-attestation.mjs","deploy/local/verify-https-release.mjs","deploy/local/smoke-local-release.mjs",...WINDOWS_HOST_FILES]){
    const full=path.join(root,...name.split("/"));await mkdir(path.dirname(full),{recursive:true});const dependencyPackage=name.endsWith("node_modules/pkg/package.json");const body=name.endsWith("package.json")?JSON.stringify(dependencyPackage?{name:"pkg",dependencies:{}}:{name:"fixture",dependencies:name==="api/package.json"||name==="web/package.json"?{pkg:"1.0.0"}:{}}):name.endsWith("required-server-files.json")?JSON.stringify({files:[".next/BUILD_ID",".next/server/app.js"]}):name.endsWith("Test-HostBundleSyntax.ps1")?await readFixtureParser():name==="deploy/local/smoke-local-release.mjs"?await readFixtureSmoke():name.endsWith(".ps1")?"# fixture\n":name.endsWith(".xml.template")?"<service/>\n":fixtureJavaScript(name);await writeFile(full,body);
  }
  return root;
}

test("package refuses a release missing an edge dependency or Next static assets",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"local-release-incomplete-"));
  for(const name of [
    "api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/package.json","api/prisma/schema.prisma",
    "api/prisma/migrations/001_init/migration.sql","api/node_modules/pkg/index.js","web/server.js",
    "web/.next/BUILD_ID","web/.next/required-server-files.json","web/.next/server/app.js",
    "web/node_modules/pkg/index.js","deploy/local/launch-local-bundle.mjs","deploy/local/start-edge.mjs",
    "deploy/local/https-edge.mjs","deploy/local/runtime-config.mjs","deploy/local/api-config.mjs"
  ]){const full=path.join(root,...name.split("/"));await mkdir(path.dirname(full),{recursive:true});await writeFile(full,`fixture:${name}`);}
  const packaged=spawnSync(process.execPath,[path.join(import.meta.dirname,"package-local-release.mjs"),`--root=${root}`,"--release-id=release-test"],{encoding:"utf8"});
  assert.notEqual(packaged.status,0);
  assert.match(packaged.stderr,/RELEASE_REQUIRED_FILE_MISSING:/);
});
