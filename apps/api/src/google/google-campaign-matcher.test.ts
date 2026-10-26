import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleCampaignMatcher } from "./google-campaign-matcher";

test("the five approved production campaign names retain their exact internal products", () => {
  const fixtures = [
    ["플로우라이트- 2026-10-20", "플로우라이트", "629e5f82-e2b5-4531-89cf-bc9fdabebf0b"],
    ["풀업바_2026-10-19", "풀업바", "5d716ce2-2aa3-452e-8f32-3c30eac1d9f0"],
    ["버닝 웨이브바 - 2026-10-19", "버닝웨이브바", "051772e0-d4bc-414b-8817-5ee09d3e7db6"],
    ["두줄무릎보호대 - 2026-10-21", "두줄무릎보호대", "f279ad95-d864-49af-a93d-f4ad50ed81a2"],
    ["자이로볼 아이언- 2026-10-23", "자이로볼", "cad62d19-f241-4f4e-b71d-f9e178065da3"]
  ];
  const match = createGoogleCampaignMatcher(fixtures.map(([, name, id]) => ({ id, name, displayName: name })));
  for (const [campaign, , id] of fixtures) {
    assert.deepEqual(match(campaign), { productId: id, warningCodes: [] });
    assert.deepEqual(match(`${campaign} 새 캠페인 2026-11-01`), { productId: id, warningCodes: [] });
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
