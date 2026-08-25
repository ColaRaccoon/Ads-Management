import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { configuredFileStorage } from "../storage/configured-file-storage";
import { FileStorage } from "../storage/file-storage";
import {
  legacyLocalPathToKey,
  parseStorageReference,
  storageReference
} from "../storage/storage-reference";

@Injectable()
export class UploadStorageService {
  private fileStorage?: FileStorage;

  constructor(private readonly config: ConfigService) {}

  prepareOriginalFileReference(fileHash: string, now = new Date(), objectId = randomUUID()) {
    if (!/^[a-f0-9]{64}$/i.test(fileHash)) {
      throw new Error("A SHA-256 hash is required for an upload storage key.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)) {
      throw new Error("A server-generated UUID is required for an upload storage key.");
    }
    const key = [
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      objectId.toLowerCase(),
      fileHash.toLowerCase()
    ].join("/");
    return storageReference(this.storage.provider, key);
  }

  async putOriginalFile(file: Express.Multer.File, reference: string) {
    const parsed = this.localReference(reference);
    const expectedHashSha256 = createHash("sha256").update(file.buffer).digest("hex");
    return this.storage.put({
      key: parsed.key,
      body: file.buffer,
      expectedHashSha256,
      maxBytes: file.buffer.length
    });
  }

  /** Compatibility helper for callers that have not yet split DB reservation from storage put. */
  async storeOriginalFile(file: Express.Multer.File, fileHash: string, _originalFilename: string) {
    const reference = this.prepareOriginalFileReference(fileHash);
    await this.putOriginalFile(file, reference);
    return reference;
  }

  async deleteStoredUploadFile(storedFilePath: string | null) {
    if (!storedFilePath) return false;
    const parsed = parseStorageReference(storedFilePath);
    if (parsed) {
      if (parsed.provider !== this.storage.provider) {
        throw new Error("The stored upload provider is not configured.");
      }
      return this.storage.delete(parsed.key);
    }
    const key = legacyLocalPathToKey(storedFilePath, this.localRootPath());
    return this.storage.delete(key);
  }

  private localReference(reference: string) {
    const parsed = parseStorageReference(reference);
    if (!parsed || parsed.provider !== this.storage.provider) {
      throw new Error("The upload storage reference is invalid for the configured provider.");
    }
    return parsed;
  }

  private get storage() {
    return (this.fileStorage ??= configuredFileStorage(this.config, "uploads"));
  }

  private localRootPath() {
    const storage = this.storage;
    if (!("rootPath" in storage) || typeof storage.rootPath !== "string") {
      throw new Error("Legacy local paths require the local storage adapter.");
    }
    return storage.rootPath;
  }
}
