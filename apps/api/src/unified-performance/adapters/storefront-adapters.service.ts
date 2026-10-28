import { Injectable } from "@nestjs/common";
import { assertAdapterBatch, assertAdapterRequest } from "../adapter-contract";
import { normalizePlatforms } from "../domain/platform-selection";
import { assertUnifiedEnabled } from "../management.service";
import type { AdapterBatch, AdapterRequest, SourceAdapter } from "../types";
import { MetaPerformanceAdapter } from "./meta.adapter";
import { GooglePerformanceAdapter } from "./google.adapter";
import { Cafe24PerformanceAdapter } from "./cafe24.adapter";

export type StorefrontPlatform = "META" | "GOOGLE" | "CAFE24";
export interface StorefrontSourceRequest { platform: StorefrontPlatform; request: AdapterRequest }
export type StorefrontSourceResult = {
  platform: StorefrontPlatform;
  scopeKeys: string[];
} & (
  { status: "READ"; batch: AdapterBatch; issue: null } |
  { status: "EXCLUDED_BY_USER"; batch: null; issue: null } |
  { status: "FAILED"; batch: null; issue: "SOURCE_READ_FAILED" }
);

/** Internal stage-03 boundary. No aggregate publication, source mutation, or report endpoint. */
export async function readStorefrontSources(
  inputs: readonly StorefrontSourceRequest[], adapters: Readonly<Record<StorefrontPlatform, SourceAdapter>>
): Promise<StorefrontSourceResult[]> {
  // Validate the entire dispatch envelope before any source is read.
  const keys = new Set<string>();
  for (const { platform, request } of inputs) {
    if (!["META", "GOOGLE", "CAFE24"].includes(platform)) throw new Error("Unsupported storefront platform.");
    normalizePlatforms(request.platforms);
    if (request.platforms.includes(platform)) assertAdapterRequest(request, platform);
    const key = JSON.stringify([platform, request.scopeKeys]);
    if (keys.has(key)) throw new Error("Duplicate storefront source scope.");
    keys.add(key);
  }
  return Promise.all(inputs.map(async ({ platform, request }): Promise<StorefrontSourceResult> => {
    const identity = { platform, scopeKeys: [...request.scopeKeys] };
    if (!request.platforms.includes(platform)) return { ...identity, status: "EXCLUDED_BY_USER", batch: null, issue: null };
    try {
      const batch = await adapters[platform].read(request);
      assertAdapterBatch(request, platform, batch);
      return { ...identity, status: "READ", batch, issue: null };
    } catch {
      // Raw database/provider errors may contain connection or order details.
      return { ...identity, status: "FAILED", batch: null, issue: "SOURCE_READ_FAILED" };
    }
  }));
}

@Injectable()
export class StorefrontAdaptersService {
  constructor(
    private readonly meta: MetaPerformanceAdapter,
    private readonly google: GooglePerformanceAdapter,
    private readonly cafe24: Cafe24PerformanceAdapter
  ) {}

  read(inputs: readonly StorefrontSourceRequest[]): Promise<StorefrontSourceResult[]> {
    assertUnifiedEnabled();
    return readStorefrontSources(inputs, { META: this.meta, GOOGLE: this.google, CAFE24: this.cafe24 });
  }
}
