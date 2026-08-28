import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { terminateWindowsProcessTree, windowsJobGuardInvocationForTesting, WindowsNtfsFileStorage } from "./windows-ntfs-file-storage";

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
    const closed = once(opened.stream, "close");
    opened.stream.destroy();
    await closed;
    await expect(waitUntilExited(readPid, 10_000)).resolves.toBeUndefined();
    await expect(rm(path.join(root, "early-close", "object"))).resolves.toBeUndefined();
  }, 90_000);

  it("kills and verifies a stubborn descendant process tree", async () => {
    const { parent, descendantPid, systemRoot } = await stubbornTree();
    await terminateWindowsProcessTree(parent, systemRoot, 10_000);
    expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
    await expect(waitUntilExited(descendantPid, 5_000)).resolves.toBeUndefined();
  }, 30_000);

  it("reaps descendants when the guarded root exits before cleanup runs", async () => {
    const { parent, descendantPid } = await stubbornTree(true);
    await expect(waitForChildExit(parent, 10_000)).resolves.not.toBeNull();
    await expect(waitUntilExited(descendantPid, 5_000)).resolves.toBeUndefined();
  }, 30_000);

  it("uses the retained child handle rather than a mutable or reused PID", async () => {
    const { executable, systemRoot } = windowsPowerShell();
    const root = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 300"], { windowsHide: true, stdio: "ignore" });
    const unrelated = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 300"], { windowsHide: true, stdio: "ignore" });
    expect(root.pid).toBeGreaterThan(0);
    expect(unrelated.pid).toBeGreaterThan(0);
    const originalPid = root.pid;
    Object.defineProperty(root, "pid", { configurable: true, value: unrelated.pid });
    try {
      await terminateWindowsProcessTree(root, systemRoot, 10_000);
      expect(root.exitCode !== null || root.signalCode !== null).toBe(true);
      expect(isRunning(unrelated.pid!)).toBe(true);
    } finally {
      Object.defineProperty(root, "pid", { configurable: true, value: originalPid });
      if (unrelated.exitCode === null) unrelated.kill("SIGKILL");
      await waitForChildExit(unrelated, 10_000).catch(() => null);
    }
  }, 30_000);

  it("fails closed when the retained process handle cannot be signaled", async () => {
    const { executable, systemRoot } = windowsPowerShell();
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 300"], { windowsHide: true, stdio: "ignore" });
    const originalKill = child.kill.bind(child);
    Object.defineProperty(child, "kill", { configurable: true, value: () => false });
    try {
      await expect(terminateWindowsProcessTree(child, systemRoot, 1_000)).rejects.toThrow();
    } finally {
      Object.defineProperty(child, "kill", { configurable: true, value: originalKill });
      if (child.exitCode === null) originalKill("SIGKILL");
      await waitForChildExit(child, 10_000).catch(() => null);
    }
  }, 30_000);

  it("contains no PID-snapshot or taskkill cleanup path", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "storage", "windows-ntfs-file-storage.ts"), "utf8");
    expect(source).not.toContain("META_NTFS_ROOT_PID");
    expect(source).not.toContain("taskkill");
    expect(source).not.toContain("CreateToolhelp32Snapshot");
  }, 30_000);
});

async function stubbornTree(exitAfterChild = false) {
  const root = await temporaryRoot();
  const childPidPath = path.join(root, "child.pid");
  const { executable, systemRoot } = windowsPowerShell();
  const guard = windowsJobGuardInvocationForTesting();
  const tail = exitAfterChild ? "exit 0" : "Start-Sleep -Seconds 300";
  const command = `${guard.command};$child=Start-Process -FilePath $env:STUBBORN_PS -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 300') -PassThru;[IO.File]::WriteAllText($env:STUBBORN_PID,[string]$child.Id);${tail}`;
  const parent = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    stdio: "ignore",
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, STUBBORN_PS: executable, STUBBORN_PID: childPidPath, ...guard.environment }
  });
  const descendantPid = Number(await waitForFile(childPidPath, 10_000));
  expect(descendantPid).toBeGreaterThan(0);
  return { parent, descendantPid, systemRoot };
}

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  return { systemRoot, executable: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") };
}

function isRunning(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("CHILD_EXIT_TIMEOUT")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); child.off("exit", exit); child.off("error", error); };
    const exit = (code: number | null) => { cleanup(); resolve(code); };
    const error = (reason: Error) => { cleanup(); reject(reason); };
    child.once("exit", exit);
    child.once("error", error);
  });
}

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
