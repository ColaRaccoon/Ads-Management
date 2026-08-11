import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

@Injectable()
export class UploadStorageService {
  constructor(private readonly config: ConfigService) {}

  async storeOriginalFile(file: Express.Multer.File, fileHash: string, originalFilename: string) {
    const now = new Date();
    const storageDir = this.config.get<string>("UPLOAD_STORAGE_DIR") ?? "./storage/uploads";
    const targetDir = path.resolve(
      process.cwd(),
      storageDir,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0")
    );
    await mkdir(targetDir, { recursive: true });
    const safeName = originalFilename.replace(/[^\w.\-가-힣]/g, "_");
    const targetPath = path.join(targetDir, `${fileHash.slice(0, 12)}-${safeName}`);
    await writeFile(targetPath, file.buffer);
    return path.relative(process.cwd(), targetPath).replace(/\\/g, "/");
  }

  async deleteStoredUploadFile(storedFilePath: string | null) {
    if (!storedFilePath) {
      return false;
    }
    const storageDir = this.config.get<string>("UPLOAD_STORAGE_DIR") ?? "./storage/uploads";
    const storageRoot = path.resolve(process.cwd(), storageDir);
    const absolutePath = path.resolve(process.cwd(), storedFilePath);
    const relativeToStorage = path.relative(storageRoot, absolutePath);
    if (relativeToStorage.startsWith("..") || path.isAbsolute(relativeToStorage)) {
      return false;
    }
    try {
      await rm(absolutePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
