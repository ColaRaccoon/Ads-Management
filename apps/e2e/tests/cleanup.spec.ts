import { expect, test } from "@playwright/test";
import { cleanupManifestDigest, createScenarioEvidence, loadCleanupManifest, verifyApprovedE2eReceipt } from "../src/evidence";
import { loadE2eTargetContract, readProtectedJson } from "../src/target-contract";

const target = loadE2eTargetContract();

test("verifies the separately approved exact cleanup receipt", () => {
  const manifest = loadCleanupManifest(required("E2E_CLEANUP_MANIFEST_FILE"));
  expect(manifest.environmentId).toBe(target.environmentId);
  expect(manifest.projectRef).toBe(target.projectRef);
  expect(manifest.releaseGitSha).toBe(target.releaseGitSha);
  const manifestDigest = cleanupManifestDigest(manifest);

  const receipt = verifyApprovedE2eReceipt<{
    cleanupManifestDigestSha256?: string;
    remainingByKind?: Record<string, number>;
    identitiesRevoked?: number;
    objectsRemaining?: number;
    rowsRemaining?: number;
  }>({
    value: readProtectedJson(required("E2E_CLEANUP_RECEIPT_FILE")), target, kind: "cleanup.exact",
    approvedReceiptSha256: required("E2E_CLEANUP_RECEIPT_SHA256"),
    publicKeyFile: required("E2E_RECEIPT_PUBLIC_KEY_FILE")
  }).payload;
  expect(Object.keys(receipt).sort()).toEqual([
    "cleanupManifestDigestSha256", "identitiesRevoked", "objectsRemaining", "remainingByKind", "rowsRemaining"
  ]);
  expect(receipt.cleanupManifestDigestSha256).toBe(manifestDigest);
  expect(Object.values(receipt.remainingByKind ?? {}).every((count) => count === 0)).toBe(true);
  expect(receipt.objectsRemaining).toBe(0);
  expect(receipt.rowsRemaining).toBe(0);
  const evidence = createScenarioEvidence({
    target, scenario: "cleanup.exact", result: "PASS", assertionCount: 8,
    counts: { entries: manifest.entries.length, identities_revoked: receipt.identitiesRevoked ?? 0 },
    digests: { cleanup_manifest: manifestDigest }, codes: ["ROWS_ZERO", "OBJECTS_ZERO"]
  });
  expect(evidence.result).toBe("PASS");
});

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
