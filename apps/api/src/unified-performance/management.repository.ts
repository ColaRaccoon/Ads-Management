import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma, UnifiedProduct, UnifiedRule } from "@prisma/client";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

export type ManagementTransaction = Prisma.TransactionClient;
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export function managementVersions(products: UnifiedProduct[], rules: UnifiedRule[]) {
  const productRevisions = products.map(row => [row.id, row.version, row.canonicalName, row.normalizedName, row.active]).sort();
  const revision = (rows: UnifiedRule[]) => rows.map(row => [row.id, row.version,
    hash([row.kind, row.productId, row.platform, row.scopeKey, row.identityKey, row.payload, row.validFrom, row.validTo, row.active])]).sort();
  return { configurationVersion: hash([productRevisions, revision(rules)]),
    nameRuleVersion: hash([productRevisions, revision(rules.filter(row => row.kind === "NAME"))]),
    saleUnitRuleVersion: hash(revision(rules.filter(row => row.kind === "SALE_UNIT"))),
    allocationRuleVersion: hash(revision(rules.filter(row => row.kind === "ALLOCATION"))),
    scopePolicyVersion: hash(revision(rules.filter(row => row.kind === "SCOPE_POLICY"))) };
}
@Injectable()
export class UnifiedManagementRepository {
  constructor(private readonly prisma: PrismaService) {}

  read<T>(work: (tx: ManagementTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      return work(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  /** Snapshot boundary for adapters: never read catalog and revisions separately. */
  snapshot(tx?: ManagementTransaction) {
    const load = async (client: ManagementTransaction) => {
      const products = await client.unifiedProduct.findMany({ orderBy: { id: "asc" }, take: 10001 });
      const rules = await client.unifiedRule.findMany({ orderBy: { id: "asc" }, take: 10001 });
      if (products.length > 10000 || rules.length > 10000) throw new BadRequestException({ code: "UNIFIED_CONFIGURATION_TOO_LARGE", message: "설정 범위를 나누어 주세요." });
      return { products, rules, versions: managementVersions(products, rules) };
    };
    return tx ? load(tx) : this.read(load);
  }

  mutate<T>(work: (tx: ManagementTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      // One namespace serializes wildcard scopes and product renames as well as
      // identical predicates. Different kinds can depend on the same catalog.
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(21407, 2)::text AS locked`);
      return work(tx);
    }, { timeout: 15000 });
  }
}
