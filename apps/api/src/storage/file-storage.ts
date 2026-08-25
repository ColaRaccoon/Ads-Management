import { Readable } from "node:stream";

export type FileStoragePutInput = {
  key: string;
  body: Buffer | Readable;
  expectedHashSha256?: string;
  maxBytes?: number;
};

export type StoredFile = {
  key: string;
  hash: string;
  size: number;
};

export type StoredFileStream = {
  stream: Readable;
  size: number;
};

/** Provider-neutral contract. Production implementations must stream reads. */
export interface FileStorage {
  readonly provider: string;
  put(input: FileStoragePutInput): Promise<StoredFile>;
  getStream(key: string): Promise<StoredFileStream>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

export class InvalidStorageKeyError extends Error {
  constructor() {
    super("The storage key is invalid.");
    this.name = "InvalidStorageKeyError";
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor() {
    super("The storage object does not exist.");
    this.name = "StorageObjectNotFoundError";
  }
}

export class StorageIntegrityError extends Error {
  constructor() {
    super("The storage object failed an integrity check.");
    this.name = "StorageIntegrityError";
  }
}

export class StorageObjectTooLargeError extends Error {
  constructor() {
    super("The storage object exceeds the configured limit.");
    this.name = "StorageObjectTooLargeError";
  }
}

export class StorageAccessDeniedError extends Error {
  constructor() {
    super("The storage provider denied the request.");
    this.name = "StorageAccessDeniedError";
  }
}

export class StorageProviderUnavailableError extends Error {
  constructor() {
    super("The storage provider is temporarily unavailable.");
    this.name = "StorageProviderUnavailableError";
  }
}

export class StorageProviderRequestError extends Error {
  constructor() {
    super("The storage provider rejected the request.");
    this.name = "StorageProviderRequestError";
  }
}
