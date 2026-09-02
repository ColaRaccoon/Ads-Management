import { createHash, createHmac } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { asRecord, assertExactKeys, canonicalJson, canonicalSha256 } from "../shared/strict-json";
import {
  assertTargetConfirmation,
  parseCloudTargetBinding,
  targetBindingSha256,
  type CloudTargetBinding,
  type TargetConfirmation
} from "../shared/target-binding";
import {
  normalizeProviderEmail,
  redactProviderError,
  type AuthMaintenanceProvider,
  type AuthProviderUser
} from "./provider";

export type AuthDispositionAction = "KEEP" | "BOOTSTRAP_SUPER_ADMIN" | "LINK" | "RE_INVITE" | "DISABLE";
export type AppRole = "SUPER_ADMIN" | "ADMIN" | "USER" | "GUEST";

export interface ProtectedManifestBindingKey {
  keyId: string;
  key: Uint8Array;
}

export interface AuthDispositionEntry {
  entryId: string;
  action: AuthDispositionAction;
  appUserId: string | null;
  normalizedEmail: string;
  providerUserId: string | null;
  expectedLinkedProviderUserId: string | null;
  expectedAuthzVersion: number | null;
  desiredRole: AppRole;
  desiredActive: boolean;
}

export interface AuthDispositionInput {
  version: "auth-disposition-input/v1";
  manifestId: string;
  target: CloudTargetBinding;
  entries: AuthDispositionEntry[];
}

export interface AppUserSnapshot {
  appUserId: string;
  normalizedEmail: string;
  providerUserId: string | null;
  role: AppRole;
  active: boolean;
  authzVersion: number;
  remainingEnabledSuperAdmins: number;
}

export interface AuthDispositionStore {
  inspectUser(input: {
    appUserId: string | null;
    normalizedEmail: string;
  }): Promise<AppUserSnapshot | null>;
  applyAtomic(command: AuthAtomicCommand): Promise<"APPLIED" | "UNCHANGED">;
  claimReinvite(command: AuthAtomicCommand): Promise<"APPLIED" | "UNCHANGED">;
  finalizeReinvite(command: AuthAtomicCommand & { providerUserId: string }): Promise<"APPLIED" | "UNCHANGED">;
  recordPartial(journal: AuthPartialJournal): Promise<void>;
  runBootstrapSuperAdmin?(input: {
    command: AuthAtomicCommand;
    invoke: (prismaFacade: unknown) => Promise<{ action: "create" | "update" | "unchanged" }>;
  }): Promise<"APPLIED" | "UNCHANGED">;
}

export interface BootstrapSuperAdminMaintenanceAdapter {
  apply(command: AuthAtomicCommand): Promise<"APPLIED" | "UNCHANGED">;
}

export interface AuthDispositionDependencies {
  provider: AuthMaintenanceProvider;
  store: AuthDispositionStore;
  manifestBindingKey: ProtectedManifestBindingKey;
  bootstrapSuperAdmin?: BootstrapSuperAdminMaintenanceAdapter;
}

export interface MaintenanceTlsReceipt {
  authorized: true;
  mode: "verify-full";
  serverName: string;
}

export async function createPrismaAuthDispositionStore(input: {
  client: PrismaClient;
  target: CloudTargetBinding;
  confirmation: TargetConfirmation;
  credentialPurpose: "AUTH_DISPOSITION_DB";
  tls: MaintenanceTlsReceipt;
  now?: Date;
}): Promise<AuthDispositionStore> {
  const target = parseCloudTargetBinding(input.target, input.now ?? new Date());
  assertTargetConfirmation(target, input.confirmation);
  if (input.credentialPurpose !== "AUTH_DISPOSITION_DB") throw new Error("AUTH_DB_CREDENTIAL_PURPOSE_INVALID");
  if (input.tls.authorized !== true || input.tls.mode !== "verify-full" ||
    input.tls.serverName !== target.database.tlsServerName) {
    throw new Error("AUTH_DB_TLS_CONFIRMATION_INVALID");
  }
  const rows = await input.client.$queryRaw<Array<{
    current_user: string;
    current_database: string;
    current_schema: string;
    has_required_role: boolean;
  }>>(Prisma.sql`
    SELECT current_user,
           current_database() AS current_database,
           current_schema() AS current_schema,
           pg_has_role(current_user, ${target.database.requiredRole}, 'USAGE') AS has_required_role
  `);
  const identity = rows[0];
  if (!identity || identity.current_user !== target.database.expectedCurrentUser ||
    identity.current_database !== target.database.name || identity.current_schema !== target.database.schema ||
    identity.has_required_role !== true) {
    throw new Error("AUTH_DB_CONNECTION_IDENTITY_MISMATCH");
  }
  return new PrismaAuthDispositionStore(input.client);
}

class PrismaAuthDispositionStore implements AuthDispositionStore {
  constructor(private readonly client: PrismaClient) {}

  async inspectUser(input: { appUserId: string | null; normalizedEmail: string }): Promise<AppUserSnapshot | null> {
    return inspectPrismaUser(this.client, input);
  }

  async applyAtomic(command: AuthAtomicCommand): Promise<"APPLIED" | "UNCHANGED"> {
    if (command.action !== "LINK" && command.action !== "DISABLE") {
      throw new Error("AUTH_DB_ATOMIC_ACTION_INVALID");
    }
    return this.client.$transaction(async (tx) => {
      await lockAuthCommand(tx, command);
      const current = await inspectPrismaUser(tx as PrismaClient, {
        appUserId: command.entry.appUserId,
        normalizedEmail: command.entry.normalizedEmail
      });
      if (isPrismaDesired(current, command.entry)) return "UNCHANGED";
      if (!snapshotMatchesIdentity(current, command.entry) || !current || !command.entry.appUserId) {
        throw new Error("AUTH_DB_CAS_MISMATCH");
      }
      await assertLastSuperAdminSafe(tx as PrismaClient, current, command.entry);
      const updated = await tx.appUser.update({
        where: { id: current.appUserId },
        data: command.action === "DISABLE"
          ? {
              isActive: false,
              deactivatedAt: new Date(),
              authzVersion: { increment: 1 }
            }
          : {
              authUserId: command.entry.providerUserId,
              email: command.entry.normalizedEmail,
              normalizedEmail: command.entry.normalizedEmail,
              role: command.entry.desiredRole,
              isActive: command.entry.desiredActive,
              inviteStatus: "ACTIVE",
              deactivatedAt: command.entry.desiredActive ? null : new Date(),
              authzVersion: { increment: 1 }
            }
      });
      if (command.revokeSessions) {
        await tx.appAuthSession.updateMany({
          where: { appUserId: current.appUserId, revokedAt: null },
          data: { revokedAt: new Date() }
        });
      }
      await writeSystemAudit(tx as PrismaClient, command, current, mapPrismaUser(updated, current.remainingEnabledSuperAdmins), "SUCCESS");
      return "APPLIED";
    });
  }

  async claimReinvite(command: AuthAtomicCommand): Promise<"APPLIED" | "UNCHANGED"> {
    if (command.action !== "RE_INVITE") throw new Error("AUTH_DB_REINVITE_ACTION_INVALID");
    return this.client.$transaction(async (tx) => {
      await lockAuthCommand(tx, command);
      const requestId = operationUuid(command.operationId);
      const persisted = command.entry.appUserId
        ? await tx.appUser.findUnique({ where: { id: command.entry.appUserId } })
        : null;
      if (persisted?.invitationRequestId === requestId && persisted.inviteStatus === "PENDING_PROVIDER") {
        return "UNCHANGED";
      }
      const current = await inspectPrismaUser(tx as PrismaClient, {
        appUserId: command.entry.appUserId,
        normalizedEmail: command.entry.normalizedEmail
      });
      if (!snapshotMatchesIdentity(current, command.entry) || !current) throw new Error("AUTH_DB_CAS_MISMATCH");
      await tx.appUser.update({
        where: { id: current.appUserId },
        data: {
          invitationRequestId: requestId,
          inviteStatus: "PENDING_PROVIDER",
          invitationErrorCode: null,
          authzVersion: { increment: 1 }
        }
      });
      await writeSystemAudit(tx as PrismaClient, command, current, null, "REQUESTED");
      return "APPLIED";
    });
  }

  async finalizeReinvite(command: AuthAtomicCommand & { providerUserId: string }): Promise<"APPLIED" | "UNCHANGED"> {
    return this.client.$transaction(async (tx) => {
      await lockAuthCommand(tx, command);
      const current = await tx.appUser.findUnique({ where: { id: command.entry.appUserId ?? "" } });
      if (!current) throw new Error("AUTH_DB_REINVITE_USER_MISSING");
      if (current.authUserId === command.providerUserId && current.inviteStatus === "INVITED") return "UNCHANGED";
      if (current.invitationRequestId !== operationUuid(command.operationId)) throw new Error("AUTH_DB_REINVITE_CLAIM_MISMATCH");
      const updated = await tx.appUser.update({
        where: { id: current.id },
        data: {
          authUserId: command.providerUserId,
          inviteStatus: "INVITED",
          isActive: command.entry.desiredActive,
          role: command.entry.desiredRole,
          invitedAt: new Date(),
          invitationErrorCode: null,
          authzVersion: { increment: 1 }
        }
      });
      const before = mapPrismaUser(current, await enabledSuperAdminCount(tx as PrismaClient));
      await writeSystemAudit(tx as PrismaClient, command, before, mapPrismaUser(updated, before.remainingEnabledSuperAdmins), "SUCCESS");
      return "APPLIED";
    });
  }

  async recordPartial(journal: AuthPartialJournal): Promise<void> {
    await this.client.securityAuditEvent.create({
      data: {
        actorUserId: null,
        actorType: "SYSTEM",
        action: "AUTH_DISPOSITION_PARTIAL",
        targetType: "AUTH_DISPOSITION_ENTRY",
        targetId: journal.entryId,
        result: "PARTIAL",
        beforeJson: Prisma.JsonNull,
        afterJson: {
          planId: journal.planId,
          state: journal.state,
          compensation: journal.compensation,
          code: journal.code,
          targetSha256: journal.targetSha256
        },
        requestId: operationUuid(journal.operationId)
      }
    });
  }

  async runBootstrapSuperAdmin(input: {
    command: AuthAtomicCommand;
    invoke: (prismaFacade: unknown) => Promise<{ action: "create" | "update" | "unchanged" }>;
  }): Promise<"APPLIED" | "UNCHANGED"> {
    if (input.command.action !== "BOOTSTRAP_SUPER_ADMIN") throw new Error("AUTH_DB_BOOTSTRAP_ACTION_INVALID");
    return this.client.$transaction(async (tx) => {
      await lockAuthCommand(tx, input.command);
      const before = await inspectPrismaUser(tx as PrismaClient, {
        appUserId: input.command.entry.appUserId,
        normalizedEmail: input.command.entry.normalizedEmail
      });
      if (!snapshotMatchesIdentity(before, input.command.entry) && !isPrismaDesired(before, input.command.entry)) {
        throw new Error("AUTH_DB_CAS_MISMATCH");
      }
      const facade = {
        appUser: tx.appUser,
        $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx)
      };
      const result = await input.invoke(facade);
      const afterRow = await tx.appUser.findUnique({ where: { authUserId: input.command.entry.providerUserId! } });
      if (!afterRow || afterRow.role !== "SUPER_ADMIN" || !afterRow.isActive) {
        throw new Error("AUTH_DB_BOOTSTRAP_POSTCONDITION_FAILED");
      }
      await tx.appAuthSession.updateMany({
        where: { appUserId: afterRow.id, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      const remaining = await enabledSuperAdminCount(tx as PrismaClient);
      await writeSystemAudit(
        tx as PrismaClient,
        input.command,
        before,
        mapPrismaUser(afterRow, remaining),
        "SUCCESS"
      );
      return result.action === "unchanged" ? "UNCHANGED" : "APPLIED";
    });
  }
}

export interface AuthAtomicCommand {
  operationId: string;
  action: AuthDispositionAction;
  entry: AuthDispositionEntry;
  targetSha256: string;
  lockKeys: string[];
  revokeSessions: boolean;
  auditCode: string;
}

export interface AuthPartialJournal {
  version: "auth-disposition-partial/v1";
  operationId: string;
  planId: string;
  entryId: string;
  action: "RE_INVITE" | "DISABLE";
  targetSha256: string;
  state: "DB_APPLIED_PROVIDER_FAILED" | "PROVIDER_APPLIED_DB_FAILED";
  compensation: "NOT_APPLICABLE" | "SUCCEEDED" | "FAILED";
  code: string;
}

export interface AuthDispositionPlanEntry {
  entryId: string;
  action: AuthDispositionAction;
  outcome: "READY" | "UNCHANGED" | "BLOCKED";
  code: string;
}

export interface AuthDispositionPlan {
  version: "auth-disposition-plan/v1";
  planId: string;
  manifestId: string;
  targetSha256: string;
  projectRef: string;
  releaseGitSha: string;
  manifestBinding: {
    algorithm: "HMAC-SHA256";
    keyId: string;
    value: string;
  };
  mode: "DRY_RUN";
  entries: AuthDispositionPlanEntry[];
  counts: Record<"ready" | "unchanged" | "blocked", number>;
}

export interface AuthDispositionApplyConfirmation extends TargetConfirmation {
  approved: true;
  planId: string;
  action: AuthDispositionAction;
  manifestBindingKeyId: string;
  manifestHmacSha256: string;
}

export interface AuthDispositionApplyResult {
  version: "auth-disposition-apply-result/v1";
  planId: string;
  targetSha256: string;
  mode: "APPLY";
  counts: Record<"applied" | "unchanged" | "partial", number>;
  codes: string[];
}

export async function planAuthDisposition(
  rawInput: AuthDispositionInput,
  dependencies: AuthDispositionDependencies,
  now = new Date()
): Promise<AuthDispositionPlan> {
  const input = validateDispositionInput(rawInput, now);
  if (dependencies.provider.projectRef !== input.target.projectRef) {
    throw new Error("AUTH_PROVIDER_TARGET_MISMATCH");
  }
  const targetSha256 = targetBindingSha256(input.target);
  const manifestBinding = bindProtectedManifest(input, dependencies.manifestBindingKey);

  const entries: AuthDispositionPlanEntry[] = [];
  for (const entry of input.entries) {
    entries.push(await inspectEntry(entry, dependencies));
  }
  const stableBody = {
    version: "auth-disposition-plan/v1",
    manifestId: input.manifestId,
    targetSha256,
    projectRef: input.target.projectRef,
    releaseGitSha: input.target.releaseGitSha,
    manifestBinding,
    mode: "DRY_RUN",
    entries
  } as const;
  return {
    ...stableBody,
    planId: canonicalSha256(stableBody),
    counts: {
      ready: entries.filter((entry) => entry.outcome === "READY").length,
      unchanged: entries.filter((entry) => entry.outcome === "UNCHANGED").length,
      blocked: entries.filter((entry) => entry.outcome === "BLOCKED").length
    }
  };
}

export function authDispositionManifestBinding(
  rawInput: AuthDispositionInput,
  bindingKey: ProtectedManifestBindingKey,
  now = new Date()
): { target: CloudTargetBinding; manifestBinding: AuthDispositionPlan["manifestBinding"] } {
  const input = validateDispositionInput(rawInput, now);
  return { target: input.target, manifestBinding: bindProtectedManifest(input, bindingKey) };
}

export async function applyAuthDisposition(
  rawInput: AuthDispositionInput,
  dependencies: AuthDispositionDependencies,
  confirmation: AuthDispositionApplyConfirmation,
  expectedPlan: AuthDispositionPlan,
  now = new Date()
): Promise<AuthDispositionApplyResult> {
  if (confirmation.approved !== true) throw new Error("AUTH_APPLY_EXPLICIT_APPROVAL_REQUIRED");
  const input = validateDispositionInput(rawInput, now);
  assertTargetConfirmation(input.target, confirmation);
  if (confirmation.planId !== expectedPlan.planId) throw new Error("AUTH_APPLY_PLAN_CONFIRMATION_MISMATCH");
  if (confirmation.manifestBindingKeyId !== expectedPlan.manifestBinding.keyId ||
    confirmation.manifestHmacSha256 !== expectedPlan.manifestBinding.value) {
    throw new Error("AUTH_APPLY_MANIFEST_CONFIRMATION_MISMATCH");
  }

  const refreshed = await planAuthDisposition(input, dependencies, now);
  if (refreshed.planId !== expectedPlan.planId) throw new Error("AUTH_APPLY_PLAN_STALE");
  const selected = refreshed.entries.filter((entry) => entry.action === confirmation.action);
  if (selected.length === 0) throw new Error("AUTH_APPLY_ACTION_EMPTY");
  if (selected.some((entry) => entry.outcome === "BLOCKED")) throw new Error("AUTH_APPLY_ACTION_BLOCKED");

  const counts = { applied: 0, unchanged: 0, partial: 0 };
  const codes = new Set<string>();
  for (const plannedEntry of selected) {
    if (plannedEntry.outcome === "UNCHANGED" || plannedEntry.action === "KEEP") {
      counts.unchanged += 1;
      continue;
    }
    const entry = input.entries.find((candidate) => candidate.entryId === plannedEntry.entryId);
    if (!entry) throw new Error("AUTH_APPLY_ENTRY_MISSING");
    const operationId = `auth-op:${bindProtectedValue("auth-disposition-entry/v1", {
      manifestHmacSha256: refreshed.manifestBinding.value,
      entry,
      action: entry.action,
      targetSha256: refreshed.targetSha256
    }, dependencies.manifestBindingKey)}`;
    const command: AuthAtomicCommand = {
      operationId,
      action: entry.action,
      entry,
      targetSha256: refreshed.targetSha256,
      lockKeys: [
        `auth-disposition:${input.target.projectRef}`,
        `auth-disposition:${entry.entryId}`
      ],
      revokeSessions: entry.action === "LINK" || entry.action === "DISABLE",
      auditCode: `AUTH_DISPOSITION_${entry.action}`
    };

    if (entry.action === "BOOTSTRAP_SUPER_ADMIN") {
      if (!dependencies.bootstrapSuperAdmin) throw new Error("AUTH_BOOTSTRAP_ADAPTER_REQUIRED");
      const outcome = await storeMutation(
        () => dependencies.bootstrapSuperAdmin!.apply(command),
        "AUTH_BOOTSTRAP_SUPER_ADMIN_FAILED"
      );
      counts[outcome === "APPLIED" ? "applied" : "unchanged"] += 1;
      continue;
    }
    if (entry.action === "LINK") {
      const outcome = await storeMutation(
        () => dependencies.store.applyAtomic(command),
        "AUTH_STORE_ATOMIC_APPLY_FAILED"
      );
      counts[outcome === "APPLIED" ? "applied" : "unchanged"] += 1;
      continue;
    }
    if (entry.action === "RE_INVITE") {
      const outcome = await applyReinvite(command, refreshed, dependencies);
      counts[outcome] += 1;
      if (outcome === "partial") codes.add("AUTH_REINVITE_PARTIAL");
      continue;
    }
    if (entry.action === "DISABLE") {
      const outcome = await applyDisable(command, refreshed, dependencies);
      counts[outcome] += 1;
      if (outcome === "partial") codes.add("AUTH_DISABLE_PARTIAL");
    }
  }
  return {
    version: "auth-disposition-apply-result/v1",
    planId: refreshed.planId,
    targetSha256: refreshed.targetSha256,
    mode: "APPLY",
    counts,
    codes: [...codes].sort()
  };
}

async function inspectEntry(
  entry: AuthDispositionEntry,
  dependencies: AuthDispositionDependencies
): Promise<AuthDispositionPlanEntry> {
  const rawSnapshot = await safeStoreCall(() => dependencies.store.inspectUser({
    appUserId: entry.appUserId,
    normalizedEmail: entry.normalizedEmail
  }), "AUTH_STORE_INSPECTION_FAILED");
  const snapshot = rawSnapshot === null ? null : validateSnapshot(rawSnapshot);
  let byId: AuthProviderUser | null = null;
  let byEmail: AuthProviderUser | null = null;
  try {
    [byId, byEmail] = await Promise.all([
      entry.providerUserId
        ? dependencies.provider.findUserById(entry.providerUserId)
        : Promise.resolve(null),
      dependencies.provider.findUserByEmail(entry.normalizedEmail)
    ]);
  } catch (error) {
    throw redactProviderError(error);
  }
  if (byId && byEmail && byId.id !== byEmail.id) {
    return planned(entry, "BLOCKED", "AUTH_PROVIDER_IDENTITY_CONFLICT");
  }
  const providerUser = byId ?? byEmail;
  if (providerUser && providerUser.email !== entry.normalizedEmail) {
    return planned(entry, "BLOCKED", "AUTH_PROVIDER_EMAIL_MISMATCH");
  }
  if (providerUser && !providerUser.emailVerified && entry.action !== "RE_INVITE") {
    return planned(entry, "BLOCKED", "AUTH_PROVIDER_EMAIL_UNVERIFIED");
  }
  if (providerUser?.disabled && entry.action !== "DISABLE") {
    return planned(entry, "BLOCKED", "AUTH_PROVIDER_USER_DISABLED");
  }
  if (entry.action === "KEEP") {
    if (!snapshotMatchesIdentity(snapshot, entry) || !isDesiredState(snapshot, providerUser, entry)) {
      return planned(entry, "BLOCKED", "AUTH_KEEP_EXACT_STATE_MISMATCH");
    }
    return planned(entry, "UNCHANGED", "AUTH_KEEP_EXACT_STATE_UNCHANGED");
  }
  if (!snapshotMatchesIdentity(snapshot, entry)) {
    if (isDesiredState(snapshot, providerUser, entry)) {
      return planned(entry, "UNCHANGED", "AUTH_DISPOSITION_ALREADY_APPLIED");
    }
    return planned(entry, "BLOCKED", "AUTH_APP_USER_EXPECTATION_MISMATCH");
  }
  if (entry.action === "RE_INVITE") {
    if (providerUser === null) return planned(entry, "READY", "AUTH_REINVITE_READY");
    if (isDesiredState(snapshot, providerUser, entry)) {
      return planned(entry, "UNCHANGED", "AUTH_DISPOSITION_ALREADY_APPLIED");
    }
    return planned(entry, "BLOCKED", "AUTH_REINVITE_PROVIDER_USER_EXISTS");
  }
  if (providerUser === null) return planned(entry, "BLOCKED", "AUTH_PROVIDER_USER_MISSING");
  if (entry.action === "DISABLE" && snapshot?.role === "SUPER_ADMIN" && snapshot.remainingEnabledSuperAdmins <= 1) {
    return planned(entry, "BLOCKED", "AUTH_LAST_SUPER_ADMIN_PROTECTED");
  }
  if (isDesiredState(snapshot, providerUser, entry)) {
    return planned(entry, "UNCHANGED", "AUTH_DISPOSITION_ALREADY_APPLIED");
  }
  return planned(entry, "READY", `AUTH_${entry.action}_READY`);
}

function snapshotMatchesIdentity(snapshot: AppUserSnapshot | null, entry: AuthDispositionEntry): boolean {
  if (entry.appUserId === null) return snapshot === null;
  return snapshot !== null && snapshot.appUserId === entry.appUserId &&
    snapshot.normalizedEmail === entry.normalizedEmail &&
    snapshot.authzVersion === entry.expectedAuthzVersion &&
    snapshot.providerUserId === entry.expectedLinkedProviderUserId;
}

function isDesiredState(
  snapshot: AppUserSnapshot | null,
  providerUser: AuthProviderUser | null,
  entry: AuthDispositionEntry
): boolean {
  if (!snapshot || snapshot.normalizedEmail !== entry.normalizedEmail) return false;
  if (snapshot.role !== entry.desiredRole || snapshot.active !== entry.desiredActive) return false;
  if (entry.action === "DISABLE") return providerUser?.disabled === true;
  if (entry.action === "KEEP") {
    return snapshot.providerUserId === entry.providerUserId &&
      (providerUser === null || providerUser.id === snapshot.providerUserId);
  }
  return providerUser !== null && snapshot.providerUserId === providerUser.id;
}

async function applyReinvite(
  command: AuthAtomicCommand,
  plan: AuthDispositionPlan,
  dependencies: AuthDispositionDependencies
): Promise<"applied" | "unchanged" | "partial"> {
  const claim = await storeMutation(
    () => dependencies.store.claimReinvite(command),
    "AUTH_STORE_REINVITE_CLAIM_FAILED"
  );
  if (claim === "UNCHANGED") return "unchanged";
  let invite;
  try {
    invite = await dependencies.provider.inviteUser({
      normalizedEmail: command.entry.normalizedEmail,
      idempotencyKey: `${command.operationId}:provider-invite`
    });
  } catch (error) {
    await recordPartial(dependencies.store, command, plan, {
      state: "DB_APPLIED_PROVIDER_FAILED",
      compensation: "NOT_APPLICABLE",
      code: "AUTH_REINVITE_PROVIDER_FAILED"
    });
    return "partial";
  }
  try {
    await storeMutation(
      () => dependencies.store.finalizeReinvite({ ...command, providerUserId: invite.userId }),
      "AUTH_STORE_REINVITE_FINALIZE_FAILED"
    );
    return "applied";
  } catch {
    let compensation: "SUCCEEDED" | "FAILED" = "SUCCEEDED";
    try {
      await dependencies.provider.removeOwnedInvitation({
        invitationId: invite.invitationId,
        ownershipKey: `${command.operationId}:provider-invite`,
        idempotencyKey: `${command.operationId}:compensate-invite`
      });
    } catch {
      compensation = "FAILED";
    }
    await recordPartial(dependencies.store, command, plan, {
      state: "PROVIDER_APPLIED_DB_FAILED",
      compensation,
      code: compensation === "SUCCEEDED"
        ? "AUTH_REINVITE_FINALIZE_FAILED_COMPENSATED"
        : "AUTH_REINVITE_COMPENSATION_FAILED"
    });
    return "partial";
  }
}

async function applyDisable(
  command: AuthAtomicCommand,
  plan: AuthDispositionPlan,
  dependencies: AuthDispositionDependencies
): Promise<"applied" | "unchanged" | "partial"> {
  const dbOutcome = await storeMutation(
    () => dependencies.store.applyAtomic(command),
    "AUTH_STORE_DISABLE_FAILED"
  );
  if (dbOutcome === "UNCHANGED") return "unchanged";
  if (!command.entry.providerUserId) throw new Error("AUTH_DISABLE_PROVIDER_USER_REQUIRED");
  try {
    await dependencies.provider.setUserDisabled({
      userId: command.entry.providerUserId,
      disabled: true,
      idempotencyKey: `${command.operationId}:provider-disable`
    });
    return "applied";
  } catch {
    await recordPartial(dependencies.store, command, plan, {
      state: "DB_APPLIED_PROVIDER_FAILED",
      compensation: "NOT_APPLICABLE",
      code: "AUTH_DISABLE_PROVIDER_FAILED"
    });
    return "partial";
  }
}

async function recordPartial(
  store: AuthDispositionStore,
  command: AuthAtomicCommand,
  plan: AuthDispositionPlan,
  detail: Pick<AuthPartialJournal, "state" | "compensation" | "code">
): Promise<void> {
  await safeStoreCall(() => store.recordPartial({
    version: "auth-disposition-partial/v1",
    operationId: command.operationId,
    planId: plan.planId,
    entryId: command.entry.entryId,
    action: command.entry.action as "RE_INVITE" | "DISABLE",
    targetSha256: plan.targetSha256,
    ...detail
  }), "AUTH_PARTIAL_JOURNAL_WRITE_FAILED");
}

async function storeMutation(
  operation: () => Promise<"APPLIED" | "UNCHANGED">,
  failureCode: string
): Promise<"APPLIED" | "UNCHANGED"> {
  const outcome = await safeStoreCall(operation, failureCode);
  if (outcome !== "APPLIED" && outcome !== "UNCHANGED") throw new Error("AUTH_STORE_OUTCOME_INVALID");
  return outcome;
}

async function safeStoreCall<T>(operation: () => Promise<T>, failureCode: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)) throw error;
    throw new Error(failureCode);
  }
}

async function inspectPrismaUser(
  client: Pick<PrismaClient, "appUser"> & Partial<Pick<PrismaClient, "$queryRaw">>,
  input: { appUserId: string | null; normalizedEmail: string }
): Promise<AppUserSnapshot | null> {
  const [byId, byEmail] = await Promise.all([
    input.appUserId ? client.appUser.findUnique({ where: { id: input.appUserId } }) : Promise.resolve(null),
    client.appUser.findUnique({ where: { normalizedEmail: input.normalizedEmail } })
  ]);
  if (byId && byEmail && byId.id !== byEmail.id) throw new Error("AUTH_DB_IDENTITY_CONFLICT");
  const user = byId ?? byEmail;
  if (!user) return null;
  const remaining = await client.appUser.count({ where: { role: "SUPER_ADMIN", isActive: true } });
  return mapPrismaUser(user, remaining);
}

function mapPrismaUser(
  user: {
    id: string;
    normalizedEmail: string | null;
    authUserId: string | null;
    role: string;
    isActive: boolean;
    authzVersion: number;
  },
  remainingEnabledSuperAdmins: number
): AppUserSnapshot {
  if (!user.normalizedEmail || !(["SUPER_ADMIN", "ADMIN", "USER", "GUEST"] as unknown[]).includes(user.role)) {
    throw new Error("AUTH_DB_USER_STATE_INVALID");
  }
  return {
    appUserId: user.id,
    normalizedEmail: user.normalizedEmail,
    providerUserId: user.authUserId,
    role: user.role as AppRole,
    active: user.isActive,
    authzVersion: user.authzVersion,
    remainingEnabledSuperAdmins
  };
}

async function enabledSuperAdminCount(client: Pick<PrismaClient, "appUser">): Promise<number> {
  return client.appUser.count({ where: { role: "SUPER_ADMIN", isActive: true } });
}

async function lockAuthCommand(
  client: Pick<PrismaClient, "$queryRaw">,
  command: AuthAtomicCommand
): Promise<void> {
  for (const lockKey of command.lockKeys) {
    await client.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  }
}

function isPrismaDesired(snapshot: AppUserSnapshot | null, entry: AuthDispositionEntry): boolean {
  if (!snapshot || snapshot.normalizedEmail !== entry.normalizedEmail || snapshot.role !== entry.desiredRole ||
    snapshot.active !== entry.desiredActive) return false;
  if (entry.action === "DISABLE") return snapshot.active === false;
  return snapshot.providerUserId === entry.providerUserId;
}

async function assertLastSuperAdminSafe(
  client: Pick<PrismaClient, "appUser">,
  current: AppUserSnapshot,
  desired: AuthDispositionEntry
): Promise<void> {
  if (current.role !== "SUPER_ADMIN" || (desired.desiredRole === "SUPER_ADMIN" && desired.desiredActive)) return;
  if (await enabledSuperAdminCount(client) <= 1) throw new Error("AUTH_LAST_SUPER_ADMIN_PROTECTED");
}

async function writeSystemAudit(
  client: Pick<PrismaClient, "securityAuditEvent">,
  command: AuthAtomicCommand,
  before: AppUserSnapshot | null,
  after: AppUserSnapshot | null,
  result: "REQUESTED" | "SUCCESS"
): Promise<void> {
  await client.securityAuditEvent.create({
    data: {
      actorUserId: null,
      actorType: "SYSTEM",
      action: command.auditCode,
      targetType: "APP_USER",
      targetId: command.entry.appUserId,
      result,
      beforeJson: before ? safeAuditSnapshot(before) : Prisma.JsonNull,
      afterJson: after ? safeAuditSnapshot(after) : Prisma.JsonNull,
      requestId: operationUuid(command.operationId)
    }
  });
}

function safeAuditSnapshot(snapshot: AppUserSnapshot): Prisma.InputJsonObject {
  return {
    role: snapshot.role,
    active: snapshot.active,
    authzVersion: snapshot.authzVersion
  };
}

function operationUuid(operationId: string): string {
  const hex = createHash("sha256").update(`auth-operation-uuid/v1\0${operationId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createBootstrapSuperAdminMaintenanceAdapter(input: {
  store: AuthDispositionStore;
  provider: AuthMaintenanceProvider;
  createService: (
    prismaFacade: unknown,
    provider: { getUserById(userId: string): Promise<{ id: string; email: string; emailVerified: boolean }> }
  ) => { run(input: { authUserId: string; email: string; dryRun: boolean }): Promise<{
    action: "create" | "update" | "unchanged";
  }> };
}): BootstrapSuperAdminMaintenanceAdapter {
  if (!input.store.runBootstrapSuperAdmin) throw new Error("AUTH_BOOTSTRAP_STORE_CAPABILITY_REQUIRED");
  return {
    async apply(command) {
      if (command.action !== "BOOTSTRAP_SUPER_ADMIN" || command.entry.desiredRole !== "SUPER_ADMIN" ||
        command.entry.desiredActive !== true || !command.entry.providerUserId) {
        throw new Error("AUTH_BOOTSTRAP_SUPER_ADMIN_COMMAND_INVALID");
      }
      return input.store.runBootstrapSuperAdmin!({
        command,
        invoke: async (prismaFacade) => {
          const identityProvider = {
            getUserById: async (userId: string) => {
              const user = await input.provider.findUserById(userId);
              if (!user) throw new Error("AUTH_PROVIDER_USER_MISSING");
              return { id: user.id, email: user.email, emailVerified: user.emailVerified };
            }
          };
          return input.createService(prismaFacade, identityProvider).run({
            authUserId: command.entry.providerUserId!,
            email: command.entry.normalizedEmail,
            dryRun: false
          });
        }
      });
    }
  };
}

function bindProtectedManifest(
  input: AuthDispositionInput,
  bindingKey: ProtectedManifestBindingKey
): AuthDispositionPlan["manifestBinding"] {
  const key = validateManifestBindingKey(bindingKey);
  return {
    algorithm: "HMAC-SHA256",
    keyId: key.keyId,
    value: bindProtectedValue("auth-disposition-manifest/v1", input, key)
  };
}

function bindProtectedValue(
  domain: string,
  value: unknown,
  bindingKey: ProtectedManifestBindingKey
): string {
  const key = validateManifestBindingKey(bindingKey);
  return createHmac("sha256", key.key)
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function validateManifestBindingKey(bindingKey: ProtectedManifestBindingKey): ProtectedManifestBindingKey {
  if (!bindingKey || typeof bindingKey !== "object" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(bindingKey.keyId) ||
    !(bindingKey.key instanceof Uint8Array) || bindingKey.key.byteLength < 32 || bindingKey.key.byteLength > 128) {
    throw new Error("AUTH_MANIFEST_BINDING_KEY_INVALID");
  }
  return bindingKey;
}

function validateSnapshot(snapshot: AppUserSnapshot): AppUserSnapshot {
  if (!snapshot || typeof snapshot !== "object") throw new Error("AUTH_STORE_SNAPSHOT_INVALID");
  const appUserId = assertOpaqueId(snapshot.appUserId, "AUTH_STORE_SNAPSHOT_INVALID");
  const providerUserId = nullableOpaqueId(snapshot.providerUserId, "AUTH_STORE_SNAPSHOT_INVALID");
  const normalizedEmail = normalizeProviderEmail(snapshot.normalizedEmail);
  if (normalizedEmail !== snapshot.normalizedEmail ||
    !(["SUPER_ADMIN", "ADMIN", "USER", "GUEST"] as unknown[]).includes(snapshot.role) ||
    typeof snapshot.active !== "boolean" || !Number.isSafeInteger(snapshot.authzVersion) || snapshot.authzVersion < 0 ||
    !Number.isSafeInteger(snapshot.remainingEnabledSuperAdmins) || snapshot.remainingEnabledSuperAdmins < 0) {
    throw new Error("AUTH_STORE_SNAPSHOT_INVALID");
  }
  return { ...snapshot, appUserId, providerUserId, normalizedEmail };
}

function validateDispositionInput(input: AuthDispositionInput, now: Date): AuthDispositionInput {
  const inputRecord = asRecord(input, "AUTH_MANIFEST_OBJECT_REQUIRED");
  assertExactKeys(inputRecord, ["version", "manifestId", "target", "entries"], "AUTH_MANIFEST_KEYS_INVALID");
  if (input.version !== "auth-disposition-input/v1") throw new Error("AUTH_MANIFEST_VERSION_INVALID");
  const target = parseCloudTargetBinding(input.target, now);
  const manifestId = assertOpaqueId(input.manifestId, "AUTH_MANIFEST_ID_INVALID");
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 500) {
    throw new Error("AUTH_MANIFEST_ENTRIES_INVALID");
  }
  const seen = new Set<string>();
  const entries = input.entries.map((rawEntry) => {
    const entryRecord = asRecord(rawEntry, "AUTH_ENTRY_OBJECT_REQUIRED");
    assertExactKeys(entryRecord, [
      "entryId", "action", "appUserId", "normalizedEmail", "providerUserId",
      "expectedLinkedProviderUserId", "expectedAuthzVersion", "desiredRole", "desiredActive"
    ], "AUTH_ENTRY_KEYS_INVALID");
    const entryId = assertOpaqueId(rawEntry.entryId, "AUTH_ENTRY_ID_INVALID");
    if (seen.has(entryId)) throw new Error("AUTH_ENTRY_ID_DUPLICATE");
    seen.add(entryId);
    if (!["KEEP", "BOOTSTRAP_SUPER_ADMIN", "LINK", "RE_INVITE", "DISABLE"].includes(rawEntry.action)) {
      throw new Error("AUTH_ACTION_INVALID");
    }
    const appUserId = nullableOpaqueId(rawEntry.appUserId, "AUTH_APP_USER_ID_INVALID");
    const providerUserId = nullableOpaqueId(
      rawEntry.providerUserId,
      "AUTH_PROVIDER_USER_ID_INVALID"
    );
    const expectedLinkedProviderUserId = nullableOpaqueId(
      rawEntry.expectedLinkedProviderUserId,
      "AUTH_LINKED_PROVIDER_USER_ID_INVALID"
    );
    if (rawEntry.expectedAuthzVersion !== null &&
      (!Number.isSafeInteger(rawEntry.expectedAuthzVersion) || rawEntry.expectedAuthzVersion < 0)) {
      throw new Error("AUTH_AUTHZ_VERSION_INVALID");
    }
    if (!(["SUPER_ADMIN", "ADMIN", "USER", "GUEST"] as unknown[]).includes(rawEntry.desiredRole)) {
      throw new Error("AUTH_ROLE_INVALID");
    }
    if (typeof rawEntry.desiredActive !== "boolean") throw new Error("AUTH_ACTIVE_INVALID");
    if (rawEntry.action !== "BOOTSTRAP_SUPER_ADMIN" && appUserId === null) throw new Error("AUTH_APP_USER_ID_REQUIRED");
    if ((appUserId === null) !== (rawEntry.expectedAuthzVersion === null)) {
      throw new Error("AUTH_AUTHZ_VERSION_EXPECTATION_INVALID");
    }
    if (appUserId === null && expectedLinkedProviderUserId !== null) {
      throw new Error("AUTH_LINK_EXPECTATION_INVALID");
    }
    if (["KEEP", "BOOTSTRAP_SUPER_ADMIN", "LINK", "DISABLE"].includes(rawEntry.action) && providerUserId === null) {
      throw new Error("AUTH_PROVIDER_USER_ID_REQUIRED");
    }
    if (rawEntry.action === "BOOTSTRAP_SUPER_ADMIN" &&
      (rawEntry.desiredRole !== "SUPER_ADMIN" || rawEntry.desiredActive !== true)) {
      throw new Error("AUTH_BOOTSTRAP_SUPER_ADMIN_DESIRED_STATE_INVALID");
    }
    if (rawEntry.action === "DISABLE" && rawEntry.desiredActive !== false) {
      throw new Error("AUTH_DISABLE_DESIRED_STATE_INVALID");
    }
    const normalizedEmail = normalizeProviderEmail(rawEntry.normalizedEmail);
    if (normalizedEmail !== rawEntry.normalizedEmail) throw new Error("AUTH_EMAIL_NOT_NORMALIZED");
    return {
      entryId,
      action: rawEntry.action,
      appUserId,
      normalizedEmail,
      providerUserId,
      expectedLinkedProviderUserId,
      expectedAuthzVersion: rawEntry.expectedAuthzVersion,
      desiredRole: rawEntry.desiredRole,
      desiredActive: rawEntry.desiredActive
    };
  });
  return { version: "auth-disposition-input/v1", manifestId, target, entries };
}

function nullableOpaqueId(value: string | null, code: string): string | null {
  return value === null ? null : assertOpaqueId(value, code);
}

function assertOpaqueId(value: string, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) throw new Error(code);
  return value;
}

function planned(
  entry: AuthDispositionEntry,
  outcome: AuthDispositionPlanEntry["outcome"],
  code: string
): AuthDispositionPlanEntry {
  return { entryId: entry.entryId, action: entry.action, outcome, code };
}
