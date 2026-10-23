import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { lockCanonicalConnection } from "../daily-sync/canonical-write-policy";
import { assertEnabled, syncError } from "../daily-sync/sync-contract";
import { accountAllowlist, accountKey } from "../daily-sync/source-connections.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { StorefrontEnabledInput } from "./storefront.dto";

@Injectable()
export class StorefrontControlService {
  constructor(private readonly prisma: PrismaService) {}

  async runs(id: string, page = 1) {
    assertEnabled();
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id }, select: { id: true } });
    if (!connection) throw new NotFoundException();
    const rows = await this.prisma.syncRun.findMany({ where: { connectionId: id },
      orderBy: [{ startedAt: { sort: "desc", nulls: "first" } }, { nextAttemptAt: "desc" }, { id: "desc" }], skip: (page - 1) * 50, take: 51,
      select: { id: true, fromDate: true, toDate: true, trigger: true, status: true,
        startedAt: true, finishedAt: true, safeErrorCode: true, attemptCount: true,
        rowsFetched: true, rowsPublished: true, nextAttemptAt: true } });
    return { items: rows.slice(0, 50), nextPage: rows.length > 50 ? page + 1 : null };
  }

  async setEnabled(id: string, input: StorefrontEnabledInput, actorUserId: string) {
    assertEnabled();
    return this.prisma.$transaction(async tx => {
      await lockCanonicalConnection(tx, id);
      const c = await tx.sourceConnection.findUnique({ where: { id } });
      if (!c) throw new NotFoundException();
      if (c.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new ConflictException({ code: "STALE_CONNECTION", message: "연결 상태가 바뀌었습니다. 새로고침해 주세요." });
      if (!accountAllowlist().has(accountKey(c.provider, c.externalAccountId, c.shopKey))) syncError("ACCOUNT_SCOPE_MISMATCH");
      // Pause/resume cannot race a publisher or become an activation bypass.
      const active = await tx.syncLease.findFirst({ where: { connectionId: id, expiresAt: { gt: new Date() } }, select: { connectionId: true } });
      if (active) throw new ConflictException({ code: "SYNC_IN_PROGRESS", message: "진행 중인 수집이 끝난 뒤 다시 시도해 주세요." });
      if (input.enabled && (c.accessState !== "READY" || !c.credentialRef ||
          c.credentialExpiresAt && c.credentialExpiresAt.getTime() <= Date.now())) syncError("PROVIDER_AUTH_REQUIRED");
      if (input.enabled && !c.enabled) {
        const policies = await tx.sourcePolicy.findMany({ where: { connectionId: id, primarySource: "API" }, select: { id: true } });
        if (!policies.length) syncError("SOURCE_SELECTION_REQUIRED");
      }
      if (c.enabled === input.enabled) return { id, enabled: c.enabled, updatedAt: c.updatedAt.toISOString() };
      const updated = await tx.sourceConnection.update({ where: { id }, data: { enabled: input.enabled } });
      await writeSecurityAudit(tx, { actorType: "USER", actorUserId, action: input.enabled ? "SOURCE_COLLECTION_RESUMED" : "SOURCE_COLLECTION_PAUSED",
        targetType: "SOURCE_CONNECTION", targetId: id, result: "SUCCESS", beforeJson: { enabled: c.enabled }, afterJson: { enabled: input.enabled } });
      return { id, enabled: updated.enabled, updatedAt: updated.updatedAt.toISOString() };
    }, { timeout: 5_000 });
  }
}
