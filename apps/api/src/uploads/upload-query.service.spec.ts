import { describe, expect, it } from "vitest";
import { UploadQueryService } from "./upload-query.service";

describe("UploadQueryService", () => {
  it("preserves list, preview, and error query contracts", async () => {
    const calls: Array<{ operation: string; args: unknown }> = [];
    const batch = {
      id: "batch-1",
      originalFilename: "meta.csv",
      columnSchema: { previewSummary: { rowCount: 2 } }
    };
    const prisma = {
      uploadBatch: {
        findMany: async (args: unknown) => {
          calls.push({ operation: "list", args });
          return [batch];
        },
        findUnique: async (args: unknown) => {
          calls.push({ operation: "batch", args });
          return batch;
        }
      },
      uploadRow: {
        findMany: async (args: { where: { validationStatus?: string } }) => {
          calls.push({ operation: args.where.validationStatus ? "unmatched" : "rows", args });
          return args.where.validationStatus ? [{ id: "unmatched-1" }] : [{ id: "row-1" }];
        }
      },
      uploadRowError: {
        findMany: async (args: { orderBy: unknown }) => {
          calls.push({ operation: Array.isArray(args.orderBy) ? "uploadErrors" : "previewErrors", args });
          return [{ id: "error-1" }];
        }
      }
    };
    const service = new UploadQueryService(prisma as never);

    const uploads = await service.listUploads();
    const preview = await service.previewUpload("batch-1");
    const errors = await service.uploadErrors("batch-1");

    expect(uploads).toEqual([expect.objectContaining({ id: "batch-1", originalFilename: "meta.csv" })]);
    expect(preview).toMatchObject({
      batch: { id: "batch-1", originalFilename: "meta.csv" },
      rows: [{ id: "row-1" }],
      errors: [{ id: "error-1" }],
      unmatched: [{ id: "unmatched-1" }],
      summary: { rowCount: 2 }
    });
    expect(errors).toEqual([{ id: "error-1" }]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "list",
        args: expect.objectContaining({ take: 50, orderBy: { uploadedAt: "desc" } })
      }),
      expect.objectContaining({
        operation: "rows",
        args: expect.objectContaining({ where: { uploadBatchId: "batch-1" }, take: 200 })
      }),
      expect.objectContaining({
        operation: "uploadErrors",
        args: expect.objectContaining({
          where: { uploadBatchId: "batch-1" },
          orderBy: [{ rowNumber: "asc" }, { columnName: "asc" }]
        })
      })
    ]));
  });
});
