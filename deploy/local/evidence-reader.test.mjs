import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonEvidence } from "./evidence-reader.mjs";

test("optional reboot evidence permits only a missing final file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "metaads-evidence-reader-"));
  try {
    const parent = path.join(root, "evidence");
    await mkdir(parent);
    const future = path.join(parent, "reboot.json");
    assert.equal(readJsonEvidence(future, { label: "REBOOT_EVIDENCE", allowMissingLeaf: true }), null);
    assert.throws(() => readJsonEvidence(path.join(root, "missing", "reboot.json"), { label: "REBOOT_EVIDENCE", allowMissingLeaf: true }), /ENOENT/);
    await writeFile(future, "{}", "utf8");
    assert.deepEqual(readJsonEvidence(future, { label: "REBOOT_EVIDENCE", allowMissingLeaf: true }), {});
    await writeFile(future, "", "utf8");
    assert.throws(() => readJsonEvidence(future, { label: "REBOOT_EVIDENCE", allowMissingLeaf: true }), /REBOOT_EVIDENCE_FILE_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
