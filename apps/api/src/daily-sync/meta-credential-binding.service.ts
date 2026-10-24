import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { CredentialVault } from "./credential-vault";
import { MetaCredentialResolver, resolveMetaCredential, configuredMetaTransport } from "./meta-credential-resolver";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertSourceAdministrationEnabled, syncError } from "./sync-contract";

/** Binds or rotates an opaque protected-store reference; never enables collection. */
@Injectable()
export class MetaCredentialBindingService {
  constructor(private readonly prisma: PrismaService, private readonly vault: CredentialVault,
    private readonly resolver: MetaCredentialResolver) {}

  async bindConfiguredAuth(connectionId: string, actorUserId: string) {
    assertSourceAdministrationEnabled();
    const transport = configuredMetaTransport();
    const ref = process.env.DAILY_SYNC_META_CREDENTIAL_REF;
    if (!ref || !/^vault:\/\/meta\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref) ||
        !this.resolver) syncError("PROVIDER_AUTH_REQUIRED");
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "META" ||
        !accountAllowlist().has(accountKey(connection.provider,
          connection.externalAccountId, connection.shopKey))) syncError("ACCOUNT_SCOPE_MISMATCH");
    const credential = await resolveMetaCredential(this.resolver, {
      credentialRef: ref, connectionId, accountId: connection.externalAccountId, transport
    });
    if (configuredMetaTransport() !== transport) syncError("PROVIDER_AUTH_REQUIRED");
    if (connection.credentialRef === ref) {
      if (connection.credentialExpiresAt?.getTime() !== credential.expiresAt.getTime())
        syncError("PROVIDER_AUTH_REQUIRED");
      return { accessState: connection.accessState, enabled: connection.enabled,
        credentialExpiresAt: connection.credentialExpiresAt };
    }
    return this.vault.bindStaticCredentialRef(connectionId, "META", ref,
      connection.credentialRef, credential.expiresAt, actorUserId);
  }
}
