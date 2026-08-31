import "reflect-metadata";
import { AppRole, InviteStatus, MatchType, Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { preloadApiEnvironment } from "../common/environment-preload";
import { MappingsService } from "../mappings/mappings.service";
import { LocalFileStorage } from "../storage/local-file-storage";

class RollbackMutationSmoke extends Error {}

async function run() {
  preloadApiEnvironment();
  const releaseId=process.env.LOCAL_RELEASE_ID?.trim()??"";
  if(!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(releaseId))throw new Error("COMPATIBILITY_RELEASE_ID_INVALID");
  const storageRoot=process.env.REPORT_STORAGE_DIR?.trim()??"";
  if(!storageRoot||!path.isAbsolute(storageRoot))throw new Error("COMPATIBILITY_STORAGE_ROOT_INVALID");
  const prisma=new PrismaClient();
  const storage=new LocalFileStorage(storageRoot);
  const runId=randomUUID();
  const username=`mutation_${runId}`;
  const storageKey=`compatibility/${runId}.bin`;
  const payload=Buffer.from("local-restore-mutation-smoke-v1","utf8");
  const payloadHash=createHash("sha256").update(payload).digest("hex");
  let stored=false;
  try{
    await prisma.$connect();
    const saved=await storage.put({key:storageKey,body:payload,expectedHashSha256:payloadHash,maxBytes:4096});
    stored=true;
    if(saved.hash!==payloadHash||saved.size!==payload.length)throw new Error("COMPATIBILITY_STORAGE_MUTATION_INVALID");
    try{
      await prisma.$transaction(async(tx)=>{
        const actor=await tx.appUser.create({data:{username,normalizedUsername:username,name:"Compatibility mutation actor",role:AppRole.USER,inviteStatus:InviteStatus.ACTIVE}});
        const product=await tx.product.create({data:{code:`MUT-${runId}`,name:"Compatibility mutation product",displayName:"Compatibility mutation product"}});
        const mappings=new MappingsService(transactionScopedPrisma(tx) as never);
        const rule=await mappings.createProductRule({productId:product.id,matchType:MatchType.CONTAINS,pattern:runId,priority:7,validFrom:"2026-01-01"},actor.id);
        if(rule.productId!==product.id||rule.patternKey!==runId||!rule.isActive)throw new Error("COMPATIBILITY_DATABASE_MUTATION_INVALID");
        const auditCount=await tx.securityAuditEvent.count({where:{actorUserId:actor.id,action:"META_MAPPING_RULE_CREATED",targetId:rule.id}});
        if(auditCount!==1)throw new Error("COMPATIBILITY_AUDIT_MUTATION_INVALID");
        throw new RollbackMutationSmoke();
      },{timeout:120_000});
      throw new Error("COMPATIBILITY_MUTATION_ROLLBACK_MISSING");
    }catch(error){if(!(error instanceof RollbackMutationSmoke))throw error}
    if(await prisma.appUser.count({where:{normalizedUsername:username}})!==0)throw new Error("COMPATIBILITY_DATABASE_ROLLBACK_FAILED");
    const restored=await storage.getStream(storageKey);const hash=createHash("sha256");for await(const chunk of restored.stream)hash.update(chunk);if(hash.digest("hex")!==payloadHash)throw new Error("COMPATIBILITY_STORAGE_HASH_INVALID");
    if(!await storage.delete(storageKey))throw new Error("COMPATIBILITY_STORAGE_DELETE_FAILED");stored=false;
    const digest=createHash("sha256").update(["mutation-smoke-v1",releaseId,"appUser:create-rollback","product:create-rollback","MappingsService.createProductRule:rollback","securityAuditEvent:append-rollback","LocalFileStorage:put-get-delete",payloadHash].join("\n")).digest("hex");
    process.stdout.write(`${JSON.stringify({event:"mutation-compatibility-smoke",releaseId,digest,databaseMutations:4,storageMutations:3,rollbackVerified:true,storageHashVerified:true})}\n`);
  }finally{
    if(stored)await storage.delete(storageKey).catch(()=>false);
    await prisma.$disconnect();
    payload.fill(0);
  }
}

function transactionScopedPrisma(tx:Prisma.TransactionClient){
  return new Proxy(tx as object,{get(target,property){if(property==="$transaction")return async(callback:(client:Prisma.TransactionClient)=>unknown)=>callback(tx);const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value}});
}

void run().catch(()=>{process.stderr.write('{"event":"mutation-compatibility-smoke","result":"FAIL"}\n');process.exitCode=1});
