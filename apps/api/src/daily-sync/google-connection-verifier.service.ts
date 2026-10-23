import { Injectable } from "@nestjs/common";
import { Prisma, SecurityAuditActorType, SecurityAuditResult, SourceDataKind, SourceKind } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { GoogleAdsClient } from "./google-ads.client";
import { CredentialVault } from "./credential-vault";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertEnabled, parseDateRange, parseIsoDate, syncError } from "./sync-contract";

/** Explicit, audited gate for an initially disabled Google connection. */
@Injectable()
export class GoogleConnectionVerifierService {
  constructor(private readonly prisma: PrismaService, private readonly vault: CredentialVault,
    private readonly client: GoogleAdsClient) {}

  async bindConfiguredAuth(connectionId: string, actorUserId: string | null) {
    assertEnabled();
    const ref = process.env.DAILY_SYNC_GOOGLE_CREDENTIAL_REF;
    if (!ref || !/^vault:\/\/google\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref))
      syncError("PROVIDER_AUTH_REQUIRED");
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "GOOGLE" ||
        !accountAllowlist().has(accountKey(connection.provider,
          connection.externalAccountId, connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    if (connection.credentialRef === ref)
      return { accessState: connection.accessState, enabled: connection.enabled };
    return this.vault.bindStaticCredentialRef(connectionId, "GOOGLE", ref,
      connection.credentialRef, null, actorUserId);
  }

  async verifyAndActivate(input: {
    connectionId: string; verificationDay: string; observedAccountCostKrw: string;
    fromDate: string; actorUserId: string | null;
  }) {
    assertEnabled();
    const day = parseDateRange(input.verificationDay, input.verificationDay,
      new Date(), "Asia/Seoul").from;
    const fromDate = parseIsoDate(input.fromDate);
    if (fromDate > day || day.getTime() - fromDate.getTime() >= 30 * 86_400_000 ||
        !/^(0|[1-9]\d{0,14})$/.test(input.observedAccountCostKrw))
      syncError("RUN_LIMIT_EXCEEDED", 400);
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: input.connectionId } });
    if (!connection || connection.provider !== "GOOGLE" ||
        !accountAllowlist().has(accountKey(connection.provider,
          connection.externalAccountId, connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const ref = await this.vault.staticCredentialRefForVerification(input.connectionId, "GOOGLE");
    if (process.env.DAILY_SYNC_GOOGLE_CREDENTIAL_REF !== ref) syncError("PROVIDER_AUTH_REQUIRED");
    const loginCustomerId = process.env.DAILY_SYNC_GOOGLE_LOGIN_CUSTOMER_ID ?? null;
    const snapshot = await this.client.fetchDay({
      customerId: connection.externalAccountId, day: input.verificationDay,
      deadlineAt: Date.now() + 60_000, loginCustomerId
    });
    if (snapshot.currencyCode !== connection.currencyCode) syncError("CURRENCY_MISMATCH");
    if (snapshot.timeZone !== connection.timeZone) syncError("TIMEZONE_MISMATCH");
    const roundedKrw = (snapshot.accountCostMicros + 500_000n) / 1_000_000n;
    if (roundedKrw.toString() !== input.observedAccountCostKrw)
      syncError("RECONCILIATION_FAILED");
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{
        provider: string; credential_ref: string | null; access_state: string;
        currency_code: string; time_zone: string;
      }>>(Prisma.sql`SELECT "provider"::text AS "provider", "credential_ref",
        "access_state"::text AS "access_state", "currency_code", "time_zone"
        FROM "source_connections" WHERE "id" = ${input.connectionId}::uuid FOR UPDATE`);
      const current = locked[0];
      if (current?.provider !== "GOOGLE" || current.credential_ref !== ref ||
          current.access_state === "BLOCKED") syncError("PROVIDER_AUTH_REQUIRED");
      if (current.currency_code !== snapshot.currencyCode) syncError("CURRENCY_MISMATCH");
      if (current.time_zone !== snapshot.timeZone) syncError("TIMEZONE_MISMATCH");
      const policies = await tx.sourcePolicy.findMany({ where: {
        connectionId: input.connectionId, dataKind: SourceDataKind.GOOGLE_CAMPAIGN
      } });
      if (policies.length && (policies.length !== 1 ||
          policies[0].primarySource !== SourceKind.API ||
          policies[0].fromDate.getTime() !== fromDate.getTime() || policies[0].toDate !== null))
        syncError("SOURCE_SELECTION_REQUIRED");
      if (!policies.length) await tx.sourcePolicy.create({ data: {
        connectionId: input.connectionId, dataKind: SourceDataKind.GOOGLE_CAMPAIGN,
        fromDate, primarySource: SourceKind.API, version: 1,
        changedByUserId: input.actorUserId, reason: "GOOGLE_READ_VERIFIED"
      } });
      await tx.sourceConnection.update({ where: { id: input.connectionId }, data: {
        accessState: "READY", enabled: true
      } });
      await writeSecurityAudit(tx, { actorType: input.actorUserId
          ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
        actorUserId: input.actorUserId, action: "GOOGLE_CONNECTION_VERIFIED",
        targetType: "SOURCE_CONNECTION", targetId: input.connectionId,
        result: SecurityAuditResult.SUCCESS,
        afterJson: { verificationDay: input.verificationDay,
          fromDate: input.fromDate, accountCostKrw: roundedKrw.toString(),
          currencyCode: snapshot.currencyCode, timeZone: snapshot.timeZone,
          rowCount: snapshot.rows.length, googleRequestId: snapshot.requestId } });
      return { accessState: "READY", enabled: true, verifiedDay: input.verificationDay,
        rowCount: snapshot.rows.length, accountCostKrw: roundedKrw.toString(),
        requestId: snapshot.requestId };
    }, { timeout: 5_000, maxWait: 2_000 });
  }
}
