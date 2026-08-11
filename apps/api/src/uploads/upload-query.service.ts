import { Injectable } from "@nestjs/common";
import { RowValidationStatus } from "@prisma/client";
import { normalizeUploadedFilename } from "../common/encoding";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class UploadQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listUploads(take = 50) {
    const uploads = await this.prisma.uploadBatch.findMany({
      take,
      orderBy: { uploadedAt: "desc" },
      include: { _count: { select: { rows: true, errors: true, metrics: true, adMetrics: true } } }
    });
    return uploads.map((upload) => ({
      ...upload,
      originalFilename: normalizeUploadedFilename(upload.originalFilename)
    }));
  }

  async previewUpload(id: string) {
    const [batch, rows, errors, unmatched] = await Promise.all([
      this.prisma.uploadBatch.findUnique({ where: { id } }),
      this.prisma.uploadRow.findMany({ where: { uploadBatchId: id }, orderBy: { rowNumber: "asc" }, take: 200 }),
      this.prisma.uploadRowError.findMany({ where: { uploadBatchId: id }, orderBy: { rowNumber: "asc" } }),
      this.prisma.uploadRow.findMany({
        where: { uploadBatchId: id, validationStatus: RowValidationStatus.UNMATCHED },
        orderBy: { rowNumber: "asc" }
      })
    ]);
    return {
      batch: batch ? { ...batch, originalFilename: normalizeUploadedFilename(batch.originalFilename) } : batch,
      rows,
      errors,
      unmatched,
      summary:
        typeof batch?.columnSchema === "object" && batch.columnSchema && "previewSummary" in batch.columnSchema
          ? (batch.columnSchema as { previewSummary?: unknown }).previewSummary
          : null
    };
  }

  uploadErrors(id: string) {
    return this.prisma.uploadRowError.findMany({
      where: { uploadBatchId: id },
      orderBy: [{ rowNumber: "asc" }, { columnName: "asc" }]
    });
  }
}
