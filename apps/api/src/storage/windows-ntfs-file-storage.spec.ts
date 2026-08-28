import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { terminateWindowsProcessTree, WindowsNtfsFileStorage } from "./windows-ntfs-file-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("WindowsNtfsFileStorage helper lifecycle", () => {
  it("terminates a streaming helper when its consumer closes early", async () => {
    const root = await temporaryRoot();
    let readPid = 0;
    const storage = new WindowsNtfsFileStorage(root, {
      operationTimeoutMs: 30_000,
      onChildStart(pid, operation) { if (operation === "get") readPid = pid; }
    });
    await storage.put({ key: "early-close/object", body: Readable.from(Buffer.alloc(16 * 1024 * 1024, 0x41)), maxBytes: 16 * 1024 * 1024 });
    const opened = await storage.getStream("early-close/object");
    expect(readPid).toBeGreaterThan(0);
    opened.stream.pause();
    opened.stream.destroy();
    await expect(waitUntilExited(readPid, 10_000)).resolves.toBeUndefined();
  }, 90_000);

  it("kills and verifies a stubborn descendant process tree", async () => {
    const root = await temporaryRoot();
    const childPidPath = path.join(root, "child.pid");
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
    const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = "$child=Start-Process -FilePath $env:STUBBORN_PS -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -PassThru;[IO.File]::WriteAllText($env:STUBBORN_PID,[string]$child.Id);Start-Sleep -Seconds 300";
    const parent = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      stdio: "ignore",
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, STUBBORN_PS: executable, STUBBORN_PID: childPidPath }
    });
    const descendantPid = Number(await waitForFile(childPidPath, 10_000));
    expect(descendantPid).toBeGreaterThan(0);
    await terminateWindowsProcessTree(parent, systemRoot, 10_000);
    expect(parent.exitCode).not.toBeNull();
    await expect(waitUntilExited(descendantPid, 5_000)).resolves.toBeUndefined();
  }, 30_000);
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "ntfs-helper-lifecycle-"));
  roots.push(root);
  return root;
}

async function waitForFile(file: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error("PID_FILE_TIMEOUT");
}

async function waitUntilExited(pid: number, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("PROCESS_EXIT_TIMEOUT");
}
