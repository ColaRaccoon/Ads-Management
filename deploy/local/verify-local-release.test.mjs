import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inventory, verifyLocalRelease, verifyRuntimeClosure } from "./verify-local-release.mjs";

test("inventory rejects an oversized sparse artifact before hashing it",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"local-release-oversized-"));const file=path.join(root,"oversized.bin");
  await writeFile(file,"");await truncate(file,1_073_741_825);await assert.rejects(()=>inventory(root),/RELEASE_FILE_INVALID/);
});

test("package and verify cover the complete release tree and reject extras",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"local-release-"));
  for(const name of [
    "api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/dist/staging/business-compatibility-smoke.cli.js","api/dist/staging/legacy-business-compatibility-smoke.cli.js","api/dist/staging/auth-role-matrix-smoke.cli.js","api/package.json","api/prisma/schema.prisma",
    "api/prisma/migrations/001_init/migration.sql","api/node_modules/pkg/index.js","api/node_modules/pkg/cli.js","api/node_modules/pkg/native/addon.node","api/node_modules/pkg/package.json",
    "api/node_modules/@prisma/client/package.json","api/node_modules/.prisma/client/package.json","api/node_modules/.prisma/client/query_engine-windows.dll.node","api/node_modules/prisma/package.json","api/node_modules/prisma/build/index.js","web/server.js","web/package.json",
    "web/.next/BUILD_ID","web/.next/required-server-files.json","web/.next/server/app.js",
    "web/.next/static/chunks/app.js","web/node_modules/pkg/index.js","web/node_modules/pkg/cli.js","web/node_modules/pkg/native/addon.node","web/node_modules/pkg/package.json",
    "deploy/local/launch-local-bundle.mjs","deploy/local/start-edge.mjs","deploy/local/https-edge.mjs",
    "deploy/local/runtime-config.mjs","deploy/local/api-config.mjs","deploy/local/verify-tls-material.mjs","deploy/local/verify-local-release.mjs","deploy/local/verify-runtime-readiness.mjs"
  ]){const full=path.join(root,...name.split("/"));await mkdir(path.dirname(full),{recursive:true});const dependencyPackage=name.endsWith("node_modules/pkg/package.json");const body=name.endsWith("package.json")?JSON.stringify(dependencyPackage?{name:"pkg",main:"./index.js",exports:{".":"./index.js"},bin:{pkg:"./cli.js"},binary:{module_path:"./native",module_name:"addon"},dependencies:{}}:{name:"fixture",dependencies:name==="api/package.json"||name==="web/package.json"?{pkg:"1.0.0"}:{}}):name.endsWith("required-server-files.json")?JSON.stringify({files:[".next/BUILD_ID",".next/server/app.js"]}):name.endsWith("index.js")?"module.exports='cold-start-ok';":name.endsWith("cli.js")?"process.stdout.write('cli-ok');":`fixture:${name}`;await writeFile(full,body);}
  const packaged=spawnSync(process.execPath,[path.join(import.meta.dirname,"package-local-release.mjs"),`--root=${root}`,"--release-id=release-test"],{encoding:"utf8"});
  assert.equal(packaged.status,0,packaged.stderr);const result=await verifyLocalRelease(root);assert.equal(result.releaseId,"release-test");
  assert.equal(spawnSync(process.execPath,["-e",`require(${JSON.stringify(path.join(root,"api/node_modules/pkg"))})`],{encoding:"utf8"}).status,0);
  const cli=spawnSync(process.execPath,[path.join(root,"api/node_modules/pkg/cli.js")],{encoding:"utf8"});assert.equal(cli.status,0);assert.equal(cli.stdout,"cli-ok");
  assert.equal(await exists(path.join(root,"api/src")),false);
  await writeFile(path.join(root,"api/node_modules/pkg/package.json"),JSON.stringify({name:"pkg",main:"./missing.js",dependencies:{}}));await assert.rejects(()=>verifyRuntimeClosure(root),/RELEASE_PACKAGE_ENTRYPOINT_MISSING:\.\/missing\.js/);
  await writeFile(path.join(root,"api/node_modules/pkg/package.json"),JSON.stringify({name:"pkg",main:"./index.js",exports:{".":"./index.js"},bin:{pkg:"./cli.js"},binary:{module_path:"./native",module_name:"addon"},dependencies:{}}));
  await writeFile(path.join(root,"unexpected.js"),"tamper");await assert.rejects(()=>verifyLocalRelease(root),/RELEASE_FILE_SET_MISMATCH/);
});

async function exists(candidate){try{await access(candidate);return true}catch{return false}}

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
