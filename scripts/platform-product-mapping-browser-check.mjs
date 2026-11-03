/** Local production web bundle with synthetic APIs. Blocks every external request. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:3319";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const products = [
  { id: "target", canonicalName: "베놈무릎보호대", active: true, version: 1 },
  { id: "source", canonicalName: "베놈공용 2개입", active: true, version: 1 }
];
const permissions = ["data.read", "products.manage", "mappings.manage", "operations.run"];
const errors = [], unexpected = [], mutations = [];
let saved, preview;
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith("/backend-api/")) return route.continue();
    const path = url.pathname.slice("/backend-api".length);
    const json = value => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/auth/me") return json({ user: { id: "synthetic-mapping-user", username: "synthetic", name: "합성 검증", email: null,
      role: "USER", isActive: true, inviteStatus: "ACTIVE" }, permissions, authorizationVersion: "v1" });
    if (path === "/unified-products/configuration") return json({ products, rules: saved ? [saved] : [], versions: { configurationVersion: saved ? "v2" : "v1" } });
    if (path === "/unified-products/source-products") return json({ products: [{ key: "source", group: "COUPANG", platform: "COUPANG",
      scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", sourceName: "베놈공용 2개입", nameField: "native:COUPANG",
      firstDate: url.searchParams.get("from"), lastDate: url.searchParams.get("to"), publishedName: "베놈공용 2개입",
      targetName: saved ? "베놈무릎보호대" : "베놈공용 2개입", matchStatus: "MATCHED", pending: Boolean(saved), ruleIds: saved ? [saved.id] : [] }], note: "합성 발행 상품" });
    if (path === "/unified-rules/preview") {
      preview = request.postDataJSON();
      return json({ canSave: true, overlaps: [], aliasConflicts: [], versionConflict: false,
        affectedRange: { from: preview.validFrom, to: preview.validTo }, versions: { configurationVersion: "v1" },
        samples: preview.samples.map(sample => ({ ...sample, originalOption: "", canonicalProductName: "베놈무릎보호대",
          saleUnitName: null, candidateNames: ["베놈무릎보호대"], ruleIds: ["preview"], reasons: ["EXACT_NAME_OR_ALIAS"], matchStatus: "MATCHED" })) });
    }
    if (path === "/unified-rules" && request.method() === "POST") {
      const body = request.postDataJSON(); mutations.push({ path, body }); saved = { ...body, id: "saved-link", version: 1 };
      return json({ rule: saved, affectedRange: { from: saved.validFrom, to: saved.validTo },
        affectedScope: { platforms: ["COUPANG"], scopeKeys: ["LEGACY_COUPANG_SINGLE_UPLOAD"] } });
    }
    if (path === "/unified-performance/rebuild") {
      const body = request.postDataJSON(); mutations.push({ path, body });
      return json({ jobs: [{ jobId: "synthetic-job", platform: "COUPANG", date: body.to, status: "QUEUED", phase: "QUEUED" }] });
    }
    if (path === "/unified-performance/rebuild/synthetic-job") return json({ jobId: "synthetic-job", platform: "COUPANG", status: "PUBLISHED", phase: "PUBLISHED" });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Unmocked API blocked" }) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/products/mappings`);
  await page.getByRole("heading", { name: "플랫폼 통합 제품 매핑", exact: true }).waitFor();
  await page.getByRole("button", { name: "연결 설정", exact: true }).click();
  const form = page.locator("form").filter({ has: page.getByText("원천 상품 → 기준 제품 연결", { exact: true }) });
  assert.equal(await form.getByLabel("원천 상품명", { exact: true }).inputValue(), "베놈공용 2개입");
  await form.getByLabel(/^연결할 기준 제품/).selectOption("target");
  await form.getByLabel("변경 사유", { exact: true }).fill("베놈 플랫폼 통합 합성 검증");
  await form.getByRole("button", { name: "연결안 검토로 가져오기", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "미리본 규칙 저장", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "판정·영향 미리보기", exact: true }).click();
  await page.getByRole("button", { name: "미리본 규칙 저장", exact: true }).click();
  await page.getByRole("heading", { name: "저장 후 재집계 상태", exact: true }).waitFor();
  assert.equal(preview.payload.nameField, "native:COUPANG");
  assert.deepEqual(preview.payload.terms, ["베놈공용 2개입"]);
  assert.equal(preview.productId, "target");
  await page.getByRole("button", { name: "해당 기간 재집계 요청·동일 요청 확인", exact: true }).click();
  await page.getByRole("button", { name: "작업 상태 갱신", exact: true }).click();
  await page.getByText(/COUPANG.*PUBLISHED \/ PUBLISHED/).waitFor();
  assert.deepEqual(mutations[1].body.platforms, ["COUPANG"]);
  assert.deepEqual(mutations[1].body.scopeKeys, ["LEGACY_COUPANG_SINGLE_UPLOAD"]);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ status: "PASS", basis: "local production bundle, synthetic APIs", checks: [
    "source selection preserves set variant", "preview required before save", "exact platform/product payload",
    "save retains scoped rebuild envelope", "rebuild publication status", "no external or business API requests"
  ] }));
} finally { await browser.close(); }
