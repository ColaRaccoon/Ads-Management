import { createHash } from "node:crypto";
import {
  assertTargetConfirmation,
  parseCloudTargetBinding,
  type CloudTargetBinding,
  type TargetConfirmation
} from "../shared/target-binding";

export type AuthProviderUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  disabled: boolean;
};

export type ProviderMutationReceipt = {
  operationId: string;
  userId: string;
};

export type ProviderInviteReceipt = ProviderMutationReceipt & {
  invitationId: string;
};

export interface AuthAdminTransport {
  findUserById(userId: string): Promise<AuthProviderUser | null>;
  findUserByEmail(normalizedEmail: string): Promise<AuthProviderUser | null>;
  inviteUser(input: {
    normalizedEmail: string;
    idempotencyKey: string;
  }): Promise<ProviderInviteReceipt>;
  setUserDisabled(input: {
    userId: string;
    disabled: boolean;
    idempotencyKey: string;
  }): Promise<ProviderMutationReceipt>;
  removeInvitation(input: {
    invitationId: string;
    ownershipKey: string;
    idempotencyKey: string;
  }): Promise<ProviderMutationReceipt>;
}

export interface AuthMaintenanceProvider {
  readonly projectRef: string;
  findUserById(userId: string): Promise<AuthProviderUser | null>;
  findUserByEmail(normalizedEmail: string): Promise<AuthProviderUser | null>;
  inviteUser(input: {
    normalizedEmail: string;
    idempotencyKey: string;
  }): Promise<ProviderInviteReceipt>;
  setUserDisabled(input: {
    userId: string;
    disabled: boolean;
    idempotencyKey: string;
  }): Promise<ProviderMutationReceipt>;
  removeOwnedInvitation(input: {
    invitationId: string;
    ownershipKey: string;
    idempotencyKey: string;
  }): Promise<ProviderMutationReceipt>;
}

export class BoundAuthMaintenanceProvider implements AuthMaintenanceProvider {
  readonly projectRef: string;

  constructor(input: {
    projectRef: string;
    providerOrigin: string;
    transport: AuthAdminTransport;
  }) {
    const projectRef = assertProjectRef(input.projectRef);
    const origin = parseProviderOrigin(input.providerOrigin);
    if (origin.hostname !== `${projectRef}.supabase.co`) {
      throw new Error("AUTH_PROVIDER_TARGET_MISMATCH");
    }
    this.projectRef = projectRef;
    this.transport = input.transport;
  }

  private readonly transport: AuthAdminTransport;

  async findUserById(userId: string): Promise<AuthProviderUser | null> {
    const user = await this.transport.findUserById(assertOpaqueId(userId, "AUTH_USER_ID_INVALID"));
    return user === null ? null : validateProviderUser(user);
  }

  async findUserByEmail(normalizedEmail: string): Promise<AuthProviderUser | null> {
    const email = normalizeProviderEmail(normalizedEmail);
    const user = await this.transport.findUserByEmail(email);
    return user === null ? null : validateProviderUser(user);
  }

  async inviteUser(input: {
    normalizedEmail: string;
    idempotencyKey: string;
  }): Promise<ProviderInviteReceipt> {
    return validateInviteReceipt(await this.transport.inviteUser({
      normalizedEmail: normalizeProviderEmail(input.normalizedEmail),
      idempotencyKey: assertIdempotencyKey(input.idempotencyKey)
    }));
  }

  async setUserDisabled(input: {
    userId: string;
    disabled: boolean;
    idempotencyKey: string;
  }): Promise<ProviderMutationReceipt> {
    return validateMutationReceipt(await this.transport.setUserDisabled({
      userId: assertOpaqueId(input.userId, "AUTH_USER_ID_INVALID"),
      disabled: input.disabled,
      idempotencyKey: assertIdempotencyKey(input.idempotencyKey)
    }));
  }

  async removeOwnedInvitation(input: {
    invitationId: string;
    ownershipKey: string;
    idempotencyKey: string;
  }): Promise<ProviderMutationReceipt> {
    return validateMutationReceipt(await this.transport.removeInvitation({
      invitationId: assertOpaqueId(input.invitationId, "AUTH_INVITATION_ID_INVALID"),
      ownershipKey: assertIdempotencyKey(input.ownershipKey),
      idempotencyKey: assertIdempotencyKey(input.idempotencyKey)
    }));
  }
}

type SupabaseAdminUser = {
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
  confirmed_at?: unknown;
  banned_until?: unknown;
  user_metadata?: unknown;
};

type SupabaseAdminResult<T> = { data: T; error: { message?: string } | null };

export interface SupabaseMaintenanceAdminClient {
  auth: {
    admin: {
      getUserById(userId: string): Promise<SupabaseAdminResult<{ user: SupabaseAdminUser | null }>>;
      listUsers(input: { page: number; perPage: number }): Promise<SupabaseAdminResult<{
        users: SupabaseAdminUser[];
        nextPage?: number | null;
        lastPage?: number;
      }>>;
      inviteUserByEmail(email: string, options: { data: Record<string, unknown> }): Promise<
        SupabaseAdminResult<{ user: SupabaseAdminUser | null }>
      >;
      updateUserById(userId: string, attributes: { ban_duration: string }): Promise<
        SupabaseAdminResult<{ user: SupabaseAdminUser | null }>
      >;
      deleteUser(userId: string, shouldSoftDelete: boolean): Promise<SupabaseAdminResult<Record<string, unknown>>>;
    };
  };
}

export function createSupabaseAdminTransport(input: {
  target: CloudTargetBinding;
  confirmation: TargetConfirmation;
  credentialPurpose: "SUPABASE_AUTH_ADMIN";
  tls: { authorized: true; serverName: string; mode: "verify-full" };
  client: SupabaseMaintenanceAdminClient;
  now?: Date;
}): AuthAdminTransport {
  const target = parseCloudTargetBinding(input.target, input.now ?? new Date());
  assertTargetConfirmation(target, input.confirmation);
  if (input.credentialPurpose !== "SUPABASE_AUTH_ADMIN") throw new Error("AUTH_ADMIN_CREDENTIAL_PURPOSE_INVALID");
  if (input.tls.authorized !== true || input.tls.mode !== "verify-full" ||
    input.tls.serverName !== new URL(target.supabaseOrigin).hostname) {
    throw new Error("AUTH_ADMIN_TLS_CONFIRMATION_INVALID");
  }
  if (!input.client?.auth?.admin) throw new Error("AUTH_ADMIN_CLIENT_INVALID");

  const admin = input.client.auth.admin;
  const findExactEmail = async (normalizedEmail: string): Promise<AuthProviderUser | null> => {
    for (let page = 1; page <= 100; page += 1) {
      const result = await admin.listUsers({ page, perPage: 100 });
      assertSupabaseSuccess(result);
      const matches = result.data.users.filter((user) =>
        typeof user.email === "string" && normalizeProviderEmail(user.email) === normalizedEmail
      );
      if (matches.length > 1) throw new Error("AUTH_ADMIN_EMAIL_DUPLICATE");
      if (matches[0]) return mapSupabaseUser(matches[0]);
      if (result.data.nextPage == null && (result.data.lastPage == null || page >= result.data.lastPage)) return null;
    }
    throw new Error("AUTH_ADMIN_LIST_LIMIT_EXCEEDED");
  };
  return {
    async findUserById(userId) {
      const result = await admin.getUserById(userId);
      assertSupabaseSuccess(result);
      return result.data.user ? mapSupabaseUser(result.data.user) : null;
    },
    async findUserByEmail(normalizedEmail) {
      return findExactEmail(normalizedEmail);
    },
    async inviteUser(inviteInput) {
      const owner = inviteOwnershipValue(inviteInput.idempotencyKey);
      const existing = await findExactEmail(inviteInput.normalizedEmail);
      if (existing) {
        const found = await admin.getUserById(existing.id);
        assertSupabaseSuccess(found);
        if (!found.data.user || readInviteOwner(found.data.user) !== owner) {
          throw new Error("AUTH_ADMIN_INVITE_IDEMPOTENCY_CONFLICT");
        }
        return {
          operationId: providerOperationId("invite", inviteInput.idempotencyKey, existing.id),
          invitationId: existing.id,
          userId: existing.id
        };
      }
      const result = await admin.inviteUserByEmail(inviteInput.normalizedEmail, {
        data: { maintenance_invite_owner: owner }
      });
      assertSupabaseSuccess(result);
      if (!result.data.user) throw new Error("AUTH_ADMIN_INVITE_RESPONSE_INVALID");
      const user = mapSupabaseUser(result.data.user);
      return {
        operationId: providerOperationId("invite", inviteInput.idempotencyKey, user.id),
        invitationId: user.id,
        userId: user.id
      };
    },
    async setUserDisabled(disableInput) {
      const currentResult = await admin.getUserById(disableInput.userId);
      assertSupabaseSuccess(currentResult);
      if (!currentResult.data.user) throw new Error("AUTH_ADMIN_UPDATE_RESPONSE_INVALID");
      const current = mapSupabaseUser(currentResult.data.user);
      if (current.disabled === disableInput.disabled) {
        return {
          operationId: providerOperationId("disable", disableInput.idempotencyKey, current.id),
          userId: current.id
        };
      }
      const result = await admin.updateUserById(disableInput.userId, {
        ban_duration: disableInput.disabled ? "876000h" : "none"
      });
      assertSupabaseSuccess(result);
      if (!result.data.user) throw new Error("AUTH_ADMIN_UPDATE_RESPONSE_INVALID");
      const user = mapSupabaseUser(result.data.user);
      return {
        operationId: providerOperationId("disable", disableInput.idempotencyKey, user.id),
        userId: user.id
      };
    },
    async removeInvitation(removeInput) {
      const found = await admin.getUserById(removeInput.invitationId);
      assertSupabaseSuccess(found);
      if (!found.data.user || readInviteOwner(found.data.user) !== inviteOwnershipValue(removeInput.ownershipKey)) {
        throw new Error("AUTH_ADMIN_INVITATION_OWNERSHIP_MISMATCH");
      }
      const deleted = await admin.deleteUser(removeInput.invitationId, false);
      assertSupabaseSuccess(deleted);
      return {
        operationId: providerOperationId("remove-invite", removeInput.idempotencyKey, removeInput.invitationId),
        userId: removeInput.invitationId
      };
    }
  };
}

export function normalizeProviderEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || /[^\x21-\x7e]/u.test(normalized)) {
    throw new Error("AUTH_EMAIL_INVALID");
  }
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) {
    throw new Error("AUTH_EMAIL_INVALID");
  }
  return normalized;
}

export function redactProviderError(error: unknown): Error {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message)) {
    return error;
  }
  return new Error("AUTH_PROVIDER_OPERATION_FAILED");
}

function parseProviderOrigin(value: string): URL {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("AUTH_PROVIDER_ORIGIN_INVALID");
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("AUTH_PROVIDER_ORIGIN_INVALID");
  }
  return origin;
}

function assertProjectRef(value: string): string {
  if (!/^[a-z]{20}$/u.test(value)) {
    throw new Error("AUTH_PROJECT_REF_INVALID");
  }
  return value;
}

function assertOpaqueId(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function assertIdempotencyKey(value: string): string {
  return assertOpaqueId(value, "AUTH_IDEMPOTENCY_KEY_INVALID");
}

function validateProviderUser(user: AuthProviderUser): AuthProviderUser {
  return {
    id: assertOpaqueId(user.id, "AUTH_PROVIDER_RESPONSE_INVALID"),
    email: normalizeProviderEmail(user.email),
    emailVerified: user.emailVerified === true,
    disabled: user.disabled === true
  };
}

function validateMutationReceipt(receipt: ProviderMutationReceipt): ProviderMutationReceipt {
  return {
    operationId: assertOpaqueId(receipt.operationId, "AUTH_PROVIDER_RESPONSE_INVALID"),
    userId: assertOpaqueId(receipt.userId, "AUTH_PROVIDER_RESPONSE_INVALID")
  };
}

function validateInviteReceipt(receipt: ProviderInviteReceipt): ProviderInviteReceipt {
  return {
    ...validateMutationReceipt(receipt),
    invitationId: assertOpaqueId(receipt.invitationId, "AUTH_PROVIDER_RESPONSE_INVALID")
  };
}

function assertSupabaseSuccess<T>(result: SupabaseAdminResult<T>): void {
  if (!result || typeof result !== "object" || result.error) throw new Error("AUTH_ADMIN_PROVIDER_OPERATION_FAILED");
}

function mapSupabaseUser(user: SupabaseAdminUser): AuthProviderUser {
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    throw new Error("AUTH_ADMIN_PROVIDER_RESPONSE_INVALID");
  }
  return validateProviderUser({
    id: user.id,
    email: user.email,
    emailVerified: typeof user.email_confirmed_at === "string" || typeof user.confirmed_at === "string",
    disabled: typeof user.banned_until === "string" && Date.parse(user.banned_until) > Date.now()
  });
}

function readInviteOwner(user: SupabaseAdminUser): string | null {
  if (!user.user_metadata || typeof user.user_metadata !== "object" || Array.isArray(user.user_metadata)) return null;
  const value = (user.user_metadata as Record<string, unknown>).maintenance_invite_owner;
  return typeof value === "string" ? value : null;
}

function inviteOwnershipValue(idempotencyKey: string): string {
  return createHash("sha256").update(`auth-invite-owner/v1\0${idempotencyKey}`).digest("hex");
}

function providerOperationId(domain: string, idempotencyKey: string, userId: string): string {
  return `provider-op:${createHash("sha256")
    .update(`${domain}\0${idempotencyKey}\0${userId}`)
    .digest("hex")}`;
}
