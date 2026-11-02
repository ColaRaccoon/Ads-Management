import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleCampaignMatcher, googleKeywordIdentity, googleKeywordFromMapping } from "./google-campaign-matcher";
import type { GooglePerformanceMapping } from "@prisma/client";

test("account-scoped dated keywords resolve the three aliases and never leak through the name cache", () => {
  const names = ["아이언볼", "러닝장갑", "퍼펙트슬라이드"];
  const aliases = ["아이언", "방한장갑", "퍼슬"];
  const products = names.map((name, index) => ({ id: String(index), name, displayName: name }));
  const rules = aliases.map((keyword, index) => ({ connectionId: "google", keyword, productId: String(index), startDate: "2026-11-01", endDate: "2026-11-03" }));
  const match = createGoogleCampaignMatcher(products, rules);
  for (const [index, alias] of aliases.entries()) {
    const name = `${alias} - 2026-10-30`;
    assert.equal(match(name, { connectionId: "google", date: "2026-11-01" }).productId, String(index));
    assert.equal(match(name, { connectionId: "other", date: "2026-11-01" }).productId, null);
    assert.equal(match(name, { connectionId: "google", date: "2026-10-31" }).productId, null);
    assert.equal(match(name, { connectionId: "google", date: "2026-11-03" }).productId, String(index));
    assert.equal(match(name, { connectionId: "google", date: "2026-11-04" }).productId, null);
  }
  assert.equal(match("퍼 슬 - 신규", { connectionId: "google", date: "2026-11-01" }).productId, "2");
});

test("keyword/name collisions stay ambiguous while repeated matches for one product are deduplicated", () => {
  const products = [{ id: "p", name: "퍼펙트슬라이드", displayName: "퍼펙트슬라이드" }, { id: "g", name: "러닝장갑", displayName: "러닝장갑" }];
  const rule = { connectionId: "google", keyword: "퍼슬", productId: "p", startDate: "2026-11-01", endDate: null };
  const scope = { connectionId: "google", date: "2026-11-01" };
  const match = createGoogleCampaignMatcher(products, [rule, { ...rule, keyword: "슬라이드" }]);
  assert.equal(match("퍼펙트슬라이드 퍼슬", scope).productId, "p");
  assert.deepEqual(match("러닝장갑 퍼슬", scope), { productId: null, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT"] });
  const inactive = createGoogleCampaignMatcher(products.map(product => ({ ...product, isActive: false })), [rule]);
  assert.equal(inactive("퍼슬", scope).productId, null);
});

test("keyword storage recognizes only its versioned identity and cannot reuse legacy campaign IDs", () => {
  assert.equal(googleKeywordIdentity(" 퍼 슬 "), googleKeywordIdentity("퍼슬"));
  const row = { kind: "CAMPAIGN", campaignId: "퍼슬", connectionId: "google", productId: "p",
    identityKey: googleKeywordIdentity("퍼슬"), startDate: new Date("2026-11-01"), endDate: null } as GooglePerformanceMapping;
  assert.equal(googleKeywordFromMapping(row)?.keyword, "퍼슬");
  assert.equal(googleKeywordFromMapping({ ...row, identityKey: "legacy-campaign-id-hash" }), null);
  assert.equal(googleKeywordFromMapping({ ...row, kind: "SALE" }), null);
});

test("production campaign names match fixed products independently of changing date suffixes", () => {
  const fixtures = [
    ["플로우라이트- 2026-10-20", "플로우라이트", "629e5f82-e2b5-4531-89cf-bc9fdabebf0b"],
    ["풀업바_2026-10-19", "풀업바", "5d716ce2-2aa3-452e-8f32-3c30eac1d9f0"],
    ["버닝 웨이브바 - 2026-10-19", "버닝웨이브바", "051772e0-d4bc-414b-8817-5ee09d3e7db6"],
    ["두줄무릎보호대 - 2026-10-21", "두줄무릎보호대", "f279ad95-d864-49af-a93d-f4ad50ed81a2"],
    ["자이로볼 아이언- 2026-10-23", "자이로볼", "cad62d19-f241-4f4e-b71d-f9e178065da3"],
    ["다이어트양말 - 2026-10-27", "다이어트양말", "e0e923ae-bae6-40c5-94e9-3a2a11e53c63"],
    ["베놈 - 2026-10-27", "베놈무릎보호대", "e5c90207-13b1-46d7-a02a-94c2e7cae005"]
  ];
  const match = createGoogleCampaignMatcher(fixtures.map(([, name, id]) => ({ id, name, displayName: name })));
  for (const [campaign, , id] of fixtures) {
    assert.deepEqual(match(campaign), { productId: id, warningCodes: [] });
    assert.deepEqual(match(`${campaign} 새 캠페인 2026-11-01`), { productId: id, warningCodes: [] });
    for (const date of ["2026-10-28", "2026-11-01"]) {
      assert.deepEqual(match(campaign.replace(/\d{4}-\d{2}-\d{2}/u, date)), { productId: id, warningCodes: [] });
    }
    assert.deepEqual(match(campaign.replace(/[-_]\s*\d{4}-\d{2}-\d{2}/u, "").trim()), { productId: id, warningCodes: [] });
  }
});

test("names normalize whitespace, case and compatibility characters without counting same-product aliases twice", () => {
  const match = createGoogleCampaignMatcher([{ id: "p", name: "ＡＢＣ 바", displayName: "ABC바" }]);
  assert.equal(match("신규 abc\t바 광고").productId, "p");
  assert.equal(match("ＡＢＣ　바 동영상").productId, "p");
});

test("distinct products with the same name or multiple matching product names remain unallocated", () => {
  const duplicate = createGoogleCampaignMatcher([{ id: "p1", name: "풀업바", displayName: "풀업바" },
    { id: "p2", name: "풀 업 바", displayName: "다른 표시명" }]);
  assert.deepEqual(duplicate("풀업바 캠페인"), { productId: null, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT"] });
  const multiple = createGoogleCampaignMatcher([{ id: "p1", name: "풀업바", displayName: "풀업바" },
    { id: "p2", name: "자이로볼", displayName: "자이로볼" }]);
  assert.equal(multiple("풀업바+자이로볼 묶음").warningCodes[0], "AMBIGUOUS_CAMPAIGN_PRODUCT");
});

test("inactive, blank and unmatched names never fall back to codes or manual ID mappings", () => {
  const match = createGoogleCampaignMatcher([{ id: "off", name: "휴면상품", displayName: "휴면", isActive: false },
    { id: "empty", name: " ", displayName: "" }, { id: "product-code", name: "풀업바", displayName: "풀업 바" }]);
  for (const name of ["", "알 수 없는 캠페인", "휴면상품", "product-code"]) {
    assert.deepEqual(match(name), { productId: null, warningCodes: ["CAMPAIGN_PRODUCT_NOT_FOUND"] });
  }
});

test("the explicit Venom alias requires independent token boundaries and a known canonical product", () => {
  const match = createGoogleCampaignMatcher([{ id: "venom", name: "베놈 무릎보호대".normalize("NFD"), displayName: "베놈 무릎 보호대" }]);
  for (const campaign of ["베놈", "베놈 - 2026-10-28", "[베놈] 신규 광고", "YouTube_베놈_2026-11-01", "베놈/2026-11-01", "Google 베놈 광고"]) {
    assert.deepEqual(match(campaign), { productId: "venom", warningCodes: [] });
  }
  for (const campaign of ["베놈양말 - 2026-10-27", "베놈2 - 2026-10-27", "안티베놈", "슈퍼베놈", "베놈무릎 - 2026-10-27"]) {
    assert.deepEqual(match(campaign), { productId: null, warningCodes: ["CAMPAIGN_PRODUCT_NOT_FOUND"] });
  }
  const unrelated = createGoogleCampaignMatcher([{ id: "other", name: "다른무릎보호대", displayName: "다른무릎보호대" }]);
  assert.equal(unrelated("베놈 - 2026-10-27").productId, null);
});

test("Venom alias collisions and campaigns naming another product remain ambiguous", () => {
  const canonical = { id: "venom-knee", name: "베놈무릎보호대", displayName: "베놈무릎보호대" };
  for (const other of [
    { id: "actual-venom", name: "베놈", displayName: "베놈" },
    { id: "duplicate-knee", name: "베놈 무릎보호대", displayName: "베놈 무릎보호대" }
  ]) {
    const match = createGoogleCampaignMatcher([canonical, other]);
    assert.deepEqual(match("베놈 - 2026-10-28"), { productId: null, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT"] });
  }
  const multiple = createGoogleCampaignMatcher([canonical, { id: "pullup", name: "풀업바", displayName: "풀업바" }]);
  assert.deepEqual(multiple("베놈 + 풀업바 - 2026-10-28"), { productId: null, warningCodes: ["AMBIGUOUS_CAMPAIGN_PRODUCT"] });
});

test("alias cache preserves whitespace boundaries in either query order", () => {
  for (const names of [["안티 베놈", "안티베놈"], ["안티베놈", "안티 베놈"]]) {
    const match = createGoogleCampaignMatcher([{ id: "venom", name: "베놈무릎보호대", displayName: "베놈무릎보호대" }]);
    for (const campaign of names) assert.equal(match(campaign).productId, campaign.includes(" ") ? "venom" : null);
  }
});
