import { AppRole, InviteStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { normalizeEmail, normalizeEmailOrNull } from "./email-normalizer";
import { IdentityProvider } from "./identity-provider";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BootstrapInput = {
  authUserId: string;
  email: string;
  dryRun: boolean;
};

export type BootstrapResult = {
  action: "create" | "update" | "unchanged";
  dryRun: boolean;
  appUserId: string | null;
};

export class BootstrapSuperAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: IdentityProvider
  ) {}

  async run(input: BootstrapInput): Promise<BootstrapResult> {
    if (!UUID_PATTERN.test(input.authUserId)) throw new Error("BOOTSTRAP_INVALID_AUTH_USER_ID");
    const normalizedEmail = normalizeEmail(input.email);
    const providerUser = await this.provider.getUserById(input.authUserId);
    if (
      providerUser.id !== input.authUserId ||
      !providerUser.emailVerified ||
      !providerUser.email ||
      normalizeEmailOrNull(providerUser.email) !== normalizedEmail
    ) {
      throw new Error("BOOTSTRAP_PROVIDER_IDENTITY_MISMATCH");
    }

    const target = await this.inspectTarget(input.authUserId, normalizedEmail, this.prisma);
    const action = target
      ? isDesiredState(target, input.authUserId, normalizedEmail)
        ? "unchanged"
        : "update"
      : "create";
    if (input.dryRun) return { action, dryRun: true, appUserId: target?.id ?? null };

    return this.prisma.$transaction(async (tx) => {
      const lockedTarget = await this.inspectTarget(input.authUserId, normalizedEmail, tx);
      if (!lockedTarget) {
        const created = await tx.appUser.create({
          data: {
            authUserId: input.authUserId,
            email: normalizedEmail,
            normalizedEmail,
            name: "Super Admin",
            role: AppRole.SUPER_ADMIN,
            inviteStatus: InviteStatus.ACTIVE,
            isActive: true,
            deactivatedAt: null
          }
        });
        return { action: "create", dryRun: false, appUserId: created.id };
      }
      if (isDesiredState(lockedTarget, input.authUserId, normalizedEmail)) {
        return { action: "unchanged", dryRun: false, appUserId: lockedTarget.id };
      }
      const updated = await tx.appUser.update({
        where: { id: lockedTarget.id },
        data: {
          authUserId: input.authUserId,
          email: normalizedEmail,
          normalizedEmail,
          role: AppRole.SUPER_ADMIN,
          inviteStatus: InviteStatus.ACTIVE,
          isActive: true,
          deactivatedAt: null,
          authzVersion: { increment: 1 }
        }
      });
      return { action: "update", dryRun: false, appUserId: updated.id };
    });
  }

  private async inspectTarget(
    authUserId: string,
    normalizedEmail: string,
    client: Pick<PrismaService, "appUser"> | Pick<Prisma.TransactionClient, "appUser">
  ) {
    const [bySubject, byEmail] = await Promise.all([
      client.appUser.findUnique({ where: { authUserId } }),
      client.appUser.findUnique({ where: { normalizedEmail } })
    ]);
    if (bySubject && byEmail && bySubject.id !== byEmail.id) {
      throw new Error("BOOTSTRAP_IDENTITY_ALREADY_LINKED");
    }
    if (bySubject?.normalizedEmail && bySubject.normalizedEmail !== normalizedEmail) {
      throw new Error("BOOTSTRAP_SUBJECT_EMAIL_CONFLICT");
    }
    if (byEmail?.authUserId && byEmail.authUserId !== authUserId) {
      throw new Error("BOOTSTRAP_EMAIL_SUBJECT_CONFLICT");
    }
    return bySubject ?? byEmail;
  }
}

function isDesiredState(
  user: {
    authUserId: string | null;
    normalizedEmail: string | null;
    email: string | null;
    role: AppRole;
    inviteStatus: InviteStatus;
    isActive: boolean;
    deactivatedAt: Date | null;
  },
  authUserId: string,
  normalizedEmail: string
) {
  return user.authUserId === authUserId &&
    user.normalizedEmail === normalizedEmail &&
    user.email === normalizedEmail &&
    user.role === AppRole.SUPER_ADMIN &&
    user.inviteStatus === InviteStatus.ACTIVE &&
    user.isActive &&
    user.deactivatedAt === null;
}

export function describeDatabaseTarget(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port || "5432",
    database: url.pathname.replace(/^\//, ""),
    schema: url.searchParams.get("schema") ?? "public"
  };
}
