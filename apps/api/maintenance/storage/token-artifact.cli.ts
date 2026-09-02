import { asRecord, assertExactKeys, asStrictString, canonicalJson, readProtectedJsonFile } from "../shared/strict-json";
import { assertNoSensitiveEvidence } from "../shared/redacted-evidence";
import { assertTargetConfirmation, parseCloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import { tokenArtifactPublicEvidence, verifyApprovedStorageTokenBundle } from "./token-artifact";

async function main() {
  const args = strictArgs(process.argv.slice(2));
  const [tokenValue, jwks, expectedValue] = await Promise.all([
    readProtectedJsonFile(args.tokenFile, 32 * 1024),
    readProtectedJsonFile(args.jwksFile, 1024 * 1024),
    readProtectedJsonFile(args.expectedFile, 64 * 1024)
  ]);
  const tokenInput = asRecord(tokenValue, "STORAGE_TOKEN_FILE_INVALID");
  assertExactKeys(tokenInput, ["token"], "STORAGE_TOKEN_FILE_KEYS_INVALID");
  const expectedInput = asRecord(expectedValue, "STORAGE_TOKEN_EXPECTED_INVALID");
  assertExactKeys(expectedInput, ["target", "confirmation", "bundle"], "STORAGE_TOKEN_EXPECTED_KEYS_INVALID");
  const target = parseCloudTargetBinding(expectedInput.target);
  assertTargetConfirmation(target, expectedInput.confirmation as never);
  const verified = await verifyApprovedStorageTokenBundle({
    token: asStrictString(tokenInput.token, "STORAGE_TOKEN_VALUE_INVALID", undefined, 16_384),
    jwks: jwks as never,
    target,
    bundle: expectedInput.bundle,
    confirmBundleSha256: args.confirmBundleSha256
  });
  const artifact = verified.artifact;
  const evidence = {
    ...tokenArtifactPublicEvidence(artifact),
    environmentId: target.environmentId,
    projectRef: target.projectRef,
    releaseGitSha: target.releaseGitSha,
    targetSha256: targetBindingSha256(target),
    approvalBundleSha256: verified.bundleSha256,
    officialJwksSha256: verified.bundle.officialJwksSha256
  };
  assertNoSensitiveEvidence(evidence);
  process.stdout.write(`${canonicalJson(evidence)}\n`);
}

function strictArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^(--token-file|--jwks-file|--expected-file|--confirm-bundle-sha256)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error("STORAGE_TOKEN_CLI_ARGUMENT_INVALID");
    values.set(match[1], match[2]);
  }
  const tokenFile = values.get("--token-file");
  const jwksFile = values.get("--jwks-file");
  const expectedFile = values.get("--expected-file");
  const confirmBundleSha256 = values.get("--confirm-bundle-sha256");
  if (!tokenFile || !jwksFile || !expectedFile || !confirmBundleSha256 || !/^[0-9a-f]{64}$/.test(confirmBundleSha256) || values.size !== 4) {
    throw new Error("STORAGE_TOKEN_CLI_INPUT_REQUIRED");
  }
  return { tokenFile, jwksFile, expectedFile, confirmBundleSha256 };
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "STORAGE_TOKEN_CLI_FAILED";
  process.stderr.write(`${JSON.stringify({ event: "storage-token-artifact", result: "FAIL", code })}\n`);
  process.exitCode = 1;
});
