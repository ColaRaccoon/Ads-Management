import { Module } from "@nestjs/common";
import { MappingsModule } from "../mappings/mappings.module";
import { MetaEntityWriterService } from "../uploads/meta-entity-writer.service";
import { MetaMetricVersionService } from "../uploads/meta-metric-version.service";
import { CanonicalApiWriterService } from "./canonical-api-writer.service";
import { Cafe24CanonicalWriterService } from "./cafe24-canonical-writer.service";
import { CredentialVault } from "./credential-vault";
import { Cafe24ConnectionController, Cafe24OauthCallbackController, DailySyncMachineController, SourceConnectionsController, SourceCoverageController, SyncRunsController } from "./daily-sync.controller";
import { SourceConnectionsService } from "./source-connections.service";
import { SyncFoundationService } from "./sync-foundation.service";
import { GoogleAdsClient } from "./google-ads.client";
import { GoogleCanonicalWriterService } from "./google-canonical-writer.service";
import { GoogleSyncRunnerService } from "./google-sync-runner.service";
import { GoogleConnectionVerifierService } from "./google-connection-verifier.service";
import { MetaAdsClient } from "./meta-ads.client";
import { MetaDayReader } from "./meta-day-reader";
import { configuredMetaMcpClient } from "./meta-mcp-ads.client";
import { MetaSyncRunnerService } from "./meta-sync-runner.service";
import { MetaCredentialBindingService } from "./meta-credential-binding.service";
import { MetaConnectionVerifierService } from "./meta-connection-verifier.service";
import { MetaCredentialResolver, configuredMetaTransport } from "./meta-credential-resolver";
import { configuredMetaCredentialResolver } from "./meta-protected-credential-resolver";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { Cafe24OrdersClient } from "./cafe24-orders.client";
import { PrismaService } from "../common/prisma.service";
import { Cafe24SyncRunnerService } from "./cafe24-sync-runner.service";
import { ScheduledSyncService } from "./scheduled-sync.service";
import { syncError } from "./sync-contract";

@Module({
  imports: [MappingsModule],
  controllers: [SourceConnectionsController, SyncRunsController, SourceCoverageController, DailySyncMachineController,
    Cafe24ConnectionController, Cafe24OauthCallbackController],
  providers: [SourceConnectionsService, SyncFoundationService, ScheduledSyncService, CredentialVault,
    MetaEntityWriterService, MetaMetricVersionService, CanonicalApiWriterService,
    Cafe24CanonicalWriterService,
    { provide: GoogleAdsClient, useFactory: () => new GoogleAdsClient() },
    GoogleCanonicalWriterService, GoogleSyncRunnerService, GoogleConnectionVerifierService,
    { provide: MetaAdsClient, useFactory: () => new MetaAdsClient() },
    { provide: MetaDayReader, useFactory: (graph: MetaAdsClient): MetaDayReader => {
      if (configuredMetaTransport() !== "MCP") return graph;
      let client: ReturnType<typeof configuredMetaMcpClient> | undefined;
      return {
        transport: "MCP",
        async fetchDay(input) {
          if (!client) {
            try { client = configuredMetaMcpClient(); }
            catch { syncError("PROVIDER_AUTH_REQUIRED"); }
          }
          return client.fetchDay(input);
        }
      };
    }, inject: [MetaAdsClient] },
    MetaSyncRunnerService, MetaCredentialBindingService, MetaConnectionVerifierService,
    { provide: MetaCredentialResolver, useFactory: () => configuredMetaCredentialResolver() },
    Cafe24SyncRunnerService,
    { provide: Cafe24OauthService,
      useFactory: (prisma: PrismaService, vault: CredentialVault) =>
        new Cafe24OauthService(prisma, vault), inject: [PrismaService, CredentialVault] },
    { provide: Cafe24OrdersClient,
      useFactory: (prisma: PrismaService, oauth: Cafe24OauthService) =>
        new Cafe24OrdersClient(prisma, oauth), inject: [PrismaService, Cafe24OauthService] }],
  exports: [SyncFoundationService, CredentialVault, CanonicalApiWriterService]
})
export class DailySyncModule {}
