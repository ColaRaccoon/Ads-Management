import "reflect-metadata";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { preloadApiEnvironment } from "../common/environment-preload";
import { PrismaService } from "../common/prisma.service";
import { assertSupabaseDatabaseBoundaryEvidenceV6 } from "../common/supabase-database-boundary-evidence";
import { SupabaseDatabaseTarget, validateSupabaseDatabaseTarget } from "../common/supabase-database-target";
import { loadAuthConfig } from "./auth.config";
import {
  BootstrapAuthorizationInput,
  loadBootstrapMutationAuthorization,
  loadBootstrapRequest
} from "./bootstrap-authorization";
import { BootstrapLocalSuperAdminService } from "./bootstrap-local-super-admin";

async function main() {
  preloadApiEnvironment();
  const args = parseArguments(process.argv.slice(2));
  const target = validateSupabaseDatabaseTarget(process.env);
  const apply = args.has("apply");
  const recovery = args.has("recover");
  const runtimeConfigPath = path.resolve(requiredArgument(args, "runtime-config-file"));
  if (runtimeConfigPath !== path.resolve(requiredEnvironment("LOCAL_RUNTIME_CONFIG_PATH"))) {
    throw new Error("BOOTSTRAP_RUNTIME_CONFIG_PATH_INVALID");
  }
  const tokenFile = path.resolve(requiredArgument(args, "setup-token-file"));
  const authorizationInput: BootstrapAuthorizationInput = {
    mode: recovery ? "recover" : "bootstrap",
    requestPath: path.resolve(requiredArgument(args, "bootstrap-request-file")),
    expectedRequestSha256: requiredArgument(args, "confirm-bootstrap-request-sha256"),
    authorizationPath: args.get("authorization-file"),
    expectedAuthorizationSha256: args.get("confirm-authorization-sha256"),
    authorizationPublicKeyPath: args.get("authorization-public-key-file"),
    expectedAuthorizationPublicKeySha256: args.get("confirm-authorization-public-key-sha256"),
    ledgerPath: args.get("authorization-ledger-file"),
    runtimeConfigPath,
    expectedRuntimeConfigSha256: requiredArgument(args, "confirm-runtime-config-sha256"),
    filesystemEvidencePath: path.resolve(requiredArgument(args, "filesystem-evidence-file")),
    expectedFilesystemEvidenceSha256: requiredArgument(args, "confirm-filesystem-evidence-sha256"),
    expectedFilesystemDescriptorDigest: requiredArgument(args, "confirm-filesystem-digest"),
    databaseBoundaryEvidencePath: path.resolve(requiredArgument(args, "database-boundary-evidence-file")),
    expectedDatabaseBoundaryEvidenceSha256: requiredArgument(args, "confirm-database-boundary-sha256"),
    setupTokenOutputPath: tokenFile,
    maintenanceEvidenceSha256: recovery ? requiredArgument(args, "confirm-maintenance-flag-sha256") : null,
    drainEvidenceSha256: recovery ? requiredArgument(args, "confirm-drain-state-sha256") : null,
    prechangeBackupEvidenceSha256: recovery ? requiredArgument(args, "confirm-latest-backup-sha256") : null,
    database: {
      projectRef: target.projectRef,
      connectionMode: target.connectionMode,
      host: target.host,
      port: Number(target.port),
      name: target.database,
      schema: target.schema
    },
    releaseId: requiredEnvironment("LOCAL_RELEASE_ID"),
    dataRoot: requiredEnvironment("APP_DATA_ROOT")
  };
  const mutationAuthorization = apply ? loadBootstrapMutationAuthorization(authorizationInput) : null;
  const authorizedRequest = mutationAuthorization ?? loadBootstrapRequest(authorizationInput);
  const username = authorizedRequest.username;
  process.stdout.write(`${JSON.stringify({
    event: "local-bootstrap.plan",
    databaseProvider: "supabase_postgres",
    databaseProjectRef: target.projectRef,
    databaseHost: target.host,
    databasePort: target.port,
    databaseName: target.database,
    databaseSchema: target.schema,
    usersToCreate: recovery ? 0 : 1,
    setupTokensToReissue: recovery ? 1 : 0,
    mode: apply ? "apply" : "dry-run"
  })}\n`);

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new BootstrapLocalSuperAdminService(prisma, loadAuthConfig());
    const recoveryInspection = recovery ? await service.inspectRecovery(username) : null;
    const canProceed = recovery ? recoveryInspection?.canRecover : (await service.inspect(username)).canApply;
    if (!canProceed) throw new Error("BOOTSTRAP_STATE_REJECTED");
    if (!apply) {
      process.stdout.write(`${JSON.stringify({ event: "local-bootstrap.dry-run-complete", plannedUsers: recovery ? 0 : 1, plannedTokenReissues: recovery ? 1 : 0 })}\n`);
      return;
    }
    requireConfirmation(args, "confirm-db-host", target.host);
    requireConfirmation(args, "confirm-project-ref", target.projectRef);
    requireConfirmation(args, "confirm-db-name", target.database);
    requireConfirmation(args, "confirm-db-schema", target.schema);
    assertDatabaseBoundaryEvidence(authorizationInput.databaseBoundaryEvidencePath,authorizationInput.expectedDatabaseBoundaryEvidenceSha256,target);
    if (recoveryInspection?.recoveryKind === "ACTIVE_BREAK_GLASS") {
      assertBreakGlassOperationalEvidence(args, target, authorizationInput.dataRoot, authorizationInput.releaseId,runtimeConfigPath);
    }
    let handle: number | undefined;
    let committed = false;
    try {
      const setupToken = randomBytes(32).toString("base64url");
      const consume = async () => {
        if (!mutationAuthorization) throw new Error("BOOTSTRAP_AUTHORIZATION_REQUIRED");
        mutationAuthorization.consume();
        handle = openSync(tokenFile, "wx", 0o600);
        writeFileSync(handle, JSON.stringify({
          version: 1,
          purpose: recoveryInspection?.recoveryKind === "ACTIVE_BREAK_GLASS" ? "SUPER_ADMIN_RECOVERY" : "INITIAL_SETUP",
          setupToken,
          expiresAt: new Date(Date.now() + loadAuthConfig().localSetupTokenTtlMs).toISOString()
        }), { encoding: "utf8" });
      };
      if (recovery) await service.recover(username, setupToken, consume);
      else await service.apply(username, setupToken, consume);
      committed = true;
    } finally {
      if (handle !== undefined) closeSync(handle);
      if (!committed) {
        try { unlinkSync(tokenFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    process.stdout.write(`${JSON.stringify({ event: "local-bootstrap.complete", usersCreated: recovery ? 0 : 1, setupTokensReissued: recovery ? 1 : 0 })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function assertBreakGlassOperationalEvidence(args: Map<string,string>, target: SupabaseDatabaseTarget, dataRoot: string, releaseId: string,runtimeConfigEnvironmentPath:string) {
  const approvalId=requiredArgument(args,"approval-id");
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(approvalId)) throw new Error("BREAK_GLASS_APPROVAL_ID_INVALID");
  const maintenancePath=path.resolve(requiredArgument(args,"maintenance-flag-file"));
  const drainPath=path.resolve(requiredArgument(args,"drain-state-file"));
  const backupPath=path.resolve(requiredArgument(args,"latest-backup-evidence-file"));
  const publicKeyPath=path.resolve(requiredArgument(args,"backup-receipt-public-key-file"));
  const runtimeConfigPath=path.resolve(requiredArgument(args,"runtime-config-file"));
  if(runtimeConfigPath!==path.resolve(runtimeConfigEnvironmentPath))throw new Error("BREAK_GLASS_RUNTIME_CONFIG_PATH_INVALID");
  const runtime=readHashedJsonEvidence(runtimeConfigPath,requiredArgument(args,"confirm-runtime-config-sha256"));
  const runtimeDatabase=runtime.database as Record<string,unknown>|undefined,runtimeBackup=runtime.backup as Record<string,unknown>|undefined,runtimeRelease=runtime.release as Record<string,unknown>|undefined,runtimeData=runtime.data as Record<string,unknown>|undefined;
  if(path.resolve(String(runtimeData?.root??""))!==path.resolve(dataRoot)||runtimeRelease?.id!==releaseId||runtimeDatabase?.provider!=="supabase_postgres"||runtimeDatabase.projectRef!==target.projectRef||runtimeDatabase.host!==target.host||runtimeDatabase.port!==5432||runtimeDatabase.name!==target.database||runtimeDatabase.schema!==target.schema||path.resolve(String(runtimeBackup?.latestBackupEvidencePath??""))!==backupPath||path.resolve(String(runtimeBackup?.backupReceiptPublicKeyPath??""))!==publicKeyPath)throw new Error("BREAK_GLASS_RUNTIME_BINDING_REJECTED");
  if(maintenancePath!==path.resolve(dataRoot,"runtime-control","maintenance.enabled")||drainPath!==path.resolve(dataRoot,"logs","edge","drain-state.json")||path.dirname(backupPath)!==path.resolve(dataRoot,"backup-receipt")) throw new Error("BREAK_GLASS_EVIDENCE_PATH_INVALID");
  const maintenance=readHashedJsonEvidence(maintenancePath,requiredArgument(args,"confirm-maintenance-flag-sha256"));
  const drain=readHashedJsonEvidence(drainPath,requiredArgument(args,"confirm-drain-state-sha256"));
  const backup=readHashedJsonEvidence(backupPath,requiredArgument(args,"confirm-latest-backup-sha256"));
  const now=Date.now(),maintenanceAt=Date.parse(String(maintenance.enabledAt??"")),drainAt=Date.parse(String(drain.completedAt??"")),backupAt=Date.parse(String(backup.completedAt??""));
  const approvalDigest=createHash("sha256").update(approvalId,"utf8").digest("hex");
  if(maintenance.version!==1||maintenance.enabled!==true||maintenance.releaseId!==releaseId||maintenance.approvalIdDigest!==approvalDigest||!fresh(maintenanceAt,now,24*3600_000)) throw new Error("BREAK_GLASS_MAINTENANCE_REJECTED");
  if(drain.version!==1||drain.result!=="DRAINED"||drain.activeRequests!==0||!Number.isInteger(drain.processId)||!fresh(drainAt,now,30_000)||!processExists(Number(drain.processId))) throw new Error("BREAK_GLASS_DRAIN_REJECTED");
  if(backup.version!==6||backup.signerIndependentArtifactVerification!==true||!/^[0-9a-f]{64}$/.test(String(backup.artifactVerificationDigest??""))||backup.attestationType!=="backup-latest"||backup.result!=="COMPLETE"||backup.databaseProjectRef!==target.projectRef||backup.databaseHost!==target.host||backup.databasePort!==5432||backup.databaseName!==target.database||backup.databaseSchema!==target.schema||backup.backupId!==requiredArgument(args,"prechange-backup-id")||!fresh(backupAt,now,24*3600_000)) throw new Error("BREAK_GLASS_BACKUP_REJECTED");
  assertSignedAttestation(backup,publicKeyPath);
}

function readHashedJsonEvidence(value:string,expectedSha256:string){
  if(!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("BREAK_GLASS_EVIDENCE_HASH_INVALID");
  assertNoReparseComponents(value);const stat=lstatSync(value);if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>1024*1024)throw new Error("BREAK_GLASS_EVIDENCE_FILE_INVALID");
  const bytes=readFileSync(value);if(createHash("sha256").update(bytes).digest("hex")!==expectedSha256)throw new Error("BREAK_GLASS_EVIDENCE_HASH_MISMATCH");
  return JSON.parse(bytes.toString("utf8")) as Record<string,unknown>;
}
function assertSignedAttestation(evidence:Record<string,unknown>,publicKeyPath:string){
  assertNoReparseComponents(publicKeyPath);const stat=lstatSync(publicKeyPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<32||stat.size>16384)throw new Error("BREAK_GLASS_BACKUP_KEY_INVALID");
  const key=createPublicKey(readFileSync(publicKeyPath));if(key.asymmetricKeyType!=="ed25519")throw new Error("BREAK_GLASS_BACKUP_KEY_INVALID");
  const publicDer=key.export({type:"spki",format:"der"});if(createHash("sha256").update(publicDer).digest("hex")!==evidence.signingKeyId||typeof evidence.attestationSignature!=="string")throw new Error("BREAK_GLASS_BACKUP_SIGNATURE_INVALID");
  const unsigned={...evidence};delete unsigned.signingKeyId;delete unsigned.attestationSignature;
  if(!verify(null,Buffer.from(canonicalJson(unsigned),"utf8"),key,Buffer.from(evidence.attestationSignature,"base64url")))throw new Error("BREAK_GLASS_BACKUP_SIGNATURE_INVALID");
}
function canonicalJson(value:unknown):string{if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;if(value&&typeof value==="object"){const record=value as Record<string,unknown>;return`{${Object.keys(record).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;}return JSON.stringify(value)??"null";}
function fresh(timestamp:number,now:number,maxAge:number){return Number.isFinite(timestamp)&&timestamp<=now+5*60_000&&timestamp>=now-maxAge;}
function processExists(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}

function assertDatabaseBoundaryEvidence(value: string, expectedSha256: string, target: SupabaseDatabaseTarget) {
  if (!path.isAbsolute(value) || expectedSha256 !== expectedSha256.toLowerCase() || !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("DATABASE_BOUNDARY_EVIDENCE_CONFIRMATION_INVALID");
  const evidencePath=path.resolve(value);assertNoReparseComponents(evidencePath);const stat=lstatSync(evidencePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024){throw new Error("DATABASE_BOUNDARY_EVIDENCE_INVALID");}
  const bytes=readFileSync(evidencePath);if(createHash("sha256").update(bytes).digest("hex")!==expectedSha256){throw new Error("DATABASE_BOUNDARY_EVIDENCE_HASH_MISMATCH");}
  const caPath=path.resolve(target.caCertificatePath);assertNoReparseComponents(caPath);const caStat=lstatSync(caPath);
  if(!caStat.isFile()||caStat.isSymbolicLink()||caStat.size===0||caStat.size>1024*1024)throw new Error("DATABASE_CA_CERTIFICATE_INVALID");
  assertSupabaseDatabaseBoundaryEvidenceV6(JSON.parse(bytes.toString("utf8")),{
    projectRef:target.projectRef,connectionMode:target.connectionMode,host:target.host,databaseName:target.database,
    databaseSchema:target.schema,runtimeUser:target.runtimeUser,
    caCertificateSha256:createHash("sha256").update(readFileSync(caPath)).digest("hex")
  });
}

function assertNoReparseComponents(target: string) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("BOOTSTRAP_HANDOFF_REPARSE_REJECTED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArguments(argv: string[]) {
  const parsed = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error("Arguments must use --name=value format.");
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    if (name === "username") throw new Error("BOOTSTRAP_USERNAME_ARGV_FORBIDDEN");
    if (parsed.has(name)) throw new Error("BOOTSTRAP_ARGUMENT_DUPLICATE");
    if (separator === -1) parsed.set(name, "true");
    else parsed.set(name, argument.slice(separator + 1));
  }
  return parsed;
}

function requiredArgument(args: Map<string, string>, name: string) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name}=... is required.`);
  return value;
}

function requireConfirmation(args: Map<string, string>, name: string, expected: string) {
  if (args.get(name) !== expected) throw new Error(`--${name} does not match the inspected target.`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "local-bootstrap.failed", code: "BOOTSTRAP_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
