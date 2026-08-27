import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { rateLimitError } from "./auth.errors";
import { invitationError } from "./invitation.errors";

export const LOCAL_SCRYPT = Object.freeze({
  algorithm: "scrypt",
  version: 1,
  // ~64 MiB per active derivation. The separate work limiter keeps total
  // memory bounded while preserving useful offline-attack resistance.
  costN: 65536,
  blockSizeR: 8,
  parallelizationP: 1,
  keyLength: 32
});

export type StoredLocalCredential = {
  algorithm: string;
  version: number;
  costN: number;
  blockSizeR: number;
  parallelizationP: number;
  keyLength: number;
  salt: string;
  passwordHash: string;
};

export function normalizeUsername(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(normalized)) {
    throw new Error("USERNAME_INVALID");
  }
  return normalized;
}

export function validateNewPassword(password: string) {
  const bytes = Buffer.byteLength(password, "utf8");
  const codePoints = Array.from(password).length;
  if (
    /[\uD800-\uDFFF]/u.test(password.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, "")) ||
    password !== password.normalize("NFKC") ||
    password !== password.trim() ||
    codePoints < 12 ||
    codePoints > 128 ||
    bytes > 256
  ) {
    throw invitationError("PASSWORD_POLICY_INVALID");
  }
}

export class ScryptWorkLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number
  ) {}

  get activeCount() { return this.active; }
  get queuedCount() { return this.waiters.length; }

  async run<T>(work: () => Promise<T>) {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= this.queueLimit) throw rateLimitError(1);
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      // The active slot is handed directly to the oldest waiter. Decrementing
      // first would let a new caller steal it before the waiter resumes.
      next();
      return;
    }
    this.active -= 1;
  }
}

export async function createCredential(password: string, limiter: ScryptWorkLimiter) {
  validateNewPassword(password);
  const salt = randomBytes(32).toString("base64url");
  const passwordHash = await limiter.run(() => derive(password, salt, LOCAL_SCRYPT));
  return { ...LOCAL_SCRYPT, salt, passwordHash: passwordHash.toString("base64url") };
}

export async function verifyCredential(
  password: string,
  credential: StoredLocalCredential,
  limiter: ScryptWorkLimiter
) {
  const policy = boundedPolicy(credential);
  const expected = decodeBase64Url(credential.passwordHash, policy.keyLength);
  const actual = await limiter.run(() => derive(password, credential.salt, policy));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function dummyCredential(): StoredLocalCredential {
  return {
    ...LOCAL_SCRYPT,
    salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    passwordHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  };
}

function boundedPolicy(value: StoredLocalCredential) {
  if (
    value.algorithm !== LOCAL_SCRYPT.algorithm || value.version !== LOCAL_SCRYPT.version ||
    value.costN !== LOCAL_SCRYPT.costN ||
    value.blockSizeR !== LOCAL_SCRYPT.blockSizeR ||
    value.parallelizationP !== LOCAL_SCRYPT.parallelizationP ||
    value.keyLength !== 32 ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.salt) ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.passwordHash)
  ) throw new Error("LOCAL_CREDENTIAL_PARAMETERS_INVALID");
  return value;
}

function decodeBase64Url(value: string, length: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return Buffer.alloc(0);
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === length ? decoded : Buffer.alloc(0);
}

function derive(
  password: string,
  salt: string,
  policy: Pick<StoredLocalCredential, "costN" | "blockSizeR" | "parallelizationP" | "keyLength">
) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, policy.keyLength, {
      N: policy.costN,
      r: policy.blockSizeR,
      p: policy.parallelizationP,
      maxmem: 128 * 1024 * 1024
    }, (error, derived) => error ? reject(error) : resolve(derived as Buffer));
  });
}
