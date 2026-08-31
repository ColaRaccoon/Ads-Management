import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inventory } from "./verify-local-release.mjs";

const ENTRYPOINTS = Object.freeze([
  "api/dist/main.js","api/dist/auth/bootstrap-local-super-admin.cli.js","api/dist/staging/business-compatibility-smoke.cli.js","api/dist/staging/legacy-business-compatibility-smoke.cli.js","api/dist/staging/auth-role-matrix-smoke.cli.js","api/node_modules/prisma/build/index.js","web/server.js"
]);

export async function smokeLocalRelease(rootValue, releaseId) {
  const root=path.resolve(rootValue);
  if(!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId??""))fail("RELEASE_SMOKE_RELEASE_ID_INVALID");
  await inventory(root,true);
  for(const forbidden of ["api/src","web/src",".git"]){if(await exists(path.join(root,...forbidden.split("/"))))fail(`RELEASE_SMOKE_SOURCE_PRESENT:${forbidden}`)}
  for(const entry of ENTRYPOINTS){const result=await run(process.execPath,["--check",path.join(root,...entry.split("/"))],root,cleanEnv(),30_000);if(result.code!==0)fail(`RELEASE_SMOKE_SYNTAX_FAILED:${entry}`)}
  const failClosedEnv=cleanEnv({NODE_ENV:"production",APP_ENV:"production",DEPLOYMENT_MODE:"local_lan"});
  const configRequired="CONFIG_PATH is required for local_lan production";
  for(const [entry,markers] of [
    ["api/dist/main.js",[configRequired]],
    ["api/dist/auth/bootstrap-local-super-admin.cli.js",[configRequired,'"event":"local-bootstrap.failed","code":"BOOTSTRAP_FAILED"']],
    ["api/dist/staging/business-compatibility-smoke.cli.js",[configRequired,'"business-compatibility-smoke","result":"FAIL"']],
    ["api/dist/staging/legacy-business-compatibility-smoke.cli.js",[configRequired,'"legacy-business-compatibility-smoke","result":"FAIL"']]
  ]){const result=await run(process.execPath,[path.join(root,...entry.split("/"))],root,failClosedEnv,30_000);if(result.code===0||!markers.some((marker)=>result.output.includes(marker)))fail(`RELEASE_SMOKE_FAIL_CLOSED_REJECTED:${entry}`)}
  const matrix=await run(process.execPath,[path.join(root,"api/dist/staging/auth-role-matrix-smoke.cli.js")],root,cleanEnv({LOCAL_RELEASE_ID:releaseId}),120_000);
  if(matrix.code!==0||!matrix.output.includes('"event":"auth-role-matrix-smoke"'))fail("RELEASE_SMOKE_ROLE_MATRIX_FAILED");
  const prisma=await run(process.execPath,[path.join(root,"api/node_modules/prisma/build/index.js"),"--version"],root,cleanEnv(),60_000);
  if(prisma.code!==0||!/prisma/i.test(prisma.output))fail("RELEASE_SMOKE_PRISMA_CLI_FAILED");
  await smokeWeb(root);
  return Object.freeze({result:"PASS",contract:"source-free-cold-start-v1",entrypointCount:ENTRYPOINTS.length,apiFailClosed:true,roleMatrixExecuted:true,prismaCliExecuted:true,webLoopbackStarted:true});
}

async function smokeWeb(root){
  const port=await freePort();const child=spawn(process.execPath,[path.join(root,"web/server.js")],{cwd:path.join(root,"web"),env:cleanEnv({NODE_ENV:"production",HOSTNAME:"127.0.0.1",PORT:String(port)}),windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="";let bytes=0;let settled=false;let exitCode=null;
  const exited=new Promise((resolve,reject)=>{const collect=(chunk)=>{bytes+=chunk.length;if(bytes>1048576){child.kill();reject(new Error("RELEASE_SMOKE_OUTPUT_LIMIT"));return}output+=chunk.toString("utf8")};child.stdout.on("data",collect);child.stderr.on("data",collect);child.once("error",reject);child.once("exit",(code)=>{settled=true;exitCode=code;resolve()})});
  try{const deadline=Date.now()+45_000;let response=null;while(Date.now()<deadline&&!settled){try{response=await request(port);if(response.status>=200&&response.status<500)break}catch{}await delay(100)}if(!response||settled)fail(`RELEASE_SMOKE_WEB_START_FAILED:${exitCode??"NO_LISTENER"}`);if(!output.match(/ready|listening/i))fail("RELEASE_SMOKE_WEB_READY_MARKER_MISSING");}
  finally{if(!settled)child.kill();await Promise.race([exited.catch(()=>{}),delay(5_000)])}
}
function run(file,args,cwd,env,timeout){return new Promise((resolve,reject)=>{const child=spawn(file,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="";let bytes=0;let finished=false;const timer=setTimeout(()=>{if(!finished){child.kill();reject(new Error("RELEASE_SMOKE_TIMEOUT"))}},timeout);const collect=(chunk)=>{bytes+=chunk.length;if(bytes>1048576&&!finished){finished=true;clearTimeout(timer);child.kill();reject(new Error("RELEASE_SMOKE_OUTPUT_LIMIT"));return}output+=chunk.toString("utf8")};child.stdout.on("data",collect);child.stderr.on("data",collect);child.once("error",(error)=>{if(finished)return;finished=true;clearTimeout(timer);reject(error)});child.once("exit",(code)=>{if(finished)return;finished=true;clearTimeout(timer);resolve({code,output})})})}
function cleanEnv(extra={}){const env={};for(const key of ["SystemRoot","WINDIR","ComSpec","PATHEXT","PATH","TEMP","TMP"]){if(process.env[key])env[key]=process.env[key]}return{...env,...extra}}
function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.unref();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address();const port=typeof address==="object"&&address?address.port:0;server.close((error)=>error?reject(error):resolve(port))})})}
function request(port){return new Promise((resolve,reject)=>{const req=http.get({host:"127.0.0.1",port,path:"/",timeout:1000},(res)=>{res.resume();res.once("end",()=>resolve({status:res.statusCode??0}))});req.once("timeout",()=>req.destroy(new Error("timeout")));req.once("error",reject)})}
async function exists(value){try{await access(value);return true}catch{return false}}
function delay(ms){return new Promise((resolve)=>setTimeout(resolve,ms))}
function fail(code){throw new Error(code)}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href){const args=new Map(process.argv.slice(2).map((arg)=>{const i=arg.indexOf("=");if(!arg.startsWith("--")||i<3)fail("ARGUMENT_INVALID");return[arg.slice(2,i),arg.slice(i+1)]}));process.stdout.write(`${JSON.stringify(await smokeLocalRelease(args.get("root"),args.get("release-id")))}\n`)}
