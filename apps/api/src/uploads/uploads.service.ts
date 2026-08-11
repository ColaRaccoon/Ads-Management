import { Injectable } from "@nestjs/common";
import { ConflictPolicy } from "@prisma/client";
import { MetaAdDailyImportService } from "./meta-ad-daily-import.service";
import { MetaAdsetImportService } from "./meta-adset-import.service";
import { UploadLifecycleService } from "./upload-lifecycle.service";
import { UploadQueryService } from "./upload-query.service";

export { findMissingSnapshotMetricIds, nextImportVersion, snapshotAdMetricKey, snapshotMetricKey } from "./upload-keys";

@Injectable()
export class UploadsService {
  constructor(
    private readonly adDailyImportService: MetaAdDailyImportService,
    private readonly adsetImportService: MetaAdsetImportService,
    private readonly queryService: UploadQueryService,
    private readonly lifecycleService: UploadLifecycleService
  ) {}

  importMetaAdDailyCsv(file: Express.Multer.File | undefined, conflictPolicy: ConflictPolicy) {
    return this.adDailyImportService.importMetaAdDailyCsv(file, conflictPolicy);
  }

  importMetaAdsetCsv(file: Express.Multer.File | undefined, conflictPolicy: ConflictPolicy) {
    return this.adsetImportService.importMetaAdsetCsv(file, conflictPolicy);
  }

  listUploads(take = 50) {
    return this.queryService.listUploads(take);
  }

  previewUpload(id: string) {
    return this.queryService.previewUpload(id);
  }

  uploadErrors(id: string) {
    return this.queryService.uploadErrors(id);
  }

  deleteUpload(id: string) {
    return this.lifecycleService.deleteUpload(id);
  }
}
