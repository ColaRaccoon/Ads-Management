import { configuredMetaTransport } from "./meta-credential-resolver";
import { syncError } from "./sync-contract";
import type { MetaDaySnapshot } from "./meta-ads.client";
import { validCurrentMetadata } from "../domain/meta-current-metadata";

export function assertMetaOperatingGate(transport: "GRAPH" | "MCP", env: NodeJS.ProcessEnv = process.env) {
  if (configuredMetaTransport(env) !== transport) syncError("PROVIDER_AUTH_REQUIRED");
  if (transport === "MCP") {
    // The documented own-account MCP use case is separate from Marketing API access tiers.
    if (env.DAILY_SYNC_META_MCP_USE_CASE !== "OWN_ACCOUNT_INTERNAL_REPORTING") syncError("FIELD_UNSUPPORTED");
  } else if (!["FULL", "LIMITED_INTERNAL_APPROVED"].includes(env.DAILY_SYNC_META_OPERATING_TIER ?? ""))
    syncError("FIELD_UNSUPPORTED");
}

export function assertMetaSnapshotTransport(snapshot: MetaDaySnapshot, transport: "GRAPH" | "MCP") {
  if (transport === "MCP") {
    if (snapshot.transport !== "MCP" || snapshot.protocolVersion !== "2025-06-18" ||
        snapshot.settings.actionReportTime !== "MCP_PROVIDER_DEFAULT_UNVERIFIED" ||
        snapshot.settings.attributionWindows.length !== 0 ||
        [...snapshot.ads, ...snapshot.adsets].some(row => row.actionReportTime !== "MCP_PROVIDER_DEFAULT_UNVERIFIED" ||
          row.attributionWindows.length !== 0 || !validCurrentMetadata(row.currentMetadata) ||
          row.currentMetadata?.sourceContext?.transport !== "MCP")) syncError("ATTRIBUTION_MISMATCH");
  } else if (snapshot.transport === "MCP" || snapshot.settings.actionReportTime === "MCP_PROVIDER_DEFAULT_UNVERIFIED" ||
      [...snapshot.ads, ...snapshot.adsets].some(row => row.actionReportTime === "MCP_PROVIDER_DEFAULT_UNVERIFIED" ||
        row.currentMetadata?.sourceContext?.transport === "MCP")) syncError("ATTRIBUTION_MISMATCH");
}
