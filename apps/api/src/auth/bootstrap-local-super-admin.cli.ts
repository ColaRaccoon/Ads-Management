import "reflect-metadata";
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { preloadApiEnvironment } from "../common/environment-preload";
import { PrismaService } from "../common/prisma.service";
import { assertSupabaseDatabaseBoundaryEvidenceV6 } from "../common/supabase-database-boundary-evidence";
import { SupabaseDatabaseTarget, validateSupabaseDatabaseTarget } from "../common/supabase-database-target";
import { loadAuthConfig } from "./auth.config";
import { BootstrapLocalSuperAdminService } from "./bootstrap-local-super-admin";

async function main() {
  preloadApiEnvironment();
  const args = parseArguments(process.argv.slice(2));
  const username = requiredArgument(args, "username");
  const target = validateSupabaseDatabaseTarget(process.env);
  const apply = args.has("apply");
  const recovery = args.has("recover");
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
    assertDatabaseBoundaryEvidence(requiredArgument(args,"database-boundary-evidence-file"),requiredArgument(args,"confirm-database-boundary-sha256"),target);
    if (recoveryInspection?.recoveryKind === "ACTIVE_BREAK_GLASS") {
      assertBreakGlassOperationalEvidence(args, target, requiredEnvironment("APP_DATA_ROOT"), requiredEnvironment("LOCAL_RELEASE_ID"),requiredEnvironment("LOCAL_RUNTIME_CONFIG_PATH"));
    }
    const tokenFile = approvedTokenPath(
      requiredArgument(args, "setup-token-file"),
      requiredEnvironment("APP_DATA_ROOT"),
      requiredArgument(args, "filesystem-evidence-file"),
      requiredArgument(args, "confirm-filesystem-digest")
    );
    const handle = openSync(tokenFile, "wx", 0o600);
    let committed = false;
    try {
      const setupToken = randomBytes(32).toString("base64url");
      writeFileSync(handle, JSON.stringify({
        version: 1,
        purpose: recoveryInspection?.recoveryKind === "ACTIVE_BREAK_GLASS" ? "SUPER_ADMIN_RECOVERY" : "INITIAL_SETUP",
        setupToken,
        expiresAt: new Date(Date.now() + loadAuthConfig().localSetupTokenTtlMs).toISOString()
      }), { encoding: "utf8" });
      if (recovery) await service.recover(username, setupToken);
      else await service.apply(username, setupToken);
      committed = true;
    } finally {
      closeSync(handle);
      if (!committed) unlinkSync(tokenFile);
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
  if(backup.version!==5||backup.attestationType!=="backup-latest"||backup.result!=="COMPLETE"||backup.databaseProjectRef!==target.projectRef||backup.databaseHost!==target.host||backup.databasePort!==5432||backup.databaseName!==target.database||backup.databaseSchema!==target.schema||backup.backupId!==requiredArgument(args,"prechange-backup-id")||!fresh(backupAt,now,24*3600_000)) throw new Error("BREAK_GLASS_BACKUP_REJECTED");
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

function approvedTokenPath(value: string, dataRootValue: string, evidencePathValue: string, expectedDigest: string) {
  if (!path.isAbsolute(value)) throw new Error("--setup-token-file must be absolute.");
  const resolved = path.resolve(value);
  const handoffRoot = path.resolve(dataRootValue, "bootstrap-handoff");
  if (path.dirname(resolved) !== handoffRoot) {
    throw new Error("--setup-token-file must be directly below APP_DATA_ROOT/bootstrap-handoff.");
  }
  assertNoReparseComponents(handoffRoot);
  const root = lstatSync(handoffRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("BOOTSTRAP_HANDOFF_ROOT_INVALID");
  const evidencePath = path.resolve(evidencePathValue);
  const evidenceStat = lstatSync(evidencePath);
  if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.size > 64 * 1024) {
    throw new Error("FILESYSTEM_EVIDENCE_INVALID");
  }
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
    result?: string; dataRoot?: string; descriptorDigest?: string; completedAt?: string;
    classRoots?: { ADMIN_ONLY?: unknown };
  };
  const adminRoots = Array.isArray(evidence.classRoots?.ADMIN_ONLY)
    ? evidence.classRoots.ADMIN_ONLY.filter((item): item is string => typeof item === "string")
    : [];
  const completedAt = Date.parse(evidence.completedAt ?? "");
  if (evidence.result !== "PASS" || path.resolve(evidence.dataRoot ?? "") !== path.resolve(dataRootValue) ||
      evidence.descriptorDigest !== expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest) ||
      !adminRoots.some((rootPath) => sameOrNested(handoffRoot, rootPath)) ||
      !Number.isFinite(completedAt) || completedAt > Date.now() + 5 * 60_000 || completedAt < Date.now() - 24 * 3600_000) {
    throw new Error("BOOTSTRAP_HANDOFF_ACL_EVIDENCE_REJECTED");
  }
  return resolved;
}

function sameOrNested(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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
    if (separator === -1) parsed.set(argument.slice(2), "true");
    else parsed.set(argument.slice(2, separator), argument.slice(separator + 1));
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

function requireLiteral(args: Map<string, string>, name: string, expected: string) {
  if (args.get(name) !== expected) throw new Error(`--${name}=${expected} is required.`);
}

function requirePattern(args: Map<string, string>, name: string, pattern: RegExp) {
  const value = args.get(name) ?? "";
  if (!pattern.test(value)) throw new Error(`--${name} is invalid.`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ event: "local-bootstrap.failed", code: "BOOTSTRAP_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
