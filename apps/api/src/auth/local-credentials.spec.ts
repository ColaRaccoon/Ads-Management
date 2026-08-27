import { describe, expect, it } from "vitest";
import {
  createCredential,
  normalizeUsername,
  ScryptWorkLimiter,
  validateNewPassword,
  verifyCredential
} from "./local-credentials";

describe("local native credential boundary", () => {
  it("normalizes only the documented username alphabet", () => {
    expect(normalizeUsername("Local.Admin")).toBe("local.admin");
    for (const invalid of ["ab", "1admin", "admin user", "관리자", "admin/"]) {
      expect(() => normalizeUsername(invalid)).toThrow("USERNAME_INVALID");
    }
  });

  it("counts Unicode code points and rejects malformed or non-normalized passwords", () => {
    expect(() => validateNewPassword("😀".repeat(6))).toThrow("password policy");
    expect(() => validateNewPassword("valid-password-12")).not.toThrow();
    expect(() => validateNewPassword(`valid-password-${String.fromCharCode(0xd800)}`))
      .toThrow("password policy");
  });

  it("creates and verifies the exact bounded asynchronous scrypt format", async () => {
    const limiter = new ScryptWorkLimiter(2, 2);
    const credential = await createCredential("valid-password-12", limiter);
    expect(credential).toMatchObject({ algorithm: "scrypt", version: 1, costN: 65536, blockSizeR: 8, parallelizationP: 1, keyLength: 32 });
    await expect(verifyCredential("valid-password-12", credential, limiter)).resolves.toBe(true);
    await expect(verifyCredential("different-password-12", credential, limiter)).resolves.toBe(false);
    await expect(verifyCredential("valid-password-12", { ...credential, costN: 32768 }, limiter))
      .rejects.toThrow("LOCAL_CREDENTIAL_PARAMETERS_INVALID");
  });

  it("caps active KDF work and rejects queue overflow without blocking the event loop", async () => {
    const limiter = new ScryptWorkLimiter(2, 2);
    let active = 0;
    let maximum = 0;
    const work = () => limiter.run(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      active -= 1;
    });
    const jobs = [work(), work(), work(), work()];
    await expect(work()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(maximum).toBe(2);
    await Promise.all(jobs);
  });

  it("hands a released slot directly to the queued waiter", async () => {
    const limiter = new ScryptWorkLimiter(1, 2);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let concurrent = 0;
    let maximum = 0;
    const first = limiter.run(async () => { concurrent += 1; maximum=Math.max(maximum,concurrent); await firstGate; concurrent -= 1; });
    const second = limiter.run(async () => { concurrent += 1; maximum=Math.max(maximum,concurrent); await secondGate; concurrent -= 1; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();
    const opportunistic = limiter.run(async () => { concurrent += 1; maximum=Math.max(maximum,concurrent); concurrent -= 1; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(limiter.activeCount).toBe(1);
    expect(maximum).toBe(1);
    releaseSecond();
    await Promise.all([first,second,opportunistic]);
    expect(limiter.activeCount).toBe(0);
  });
});
