import { describe, expect, it } from "vitest";
import { ConflictPolicy, MatchSource, RowValidationStatus, UploadStatus } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAFE24_ORDER_COLUMN_ALIASES } from "../domain/cafe24-csv";
import {
  Cafe24UploadsService,
  effectiveCafe24OrderLineKey,
  isCompleteCafe24UploadBatch,
  resolveCafe24ImportConflictPolicy,
  resolveCafe24LineImportDecision,
  resolveCafe24LineStoredState
} from "./cafe24-uploads.service";
import { toDateOnly } from "../domain/date-number";

describe("Cafe24 upload current/version policy", () => {
  it("keeps duplicate natural keys non-current on SKIP", () => {
    expect(
      resolveCafe24LineImportDecision({
        conflictPolicy: ConflictPolicy.SKIP,
        existingCurrent: { id: "line-1", importVersion: 2 }
      })
    ).toEqual({
      importVersion: 2,
      isCurrent: false,
      supersedeExisting: false,
      skippedDuplicate: true
    });
  });

  it("replaces current rows on OVERWRITE and increments on NEW_VERSION", () => {
    expect(
      resolveCafe24LineImportDecision({
        conflictPolicy: ConflictPolicy.OVERWRITE,
        existingCurrent: { id: "line-1", importVersion: 2 }
      })
    ).toMatchObject({ importVersion: 2, isCurrent: true, supersedeExisting: true });
    expect(
      resolveCafe24LineImportDecision({
        conflictPolicy: ConflictPolicy.NEW_VERSION,
        existingCurrent: { id: "line-1", importVersion: 2 }
      })
    ).toMatchObject({ importVersion: 3, isCurrent: true, supersedeExisting: true });
  });

  it("retries incomplete duplicate uploads by replacing their current rows", () => {
    expect(
      resolveCafe24ImportConflictPolicy({
        conflictPolicy: ConflictPolicy.SKIP,
        duplicatedIsIncomplete: true
      })
    ).toBe(ConflictPolicy.OVERWRITE);
    expect(
      resolveCafe24ImportConflictPolicy({
        conflictPolicy: ConflictPolicy.SKIP,
        duplicatedIsIncomplete: false
      })
    ).toBe(ConflictPolicy.SKIP);
  });

  it("uses saved row coverage as the Cafe24 upload completion check", () => {
    expect(isCompleteCafe24UploadBatch({ rowCount: 196, storedRowCount: 196 })).toBe(true);
    expect(isCompleteCafe24UploadBatch({ rowCount: 196, storedRowCount: 56 })).toBe(false);
  });

  it("stores parsing-error rows as non-current while using the raw natural key", () => {
    const decision = resolveCafe24LineImportDecision({
      conflictPolicy: ConflictPolicy.OVERWRITE,
      existingCurrent: { id: "line-current", importVersion: 4 }
    });

    expect(
      resolveCafe24LineStoredState({
        validationStatus: RowValidationStatus.ERROR,
        decision
      })
    ).toMatchObject({ importVersion: 4, isCurrent: false, supersedeExisting: false });

    expect(effectiveCafe24OrderLineKey(null, rawCafe24Row())).toBe("20260611-000001:20260611-000001-01:120:Wavebar black");
  });

  it("creates parsing-error rows outside the current unique index", async () => {
    const prisma = fakeSavePrisma({
      existingCurrent: { id: "line-current", importVersion: 4 }
    });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await (
      service as unknown as {
        saveCafe24OrderLine: (input: Record<string, unknown>) => Promise<unknown>;
      }
    ).saveCafe24OrderLine({
      conflictPolicy: ConflictPolicy.OVERWRITE,
      batchId: "batch-invalid",
      rowNumber: 2,
      sourceRowHash: "row-hash",
      orderLineKey: effectiveCafe24OrderLineKey(null, rawCafe24Row()),
      parsedRow: null,
      rawRow: rawCafe24Row(),
      sanitizedRawRow: rawCafe24Row(),
      productId: null,
      cafe24ProductRuleId: null,
      matchSource: MatchSource.UNMATCHED,
      validationStatus: RowValidationStatus.ERROR,
      validationErrors: []
    });

    expect(prisma.findManyCalls[0].where).toEqual({
      orderLineKey: "20260611-000001:20260611-000001-01:120:Wavebar black",
      isCurrent: true
    });
    expect(prisma.updateManyCalls).toEqual([]);
    expect(prisma.createCalls[0].data).toMatchObject({
      orderLineKey: "20260611-000001:20260611-000001-01:120:Wavebar black",
      importVersion: 4,
      isCurrent: false,
      validationStatus: RowValidationStatus.ERROR
    });
  });
});

describe("Cafe24UploadsService rematch", () => {
  it("rematches all current non-error lines with active rules", async () => {
    const prisma = fakeRematchPrisma();
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    const result = await service.rematchCafe24Lines({ from: "2026-06-11", to: "2026-06-11" });

    expect(prisma.cafe24OrderLine.findManyCalls[0].where).toMatchObject({
      isCurrent: true,
      validationStatus: { not: RowValidationStatus.ERROR }
    });
    expect(prisma.cafe24OrderLine.findManyCalls[0].where).not.toHaveProperty("productId");
    expect(result.matchedCount).toBe(1);
    expect(prisma.updates[0].data).toMatchObject({
      productId: "product-wavebar",
      cafe24ProductRuleId: "rule-wavebar",
      matchSource: MatchSource.RULE,
      validationStatus: RowValidationStatus.VALID
    });
    expect(prisma.deletes[0].where.errorCode.in).toEqual(["CAFE24_PRODUCT_UNMATCHED", "CAFE24_PRODUCT_AMBIGUOUS"]);
    expect(prisma.batchUpdates[0].data).toMatchObject({
      status: UploadStatus.IMPORTED,
      validRowCount: 1,
      warningCount: 0,
      errorCount: 0
    });
  });

  it("clears an existing product match when the current rules no longer match the line", async () => {
    const prisma = fakeRematchPrisma({
      rules: [
        {
          id: "rule-air-stepper-direct",
          productId: "product-air-stepper",
          displayName: "Air stepper direct",
          productNumbers: ["33"],
          productNameAliases: ["Air stepper"],
          optionIncludeKeywords: [],
          optionExcludeKeywords: [],
          priority: 1,
          validFrom: date("2026-01-01"),
          validTo: null,
          isActive: true,
          adCostSourceProductId: null,
          roasGroup: null
        }
      ],
      lines: [
        {
          id: "line-community-buy",
          uploadBatchId: "batch-1",
          rowNumber: 10,
          productNo: "137",
          productName: "[Creator X 공동구매] Air stepper",
          optionName: "[Creator X 공동구매] Air stepper(purple)",
          orderDate: date("2026-06-11"),
          productId: "product-air-stepper",
          cafe24ProductRuleId: "old-community-rule",
          matchSource: MatchSource.RULE,
          validationStatus: RowValidationStatus.VALID,
          validationErrors: []
        }
      ]
    });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    const result = await service.rematchCafe24Lines({ from: "2026-06-11", to: "2026-06-11" });

    expect(result).toMatchObject({ scannedCount: 1, matchedCount: 0, stillUnmatchedCount: 1, ambiguousCount: 0 });
    expect(prisma.updates[0].data).toMatchObject({
      productId: null,
      cafe24ProductRuleId: null,
      matchSource: MatchSource.UNMATCHED,
      validationStatus: RowValidationStatus.UNMATCHED
    });
    expect(prisma.creates[0].data[0]).toMatchObject({
      orderLineId: "line-community-buy",
      errorCode: "CAFE24_PRODUCT_UNMATCHED"
    });
  });

  it("does not scan incomplete current rows during rematch", async () => {
    const prisma = fakeRematchPrisma({ batchRowCount: 3, batchStoredRowCount: 1 });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    const result = await service.rematchCafe24Lines({ from: "2026-06-11", to: "2026-06-11" });

    expect(result.scannedCount).toBe(0);
    expect(prisma.cafe24OrderLine.findManyCalls).toEqual([]);
    expect(prisma.batchUpdates).toEqual([]);
  });

  it("preserves the original importedAt when refreshing a complete batch", async () => {
    const importedAt = new Date("2026-06-12T01:00:00.000Z");
    const prisma = fakeRematchPrisma({ batchImportedAt: importedAt });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await service.rematchCafe24Lines({ from: "2026-06-11", to: "2026-06-11" });

    expect(prisma.batchUpdates[0].data).toMatchObject({
      status: UploadStatus.IMPORTED,
      validRowCount: 1,
      importedAt
    });
  });
});

describe("Cafe24UploadsService duplicate upload guard", () => {
  it("treats a batch with fewer saved rows than parsed rows as incomplete", async () => {
    const service = new Cafe24UploadsService(
      {
        cafe24OrderLine: {
          count: async () => 56
        }
      } as never,
      {} as never
    );

    await expect(
      (
        service as unknown as {
          isIncompleteCafe24Upload: (batchId: string, rowCount: number) => Promise<boolean>;
        }
      ).isIncompleteCafe24Upload("batch-partial", 196)
    ).resolves.toBe(true);
  });

  it("reuses a completed repair batch with the same original file hash", async () => {
    const service = new Cafe24UploadsService(
      {
        cafe24UploadBatch: {
          findMany: async () => [
            { id: "batch-incomplete", rowCount: 196, importedAt: null },
            { id: "batch-repaired", rowCount: 196, importedAt: date("2026-06-12") }
          ]
        },
        cafe24OrderLine: {
          count: async (args: any) => (args.where.uploadBatchId === "batch-repaired" ? 196 : 56)
        }
      } as never,
      {} as never
    );

    await expect(
      (
        service as unknown as {
          findReusableCafe24Duplicate: (fileHashSha256: string) => Promise<{ id: string } | null>;
        }
      ).findReusableCafe24Duplicate("original-hash")
    ).resolves.toMatchObject({ id: "batch-repaired" });
  });

  it("marks an incomplete batch partial and demotes its current lines when refreshing counts", async () => {
    const updateManyCalls: any[] = [];
    const prisma = {
      cafe24UploadRowError: {
        count: async () => 0
      },
      cafe24UploadBatch: {
        findUnique: async () => ({ rowCount: 196, importedAt: null }),
        update: async (args: unknown) => args
      },
      cafe24OrderLine: {
        count: async (args: any) => (args.where.uploadBatchId === "batch-incomplete" ? 56 : 0),
        aggregate: async () => ({ _min: { orderDate: date("2026-06-11") }, _max: { orderDate: date("2026-06-11") } }),
        findMany: async (args: any) => {
          if (args.where?.uploadBatchId === "batch-incomplete" && args.where?.isCurrent) {
            return [{ orderLineKey: "order-key" }];
          }
          return [];
        },
        updateMany: async (args: unknown) => {
          updateManyCalls.push(args);
          return { count: 1 };
        }
      },
      $transaction: async (callback: (tx: unknown) => unknown) => callback({
        cafe24UploadBatch: {
          update: async (args: unknown) => args
        },
        cafe24OrderLine: {
          updateMany: async (args: unknown) => {
            updateManyCalls.push(args);
            return { count: 1 };
          },
          findMany: async (args: any) => {
            if (args.where?.uploadBatchId === "batch-incomplete" && args.where?.isCurrent) {
              return [{ orderLineKey: "order-key" }];
            }
            return [];
          },
          count: async () => 0
        }
      })
    };
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await (
      service as unknown as {
        refreshCafe24BatchIssueCounts: (batchIds: string[]) => Promise<void>;
      }
    ).refreshCafe24BatchIssueCounts(["batch-incomplete"]);

    expect(updateManyCalls[0]).toEqual({
      where: { orderLineKey: "order-key" },
      data: { isCurrent: false }
    });
  });
});

describe("Cafe24UploadsService deleteUpload", () => {
  it("restores the previous version as current when deleting a current upload batch", async () => {
    const prisma = fakeDeletePrisma();
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await service.deleteUpload("batch-new");

    expect(prisma.cafe24OrderLine.findManyCalls[0]).toMatchObject({
      where: { uploadBatchId: "batch-new" },
      select: { id: true, orderLineKey: true, isCurrent: true }
    });
    expect(prisma.cafe24OrderLine.deleteManyCalls[0]).toEqual({ where: { uploadBatchId: "batch-new" } });
    expect(prisma.cafe24OrderLine.updateManyCalls[0]).toEqual({
      where: { orderLineKey: "order-key" },
      data: { isCurrent: false }
    });
    expect(prisma.cafe24OrderLine.findManyCalls[1]).toMatchObject({
      where: {
        orderLineKey: "order-key",
        validationStatus: { not: RowValidationStatus.ERROR }
      },
      orderBy: [{ importVersion: "desc" }, { createdAt: "desc" }]
    });
    expect(prisma.cafe24OrderLine.updateCalls[0]).toEqual({
      where: { id: "line-old" },
      data: { isCurrent: true, supersededByOrderLineId: null }
    });
  });

  it("does not restore a remaining parsing-error row as current", async () => {
    const prisma = fakeDeletePrisma({
      remainingLines: [
        {
          id: "line-error-newer",
          orderLineKey: "order-key",
          importVersion: 9,
          validationStatus: RowValidationStatus.ERROR,
          createdAt: date("2026-06-12"),
          uploadBatchId: "batch-error",
          rowCount: 1,
          storedRowCount: 1
        },
        {
          id: "line-valid-older",
          orderLineKey: "order-key",
          importVersion: 3,
          validationStatus: RowValidationStatus.VALID,
          createdAt: date("2026-06-10"),
          uploadBatchId: "batch-complete",
          rowCount: 1,
          storedRowCount: 1
        }
      ]
    });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await service.deleteUpload("batch-new");

    expect(prisma.cafe24OrderLine.findManyCalls[1].where).toEqual({
      orderLineKey: "order-key",
      validationStatus: { not: RowValidationStatus.ERROR }
    });
    expect(prisma.cafe24OrderLine.updateCalls[0]).toEqual({
      where: { id: "line-valid-older" },
      data: { isCurrent: true, supersededByOrderLineId: null }
    });
  });

  it("does not restore a remaining row from an incomplete batch as current", async () => {
    const prisma = fakeDeletePrisma({
      remainingLines: [
        {
          id: "line-incomplete-newer",
          orderLineKey: "order-key",
          importVersion: 9,
          validationStatus: RowValidationStatus.VALID,
          createdAt: date("2026-06-12"),
          uploadBatchId: "batch-incomplete",
          rowCount: 196,
          storedRowCount: 56
        },
        {
          id: "line-complete-older",
          orderLineKey: "order-key",
          importVersion: 3,
          validationStatus: RowValidationStatus.VALID,
          createdAt: date("2026-06-10"),
          uploadBatchId: "batch-complete",
          rowCount: 196,
          storedRowCount: 196
        }
      ]
    });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await service.deleteUpload("batch-new");

    expect(prisma.cafe24OrderLine.findManyCalls[1].where).toEqual({
      orderLineKey: "order-key",
      validationStatus: { not: RowValidationStatus.ERROR }
    });
    expect(prisma.cafe24OrderLine.updateCalls[0]).toEqual({
      where: { id: "line-complete-older" },
      data: { isCurrent: true, supersededByOrderLineId: null }
    });
  });

  it("does not restore a remaining row from a non-imported batch status as current", async () => {
    const prisma = fakeDeletePrisma({
      remainingLines: [
        {
          id: "line-validating-newer",
          orderLineKey: "order-key",
          importVersion: 9,
          validationStatus: RowValidationStatus.VALID,
          createdAt: date("2026-06-12"),
          uploadBatchId: "batch-validating",
          rowCount: 196,
          storedRowCount: 196,
          status: UploadStatus.VALIDATING
        },
        {
          id: "line-imported-older",
          orderLineKey: "order-key",
          importVersion: 3,
          validationStatus: RowValidationStatus.VALID,
          createdAt: date("2026-06-10"),
          uploadBatchId: "batch-imported",
          rowCount: 196,
          storedRowCount: 196,
          status: UploadStatus.IMPORTED
        }
      ]
    });
    const service = new Cafe24UploadsService(prisma as never, {} as never);

    await service.deleteUpload("batch-new");

    expect(prisma.cafe24OrderLine.updateCalls[0]).toEqual({
      where: { id: "line-imported-older" },
      data: { isCurrent: true, supersededByOrderLineId: null }
    });
  });
});

describe("Cafe24 current-version migration", () => {
  it("does not backfill ERROR rows as current", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260611001000_add_cafe24_order_line_current_versions/migration.sql"),
      "utf8"
    );

    expect(sql).toContain(`WHERE "validation_status" <> 'ERROR'`);
    expect(sql).toMatch(/SET "is_current" = false\s+WHERE "validation_status" = 'ERROR'/);
  });
});

function fakeRematchPrisma(
  input: {
    rules?: Array<Record<string, unknown>>;
    lines?: Array<Record<string, unknown>>;
    batchRowCount?: number;
    batchStoredRowCount?: number;
    batchImportedAt?: Date | null;
  } = {}
) {
  const updates: any[] = [];
  const deletes: any[] = [];
  const creates: any[] = [];
  const batchUpdates: any[] = [];
  const findManyCalls: any[] = [];
  const tx = {
    cafe24UploadBatch: {
      update: async (args: unknown) => {
        batchUpdates.push(args);
        return args;
      }
    },
    cafe24OrderLine: {
      update: async (args: unknown) => {
        updates.push(args);
        return args;
      },
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [],
      count: async () => 0
    },
    cafe24UploadRowError: {
      deleteMany: async (args: unknown) => {
        deletes.push(args);
        return { count: 1 };
      },
      createMany: async (args: unknown) => {
        creates.push(args);
        return { count: 1 };
      }
    }
  };

  return {
    updates,
    deletes,
    creates,
    batchUpdates,
    cafe24UploadRowError: {
      count: async () => 0
    },
    cafe24UploadBatch: {
      findMany: async () => [
        {
          id: "batch-1",
          rowCount: input.batchRowCount ?? 1,
          status: UploadStatus.IMPORTED,
          _count: { rows: input.batchStoredRowCount ?? 1 }
        }
      ],
      findUnique: async () => ({ rowCount: input.batchRowCount ?? 1, importedAt: input.batchImportedAt ?? null }),
      update: async (args: unknown) => {
        batchUpdates.push(args);
        return args;
      }
    },
    cafe24ProductRule: {
      findMany: async () =>
        input.rules ?? [
        {
          id: "rule-wavebar",
          productId: "product-wavebar",
          displayName: "Wavebar",
          productNumbers: ["120"],
          productNameAliases: [],
          optionIncludeKeywords: [],
          optionExcludeKeywords: [],
          priority: 1,
          validFrom: date("2026-01-01"),
          validTo: null,
          isActive: true,
          adCostSourceProductId: null,
          roasGroup: null
        }
      ]
    },
    cafe24OrderLine: {
      findManyCalls,
      count: async () => 1,
      aggregate: async () => ({
        _min: { orderDate: date("2026-06-11") },
        _max: { orderDate: date("2026-06-11") }
      }),
      findMany: async (args: unknown) => {
        findManyCalls.push(args);
        return input.lines ?? [
          {
            id: "line-1",
            uploadBatchId: "batch-1",
            rowNumber: 2,
            productNo: "120",
            productName: "Wavebar",
            optionName: "Wavebar black",
            orderDate: date("2026-06-11"),
            validationErrors: [
              {
                errorCode: "CAFE24_PRODUCT_UNMATCHED",
                message: "old unmatched",
                severity: "WARNING"
              }
            ]
          }
        ];
      }
    },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(tx)
  };
}

function fakeSavePrisma(input: { existingCurrent: { id: string; importVersion: number } | null }) {
  const findManyCalls: any[] = [];
  const updateManyCalls: any[] = [];
  const createCalls: any[] = [];
  const tx = {
    cafe24OrderLine: {
      findMany: async (args: unknown) => {
        findManyCalls.push(args);
        return input.existingCurrent ? [input.existingCurrent] : [];
      },
      updateMany: async (args: unknown) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
      create: async (args: any) => {
        createCalls.push(args);
        return { id: "line-invalid", ...args.data };
      }
    }
  };

  return {
    findManyCalls,
    updateManyCalls,
    createCalls,
    $transaction: async (callback: (tx: unknown) => unknown) => callback(tx)
  };
}

function fakeDeletePrisma(
  input: {
    remainingLines?: Array<{
      id: string;
      uploadBatchId?: string;
      orderLineKey: string;
      importVersion: number;
      validationStatus: RowValidationStatus;
      createdAt: Date;
      rowCount?: number;
      storedRowCount?: number;
      status?: UploadStatus;
    }>;
  } = {}
) {
  const findManyCalls: any[] = [];
  const deleteManyCalls: any[] = [];
  const updateManyCalls: any[] = [];
  const updateCalls: any[] = [];
  const remainingLines = input.remainingLines ?? [
    {
      id: "line-old",
      uploadBatchId: "batch-old",
      orderLineKey: "order-key",
      importVersion: 1,
      validationStatus: RowValidationStatus.VALID,
      createdAt: date("2026-06-10"),
      rowCount: 1,
      storedRowCount: 1,
      status: UploadStatus.IMPORTED
    }
  ];
  const rowCoverageByBatch = new Map(
    remainingLines.map((line) => [line.uploadBatchId ?? "batch-old", { rowCount: line.rowCount ?? 1, storedRowCount: line.storedRowCount ?? 1 }])
  );
  const tx = {
    cafe24UploadRowError: {
      deleteMany: async () => ({ count: 1 })
    },
    cafe24OrderLine: {
      findMany: async (args: any) => {
        findManyCalls.push(args);
        if (args.where?.uploadBatchId) {
          return [{ id: "line-new", orderLineKey: "order-key", isCurrent: true }];
        }
        const excludedStatus = args.where?.validationStatus?.not;
        return remainingLines
          .filter((line) => line.orderLineKey === args.where?.orderLineKey)
          .filter((line) => !excludedStatus || line.validationStatus !== excludedStatus)
          .sort((left, right) => {
            const versionDelta = right.importVersion - left.importVersion;
            return versionDelta || right.createdAt.getTime() - left.createdAt.getTime();
          })
          .map((line) => ({
            id: line.id,
            uploadBatchId: line.uploadBatchId ?? "batch-old",
            batch: { rowCount: line.rowCount ?? 1, status: line.status ?? UploadStatus.IMPORTED }
          }));
      },
      count: async (args: any) => rowCoverageByBatch.get(args.where.uploadBatchId)?.storedRowCount ?? 0,
      deleteMany: async (args: unknown) => {
        deleteManyCalls.push(args);
        return { count: 1 };
      },
      updateMany: async (args: unknown) => {
        updateManyCalls.push(args);
        return { count: 1 };
      },
      update: async (args: unknown) => {
        updateCalls.push(args);
        return args;
      }
    },
    cafe24UploadBatch: {
      delete: async (args: unknown) => args
    }
  };

  return {
    cafe24OrderLine: {
      findManyCalls,
      deleteManyCalls,
      updateManyCalls,
      updateCalls
    },
    cafe24UploadBatch: {
      findUnique: async () => ({ id: "batch-new" })
    },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(tx)
  };
}

function rawCafe24Row() {
  return {
    [CAFE24_ORDER_COLUMN_ALIASES.orderNo[0]]: "20260611-000001",
    [CAFE24_ORDER_COLUMN_ALIASES.lineOrderNo[0]]: "20260611-000001-01",
    [CAFE24_ORDER_COLUMN_ALIASES.productNo[0]]: "120",
    [CAFE24_ORDER_COLUMN_ALIASES.optionName[0]]: "Wavebar black"
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) throw new Error(`Invalid test date: ${value}`);
  return parsed;
}
