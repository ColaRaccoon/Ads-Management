import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { generateDailyProductsWorkbook } from "./daily-products-export";
import type { DailyProductsReport } from "./daily-products-model";

// The controller only transports this immutable report; metric calculation and
// the actual workbook bytes have separate model / independent XLSX reader tests.
const report = { date: "2026-11-02", previousDate: "2026-11-01", snapshotHash: "snapshot", rows: [] } as unknown as DailyProductsReport;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static constructError: Error | null = null;
  static postError: Error | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  posts: unknown[] = [];
  terminated = 0;
  constructor(readonly url: URL, readonly options: WorkerOptions) {
    if (FakeWorker.constructError) throw FakeWorker.constructError;
    FakeWorker.instances.push(this);
  }
  postMessage(data: unknown) {
    this.posts.push(data);
    if (FakeWorker.postError) throw FakeWorker.postError;
  }
  terminate() { this.terminated++; }
  message(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
}

function installWorker(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  FakeWorker.instances = []; FakeWorker.constructError = null; FakeWorker.postError = null;
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "Worker", previous);
    else Reflect.deleteProperty(globalThis, "Worker");
  });
}

function clean(worker: FakeWorker, signal: AbortSignal) {
  assert.equal(worker.terminated, 1, "worker is always terminated once");
  assert.equal(getEventListeners(signal, "abort").length, 0, "abort listener is removed");
  assert.equal(worker.onmessage, null, "message handler is released");
  assert.equal(worker.onerror, null, "error handler is released");
  assert.equal(worker.onmessageerror, null, "deserialization handler is released");
}

test("export posts the report to a module worker and accepts a transferred Uint8Array without rebuilding it", async t => {
  installWorker(t);
  const controller = new AbortController();
  const result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  assert.match(worker.url.pathname, /daily-products-xlsx\.worker\.ts$/);
  assert.deepEqual(worker.options, { type: "module" });
  assert.equal(worker.posts.length, 1);
  assert.equal(worker.posts[0], report);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const original = new Uint8Array([80, 75, 3, 4, 1, 2]);
  const transported = structuredClone({ workbook: original }, { transfer: [original.buffer] });
  assert.equal(original.byteLength, 0, "worker-side buffer was transferred, not copied");
  worker.message(transported);
  const workbook = await result;
  assert.equal(workbook, transported.workbook);
  assert.deepEqual([...workbook], [80, 75, 3, 4, 1, 2]);
  clean(worker, controller.signal);
  controller.abort();
  assert.equal(worker.terminated, 1, "settled work is detached from future aborts");
});

test("worker-reported construction errors reject the export and release the worker and abort listener", async t => {
  installWorker(t);
  const controller = new AbortController(), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  worker.message({ error: "원본 금액을 확인해 주세요." });
  await assert.rejects(result, /원본 금액을 확인해 주세요/);
  clean(worker, controller.signal);
});

test("runtime worker errors reject with a readable error and clean up", async t => {
  installWorker(t);
  const controller = new AbortController(), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  worker.onerror?.(new Event("error"));
  await assert.rejects(result, /엑셀 생성 작업을 시작하지 못했습니다/);
  clean(worker, controller.signal);
});

test("worker deserialization errors reject rather than leaving export pending", async t => {
  installWorker(t);
  const controller = new AbortController(), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  worker.onmessageerror?.(new Event("messageerror"));
  await assert.rejects(result, /엑셀 생성 자료를 전달하지 못했습니다/);
  clean(worker, controller.signal);
});

test("an unexpected workbook type is rejected and cleaned up", async t => {
  installWorker(t);
  const controller = new AbortController(), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  worker.message({ workbook: [80, 75] });
  await assert.rejects(result, /엑셀 생성 결과를 확인하지 못했습니다/);
  clean(worker, controller.signal);
});

for (const payload of [null, undefined]) test(`a ${String(payload)} worker payload rejects without leaving the promise pending`, async t => {
  installWorker(t);
  const controller = new AbortController(), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  worker.onmessage?.({ data: payload } as MessageEvent);
  await assert.rejects(result, /엑셀 생성 결과를 확인하지 못했습니다/);
  clean(worker, controller.signal);
});

test("an already aborted request never starts a worker", async t => {
  installWorker(t);
  const controller = new AbortController(), reason = new Error("조회 범위 변경");
  controller.abort(reason);
  await assert.rejects(generateDailyProductsWorkbook(report, controller.signal), error => error === reason);
  assert.equal(FakeWorker.instances.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborting an active export rejects with its original reason and terminates immediately", async t => {
  installWorker(t);
  const controller = new AbortController(), reason = new Error("보고일 변경");
  const result = generateDailyProductsWorkbook(report, controller.signal), worker = FakeWorker.instances[0];
  controller.abort(reason);
  await assert.rejects(result, error => error === reason);
  clean(worker, controller.signal);
});

test("postMessage failure releases an already created worker", async t => {
  installWorker(t);
  const controller = new AbortController(), reason = new Error("DataCloneError");
  FakeWorker.postError = reason;
  await assert.rejects(generateDailyProductsWorkbook(report, controller.signal), error => error === reason);
  clean(FakeWorker.instances[0], controller.signal);
});

test("worker construction failure rejects without installing an abort listener", async t => {
  installWorker(t);
  const controller = new AbortController(), reason = new Error("worker blocked");
  FakeWorker.constructError = reason;
  await assert.rejects(generateDailyProductsWorkbook(report, controller.signal), error => error === reason);
  assert.equal(FakeWorker.instances.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("queued callbacks after successful completion cannot settle or terminate the worker again", async t => {
  installWorker(t);
  const controller = new AbortController(), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0];
  const message = worker.onmessage!, error = worker.onerror!, messageerror = worker.onmessageerror!;
  const bytes = new Uint8Array([80, 75]);
  message(new MessageEvent("message", { data: { workbook: bytes } }));
  message(new MessageEvent("message", { data: { error: "late failure" } }));
  error(new Event("error"));
  messageerror(new Event("messageerror"));
  controller.abort();
  assert.equal(await result, bytes);
  clean(worker, controller.signal);
});

test("a late successful callback after abort cannot revive a cancelled export", async t => {
  installWorker(t);
  const controller = new AbortController(), reason = new Error("cancelled"), result = generateDailyProductsWorkbook(report, controller.signal);
  const worker = FakeWorker.instances[0], message = worker.onmessage!, error = worker.onerror!;
  controller.abort(reason);
  message(new MessageEvent("message", { data: { workbook: new Uint8Array([80, 75]) } }));
  error(new Event("error"));
  await assert.rejects(result, rejected => rejected === reason);
  clean(worker, controller.signal);
});

test("export also releases worker handlers when no abort signal is supplied", async t => {
  installWorker(t);
  const result = generateDailyProductsWorkbook(report), worker = FakeWorker.instances[0], bytes = new Uint8Array([80, 75]);
  worker.message({ workbook: bytes });
  assert.equal(await result, bytes);
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null);
  assert.equal(worker.onerror, null);
  assert.equal(worker.onmessageerror, null);
});
