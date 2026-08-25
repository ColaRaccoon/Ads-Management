import { Injectable, PipeTransform } from "@nestjs/common";
import type { UploadProfile } from "./upload-profiles";
import { preflightCoupangBundle, preflightUploadFile, type CoupangBundleFiles } from "./upload-preflight";

@Injectable()
export class SecureUploadPipe implements PipeTransform<Express.Multer.File | undefined> {
  constructor(private readonly profile: UploadProfile) {}

  async transform(file: Express.Multer.File | undefined) {
    // Domain services retain their existing FILE_REQUIRED response for a missing
    // multipart part. Any supplied file is fully validated before the service runs.
    if (!file) return file;
    await preflightUploadFile(file, this.profile);
    return file;
  }
}

@Injectable()
export class SecureCoupangBundlePipe implements PipeTransform<CoupangBundleFiles | undefined> {
  async transform(files: CoupangBundleFiles | undefined) {
    // Keep RBAC/route metadata probes able to reach their mocked service on a
    // non-multipart request. The real service repeats this preflight and rejects
    // an absent/empty bundle before starting any import mutation.
    if (!files) return files;
    await preflightCoupangBundle(files);
    return files;
  }
}
