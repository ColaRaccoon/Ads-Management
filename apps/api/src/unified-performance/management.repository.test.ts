import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {UnifiedManagementRepository} from "./management.repository";

test("report read budget preserves read-only RR and leaves adapter defaults unchanged",async()=>{
  const calls:any[]=[],statements:string[]=[];
  const prisma:any={$transaction:async(work:any,options:any)=>{calls.push(options);return work({$executeRaw:async(s:any)=>statements.push(s.sql)});}};
  const repository=new UnifiedManagementRepository(prisma);
  assert.equal(await repository.read(async()=>"source"),"source");
  assert.equal(await repository.read(async()=>"report",{timeoutMs:20000}),"report");
  assert.deepEqual(calls,[{isolationLevel:"RepeatableRead"},{isolationLevel:"RepeatableRead",timeout:20000}]);
  assert.deepEqual(statements,["SET TRANSACTION READ ONLY","SET TRANSACTION READ ONLY"]);
  for(const timeoutMs of [0,20001,Infinity,NaN,1.5]) assert.throws(()=>repository.read(async()=>null,{timeoutMs}),/UNIFIED_READ_TIMEOUT_INVALID/);
  assert.equal(calls.length,2);
});
