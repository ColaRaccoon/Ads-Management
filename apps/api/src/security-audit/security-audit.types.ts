import {
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult
} from "@prisma/client";

export type SecurityAuditWrite = {
  actorUserId?: string | null;
  actorType: SecurityAuditActorType;
  action: string;
  targetType: string;
  targetId?: string | null;
  result: SecurityAuditResult;
  beforeJson?: Prisma.InputJsonValue | null;
  afterJson?: Prisma.InputJsonValue | null;
  requestId?: string | null;
};

export async function writeSecurityAudit(
  tx: Prisma.TransactionClient,
  event: SecurityAuditWrite
) {
  return tx.securityAuditEvent.create({
    data: securityAuditData(event)
  });
}

export function securityAuditData(event: SecurityAuditWrite): Prisma.SecurityAuditEventUncheckedCreateInput {
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(event.action)) {
    throw new Error("Invalid security audit action.");
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(event.targetType)) {
    throw new Error("Invalid security audit target type.");
  }
  if (event.targetId && event.targetId.length > 128) {
    throw new Error("Invalid security audit target id.");
  }
  if (
    (event.actorType === SecurityAuditActorType.USER && !event.actorUserId) ||
    (event.actorType !== SecurityAuditActorType.USER && event.actorUserId)
  ) {
    throw new Error("Invalid security audit actor.");
  }
  assertSafeAuditJson(event.beforeJson);
  assertSafeAuditJson(event.afterJson);
  return {
    actorUserId: event.actorUserId ?? null,
    actorType: event.actorType,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    result: event.result,
    beforeJson: event.beforeJson === null ? Prisma.JsonNull : event.beforeJson,
    afterJson: event.afterJson === null ? Prisma.JsonNull : event.afterJson,
    requestId: event.requestId ?? null
  };
}

export function assertSafeAuditJson(value: unknown, path = "$" ): void {
  if (value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeAuditJson(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_AUDIT_KEY_PARTS.some((part) => normalized.includes(part))) {
      throw new Error(`Sensitive audit key rejected at ${path}.`);
    }
    assertSafeAuditJson(child, `${path}.${key}`);
  }
}

const FORBIDDEN_AUDIT_KEY_PARTS = [
  "password", "token", "cookie", "secret", "authorization",
  "providerraw", "rawprovider", "accesstoken", "refreshtoken", "linkhash", "tokenhash"
] as const;

export function userAuditSnapshot(user: {
  id: string;
  email: string | null;
  name: string;
  role: string;
  isActive: boolean;
  inviteStatus: string;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    inviteStatus: user.inviteStatus
  } satisfies Prisma.InputJsonObject;
}
