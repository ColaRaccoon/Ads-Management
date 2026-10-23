import type { MetaDaySnapshot, MetaReadSettings } from "./meta-ads.client";

export type MetaDayReadInput = { accountId: string; day: string; deadlineAt: number;
  settings: MetaReadSettings; accessToken: string };

/** DI token keeps the source transport explicit while sharing the canonical writer. */
export abstract class MetaDayReader {
  abstract readonly transport: "GRAPH" | "MCP";
  abstract fetchDay(input: MetaDayReadInput): Promise<MetaDaySnapshot>;
}
