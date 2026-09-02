import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { APIRequestContext } from "@playwright/test";

export const E2E_TARGET_CONTRACT_VERSION = 1;
export const IDENTITY_ALIASES = ["INACTIVE", "SETUP_PENDING", "GUEST", "USER", "ADMIN", "SUPER_ADMIN"] as const;
export type IdentityAlias = typeof IDENTITY_ALIASES[number];

export type E2eTargetContract = {
  version: "e2e-target/v1";
  environmentClass: "staging" | "production";
  environmentId: string;
  baseUrl: string;
  backendPrefix: "/backend-api";
  supabaseOrigin: string;
  projectRef: string;
  databaseSchema: string;
  storageBucket: string;
  readinessKey: string;
  releaseGitSha: string;
  imageDigest: string;
  auth: {
    publicSignupEnabled: false;
    siteUrl: string;
    redirectUrls: string[];
  };
  expected: {
    routeMatrixDigestSha256: string;
    businessDigestSha256: string;
    reportDigestSha256: string;
  };
  receiptTrust: {
    publicKeySha256: string;
    producerArtifactDigestSha256: string;
  };
};

export function loadE2eTargetContract(env: NodeJS.ProcessEnv = process.env): E2eTargetContract {
  if (env.E2E_DISCOVERY_ONLY === "1") return discoveryTargetContract();
  if (env.E2E_DISCOVERY_ONLY !== undefined) throw new Error("E2E_DISCOVERY_MODE_INVALID");
  const file = env.E2E_TARGET_CONTRACT_FILE?.trim();
  if (!file) throw new Error("E2E_TARGET_CONTRACT_FILE_REQUIRED");
  return parseE2eTargetContract(readProtectedJson(file));
}

function discoveryTargetContract(): E2eTargetContract {
  const digest = "0".repeat(64);
  return parseE2eTargetContract({
    version: "e2e-target/v1",
    environmentClass: "staging",
    environmentId: "discovery-only",
    baseUrl: "https://e2e-discovery.invalid",
    backendPrefix: "/backend-api",
    supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co",
    projectRef: "abcdefghijklmnopqrst",
    databaseSchema: "discovery_only",
    storageBucket: "discovery-only",
    readinessKey: "readiness/discovery-only",
    releaseGitSha: "0".repeat(40),
    imageDigest: `sha256:${digest}`,
    auth: {
      publicSignupEnabled: false,
      siteUrl: "https://e2e-discovery.invalid",
      redirectUrls: ["https://e2e-discovery.invalid/invite/accept"]
    },
    expected: {
      routeMatrixDigestSha256: digest,
      businessDigestSha256: digest,
      reportDigestSha256: digest
    },
    receiptTrust: {
      publicKeySha256: digest,
      producerArtifactDigestSha256: digest
    }
  });
}

export function parseE2eTargetContract(value: unknown): E2eTargetContract {
  const input = record(value, "E2E_TARGET_OBJECT_REQUIRED");
  exactKeys(input, [
    "version", "environmentClass", "environmentId", "baseUrl", "backendPrefix", "supabaseOrigin",
    "projectRef", "databaseSchema", "storageBucket", "readinessKey", "releaseGitSha", "imageDigest", "auth", "expected", "receiptTrust"
  ], "E2E_TARGET_KEYS_INVALID");
  if (input.version !== "e2e-target/v1") throw new Error("E2E_TARGET_VERSION_INVALID");
  if (input.environmentClass !== "staging" && input.environmentClass !== "production") throw new Error("E2E_TARGET_CLASS_INVALID");
  const projectRef = strictString(input.projectRef, /^[a-z]{20}$/, "E2E_PROJECT_REF_INVALID");
  const baseUrl = normalizedHttpsOrigin(input.baseUrl, "E2E_BASE_URL_INVALID");
  const supabaseOrigin = normalizedHttpsOrigin(input.supabaseOrigin, "E2E_SUPABASE_ORIGIN_INVALID");
  if (supabaseOrigin !== `https://${projectRef}.supabase.co`) throw new Error("E2E_SUPABASE_PROJECT_MISMATCH");
  if (input.backendPrefix !== "/backend-api") throw new Error("E2E_BACKEND_PREFIX_INVALID");
  const auth = record(input.auth, "E2E_AUTH_CONFIG_INVALID");
  exactKeys(auth, ["publicSignupEnabled", "siteUrl", "redirectUrls"], "E2E_AUTH_CONFIG_KEYS_INVALID");
  if (auth.publicSignupEnabled !== false) throw new Error("E2E_PUBLIC_SIGNUP_MUST_BE_DISABLED");
  if (normalizedHttpsOrigin(auth.siteUrl, "E2E_AUTH_SITE_URL_INVALID") !== baseUrl) throw new Error("E2E_AUTH_SITE_URL_MISMATCH");
  if (!Array.isArray(auth.redirectUrls) || auth.redirectUrls.length < 1 || auth.redirectUrls.length > 20 ||
      auth.redirectUrls.some((redirect) => typeof redirect !== "string" || !redirect.startsWith(`${baseUrl}/`))) {
    throw new Error("E2E_AUTH_REDIRECTS_INVALID");
  }
  const expected = record(input.expected, "E2E_EXPECTED_INVALID");
  exactKeys(expected, ["routeMatrixDigestSha256", "businessDigestSha256", "reportDigestSha256"], "E2E_EXPECTED_KEYS_INVALID");
  const digest = (name: string) => strictString(expected[name], /^[0-9a-f]{64}$/, "E2E_EXPECTED_DIGEST_INVALID");
  const receiptTrust = record(input.receiptTrust, "E2E_RECEIPT_TRUST_INVALID");
  exactKeys(receiptTrust, ["publicKeySha256", "producerArtifactDigestSha256"], "E2E_RECEIPT_TRUST_KEYS_INVALID");
  return {
    version: "e2e-target/v1",
    environmentClass: input.environmentClass,
    environmentId: strictString(input.environmentId, /^[a-z][a-z0-9-]{2,62}$/, "E2E_ENVIRONMENT_ID_INVALID"),
    baseUrl,
    backendPrefix: "/backend-api",
    supabaseOrigin,
    projectRef,
    databaseSchema: strictString(input.databaseSchema, /^[a-z_][a-z0-9_]{0,62}$/, "E2E_SCHEMA_INVALID"),
    storageBucket: strictString(input.storageBucket, /^[a-z0-9][a-z0-9._-]{0,62}$/, "E2E_BUCKET_INVALID"),
    readinessKey: safeStorageKey(input.readinessKey),
    releaseGitSha: strictString(input.releaseGitSha, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "E2E_RELEASE_INVALID"),
    imageDigest: strictString(input.imageDigest, /^sha256:[0-9a-f]{64}$/, "E2E_IMAGE_DIGEST_INVALID"),
    auth: { publicSignupEnabled: false, siteUrl: baseUrl, redirectUrls: [...auth.redirectUrls] as string[] },
    expected: {
      routeMatrixDigestSha256: digest("routeMatrixDigestSha256"),
      businessDigestSha256: digest("businessDigestSha256"),
      reportDigestSha256: digest("reportDigestSha256")
    },
    receiptTrust: {
      publicKeySha256: strictString(receiptTrust.publicKeySha256, /^[0-9a-f]{64}$/, "E2E_RECEIPT_KEY_DIGEST_INVALID"),
      producerArtifactDigestSha256: strictString(receiptTrust.producerArtifactDigestSha256, /^[0-9a-f]{64}$/, "E2E_RECEIPT_PRODUCER_DIGEST_INVALID")
    }
  };
}

export type IdentityStorageState = {
  cookies: Array<{
    name: string; value: string; domain: string; path: string; expires: number;
    httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

export type ApiRequestContextFactory = {
  request: {
    newContext(options: {
      baseURL: string;
      storageState?: IdentityStorageState;
      extraHTTPHeaders: Record<string, string>;
    }): Promise<APIRequestContext>;
  };
};

export function identityStorageState(alias: IdentityAlias, env: NodeJS.ProcessEnv = process.env): IdentityStorageState {
  const name = `E2E_${alias}_STORAGE_STATE_FILE`;
  const file = env[name]?.trim();
  if (!file) throw new Error(`E2E_IDENTITY_STATE_REQUIRED_${alias}`);
  const state = record(readProtectedJson(file, 1024 * 1024), "E2E_STORAGE_STATE_INVALID");
  exactKeys(state, ["cookies", "origins"], "E2E_STORAGE_STATE_KEYS_INVALID");
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error("E2E_STORAGE_STATE_COLLECTIONS_INVALID");
  return {
    cookies: state.cookies.map((item) => {
      const cookie = record(item, "E2E_STORAGE_STATE_COOKIE_INVALID");
      exactKeys(cookie, ["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite"], "E2E_STORAGE_STATE_COOKIE_KEYS_INVALID");
      if (![cookie.name, cookie.value, cookie.domain, cookie.path].every((value) => typeof value === "string") ||
          typeof cookie.expires !== "number" || typeof cookie.httpOnly !== "boolean" || typeof cookie.secure !== "boolean" ||
          !["Strict", "Lax", "None"].includes(cookie.sameSite as string)) throw new Error("E2E_STORAGE_STATE_COOKIE_INVALID");
      return cookie as IdentityStorageState["cookies"][number];
    }),
    origins: state.origins.map((item) => {
      const origin = record(item, "E2E_STORAGE_STATE_ORIGIN_INVALID");
      exactKeys(origin, ["origin", "localStorage"], "E2E_STORAGE_STATE_ORIGIN_KEYS_INVALID");
      if (typeof origin.origin !== "string" || !Array.isArray(origin.localStorage)) throw new Error("E2E_STORAGE_STATE_ORIGIN_INVALID");
      return {
        origin: origin.origin,
        localStorage: origin.localStorage.map((entry) => {
          const pair = record(entry, "E2E_STORAGE_STATE_LOCAL_VALUE_INVALID");
          exactKeys(pair, ["name", "value"], "E2E_STORAGE_STATE_LOCAL_VALUE_KEYS_INVALID");
          if (typeof pair.name !== "string" || typeof pair.value !== "string") throw new Error("E2E_STORAGE_STATE_LOCAL_VALUE_INVALID");
          return { name: pair.name, value: pair.value };
        })
      };
    })
  };
}

export function csrfTokenFromStorageState(state: IdentityStorageState) {
  const csrf = state.cookies.find((cookie) => {
    const item = record(cookie, "E2E_STORAGE_STATE_COOKIE_INVALID");
    return typeof item.name === "string" && item.name.endsWith("meta_csrf");
  }) as Record<string, unknown> | undefined;
  if (!csrf || typeof csrf.value !== "string" || csrf.value.length < 32 || csrf.value.length > 2_048) {
    throw new Error("E2E_CSRF_COOKIE_MISSING");
  }
  return csrf.value;
}

export function apiPath(target: E2eTargetContract, relative: string) {
  if (!relative.startsWith("/api/") || relative.includes("..") || relative.includes("\\")) throw new Error("E2E_API_PATH_INVALID");
  return `${target.backendPrefix}${relative}`;
}

export async function newApiContext(
  playwright: ApiRequestContextFactory,
  target: E2eTargetContract,
  alias?: IdentityAlias,
  options: { csrf?: boolean; origin?: string } = {}
): Promise<APIRequestContext> {
  const storageState = alias ? identityStorageState(alias) : undefined;
  const headers: Record<string, string> = { origin: options.origin ?? target.baseUrl };
  if (alias && options.csrf !== false) headers["x-csrf-token"] = csrfTokenFromStorageState(storageState!);
  return playwright.request.newContext({
    baseURL: target.baseUrl,
    storageState,
    extraHTTPHeaders: headers
  });
}

export type ProtectedReadHooks = { afterOpen?: () => void; afterRead?: () => void };

export function readProtectedBytes(file: string, maximum = 8 * 1024 * 1024, hooks: ProtectedReadHooks = {}): Buffer {
  const pathBefore = lstatSync(file, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1n || pathBefore.size > BigInt(maximum)) {
    throw new Error("E2E_PROTECTED_FILE_INVALID");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const descriptorBefore = fstatSync(descriptor, { bigint: true });
    assertSameFile(pathBefore, descriptorBefore);
    hooks.afterOpen?.();
    const bytes = readFileSync(descriptor);
    hooks.afterRead?.();
    const descriptorAfter = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(file, { bigint: true });
    assertSameFile(descriptorBefore, descriptorAfter, true);
    assertSameFile(descriptorAfter, pathAfter);
    if (BigInt(bytes.length) !== descriptorAfter.size) throw new Error("E2E_PROTECTED_FILE_CHANGED");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("E2E_")) throw error;
    throw new Error("E2E_PROTECTED_FILE_CHANGED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readProtectedText(file: string, maximum = 8 * 1024 * 1024): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(readProtectedBytes(file, maximum)); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("E2E_")) throw error;
    throw new Error("E2E_PROTECTED_TEXT_INVALID");
  }
  if (!text || text.includes("\0")) throw new Error("E2E_PROTECTED_TEXT_INVALID");
  return text;
}

export function readProtectedJson(file: string, maximum = 8 * 1024 * 1024): unknown {
  const bytes = readProtectedBytes(file, maximum);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("E2E_PROTECTED_JSON_INVALID"); }
}

function assertSameFile(
  left: BigIntStats,
  right: BigIntStats,
  includeTimes = false
) {
  if (left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size ||
      (includeTimes && (left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs))) {
    throw new Error("E2E_PROTECTED_FILE_CHANGED");
  }
}

function normalizedHttpsOrigin(value: unknown, code: string) {
  const raw = strictString(value, undefined, code, 256);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(code); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      isLocalHost(url.hostname)) throw new Error(code);
  return url.origin;
}

function isLocalHost(host: string) {
  return host === "localhost" || host === "::1" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
}

function safeStorageKey(value: unknown) {
  const key = strictString(value, /^[a-z0-9][a-z0-9._/-]{0,1023}$/, "E2E_READINESS_KEY_INVALID", 1_024);
  if (key.includes("..") || key.includes("//") || ["uploads/", "reports/", "trash/uploads/", "trash/reports/"].some((prefix) => key.startsWith(prefix))) {
    throw new Error("E2E_READINESS_KEY_INVALID");
  }
  return key;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], code: string) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) throw new Error(code);
}

function strictString(value: unknown, pattern: RegExp | undefined, code: string, max = 512) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max || (pattern && !pattern.test(value))) {
    throw new Error(code);
  }
  return value;
}
