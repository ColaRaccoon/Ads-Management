import assert from "node:assert/strict";
import test from "node:test";
import { CoupangProductMatcher, type CoupangRuleInput } from "./coupang-product-matcher";

const matcher = new CoupangProductMatcher(), date = "2026-10-01";
const rule = (extra: Partial<CoupangRuleInput> = {}): CoupangRuleInput => ({ id: "single", productId: "venom",
  displayName: "베놈 공용 1개", includeKeywords: ["베놈", "1개"], excludeKeywords: ["여성"], priority: 100,
  validFrom: "2026-06-01", ...extra });

test("unrelated exclusion is no-match, and a legitimate candidate is unaffected", () => {
  assert.equal(matcher.matchText("여성 양말", [rule()], date).reason, "NO_MATCH");
  assert.equal(matcher.matchText("베놈 여성 1개", [rule()], date).reason, "EXCLUDED_BY_KEYWORD");
  assert.match(matcher.matchText("베놈 여성 1개", [rule()], date).candidates[0], /여성/);
  assert.equal(matcher.matchText("여성 양말", [rule(), rule({ id: "sock", productId: "sock", includeKeywords: ["양말"], excludeKeywords: [] })], date).productId, "sock");
});
test("duplicate aliases for one product resolve deterministically; distinct tied products conflict", () => {
  const duplicate = rule({ id: "duplicate" });
  const a = matcher.matchText("베놈 1개", [rule(), duplicate], date);
  assert.equal(a.reason, "MATCHED");
  assert.equal(a.matchRuleId, matcher.matchText("베놈 1개", [duplicate, rule()], date).matchRuleId);
  assert.equal(matcher.matchText("베놈 1개", [rule(), rule({ productId: "other", id: "other" })], date).reason, "AMBIGUOUS_MATCH");
});
test("a lower-priority different product remains visible for review without silently changing established precedence", () => {
  const result = matcher.matchText("베놈 1개", [rule(), rule({ id: "other", productId: "other", priority: 200 })], date);
  assert.equal(result.productId, "venom");
  assert.deepEqual(result.candidateProductIds, ["venom", "other"]);
  assert.deepEqual(result.reviewReasons, ["LOWER_PRIORITY_PRODUCT_CANDIDATE"]);
});
for (const text of ["베놈 11개", "베놈 21개", "베놈 1.1개", "베놈 1+1개"]) test(`numeric boundary: ${text}`, () => {
  assert.equal(matcher.matchText(text, [rule()], date).reason, "NO_MATCH");
});
test("actual option quantity takes precedence over marketing text", () => {
  const pair = rule({ id: "pair", productId: "pair", includeKeywords: ["베놈", "2개"] });
  assert.equal(matcher.matchProduct({ productName: "베놈 1개 특가", optionName: "블랙 2개 M" }, [rule(), pair], date).productId, "pair");
  assert.equal(matcher.matchProduct({ productName: "베놈 1개", optionName: "블랙 M" }, [rule()], date).productId, "venom");
  assert.equal(matcher.matchProduct({ productName: "베놈", optionName: "1 개입 M" }, [rule()], date).productId, "venom");
});
for (const text of ["베놈, 1개, 2개", "베놈 1개+1개"]) test(`conflicting/bundled quantity requires review: ${text}`, () => {
  assert.equal(matcher.matchText(text, [rule()], date).reason, "OPTION_CONFLICT");
});
test("repeated option labels and literal punctuation stay intact", () => {
  assert.equal(matcher.matchText("베놈,블랙,블랙,1개,1개,M,M", [rule()], date).reason, "MATCHED");
  assert.equal(matcher.matchText("베놈, 1개", [rule({ includeKeywords: ["베놈-프로", "1개"] })], date).reason, "NO_MATCH");
});
test("a broad fallback cannot hide contradictory quantities", () => {
  assert.equal(matcher.matchText("베놈, 1개, 2개", [rule(), rule({ id: "broad", includeKeywords: ["베놈"] })], date).reason, "OPTION_CONFLICT");
});

test("Coupang repeated marketing title does not override the selected insole pack", () => {
  const title = "인피니티 PORON러닝 깔창 남성용 여성용 1세트";
  const single = rule({ id: "one", productId: "one", includeKeywords: ["PORON", "1세트"], excludeKeywords: ["2세트"] });
  const pair = rule({ id: "two", productId: "two", includeKeywords: ["PORON", "2세트"], excludeKeywords: [] });
  assert.equal(matcher.matchProduct({ productName: title, optionName: `${title}, L2세트` }, [single, pair], date).productId, "two");
  assert.equal(matcher.matchText(`${title},L2세트,L2세트`, [single, pair], date).productId, "two");
  assert.equal(matcher.matchText(`${title},L1세트,L2세트`, [single, pair], date).reason, "OPTION_CONFLICT");
  assert.equal(matcher.matchProduct({ productName: title, optionName: `${title}, L` }, [single, pair], date).productId, "one");
  assert.equal(matcher.matchText(`${title},L,L`, [single, pair], date).productId, "one");
  assert.equal(matcher.matchProduct({ productName: title, optionName: `${title}, L, 1개, 블랙` }, [single, pair], date).productId, "one");
  assert.equal(matcher.matchText(`${title},L,L,1개,1개,블랙,블랙`, [single, pair], date).productId, "one");
  assert.equal(matcher.matchProduct({ productName: title, optionName: `${title}, L, 2개, 블랙` }, [single, pair], date).productId, null);
  assert.equal(matcher.matchText(`${title},L2세트,L2세트,1개,1개`, [single, pair], date).productId, "two");
});

test("numbered option punctuation is a delimiter while decimals and longer numbers are rejected", () => {
  const numbered = rule({ includeKeywords: ["케겔", "옵션1"], excludeKeywords: [] });
  assert.equal(matcher.matchText("케겔,옵션1.화이트", [numbered], date).reason, "MATCHED");
  assert.equal(matcher.matchText("케겔,옵션11.화이트", [numbered], date).reason, "NO_MATCH");
  assert.equal(matcher.matchText("케겔,옵션1.5화이트", [numbered], date).reason, "NO_MATCH");
});

test("promotion marketing quantity choices do not select the ten-pack over the actual five-pack", () => {
  const socks = [5,7,10].map(n => rule({ id: String(n), productId: String(n), includeKeywords: ["스포츠양말", `${n}개`], excludeKeywords: [] }));
  assert.equal(matcher.matchText("(5/7/10개입) 인피니티 스포츠양말,화이트 장목L 5개", socks, date).productId, "5");
  assert.equal(matcher.matchText("(5/7/10개입) 인피니티 스포츠양말,화이트 장목L", socks, date).reason, "OPTION_CONFLICT");
});
test("date boundaries, inactive products/rules and AND semantics are preserved", () => {
  assert.equal(matcher.matchText("베놈 1개", [rule({ validFrom: "2026-10-02" })], date).reason, "NO_MATCH");
  assert.equal(matcher.matchText("베놈 1개", [rule({ validTo: date })], date).reason, "MATCHED");
  assert.equal(matcher.matchText("베놈 1개", [rule({ validTo: "2026-09-30" })], date).reason, "NO_MATCH");
  assert.equal(matcher.matchText("베놈 1개", [rule({ isActive: false })], date).reason, "NO_MATCH");
  assert.equal(matcher.matchText("베놈 1개", [rule({ includeKeywords: ["베놈", "venom", "1개"] })], date).reason, "NO_MATCH");
});
test("advertising switch applies to spend only; conversion never moves spend to a different product", () => {
  const female = rule({ id: "female", productId: "female", includeKeywords: ["베놈", "여성", "1개"], excludeKeywords: [] });
  const result = matcher.matchAdProducts({ adExecutionProductName: "베놈 1개", conversionProductName: "베놈 여성 1개" }, [rule({ adEnabled: false }), female], date);
  assert.equal(result.spend.reason, "AD_DISABLED"); assert.equal(result.conversion.productId, "female");
  assert.equal(matcher.matchText("베놈 1개", [rule({ adEnabled: false })], date).productId, "venom");
});
test("ad name fallback only when execution name missing; placeholder inference remains explicit", () => {
  const fallback = matcher.matchAdProducts({ adExecutionProductName: "-", adName: "베놈 1개", conversionProductName: "-" }, [rule()], date);
  assert.equal(fallback.spend.productId, "venom"); assert.equal(fallback.inferred, true);
  const mismatch = matcher.matchAdProducts({ adExecutionProductName: "알 수 없는 상품", adName: "베놈 1개", conversionProductName: "베놈 1개" }, [rule()], date);
  assert.equal(mismatch.spend.productId, null); assert.equal(mismatch.conversion.productId, "venom");
});

test("a verified generic video spend alias cannot infer missing conversion product", () => {
  const videoRule=rule({includeKeywords:["[Video] 내 동영상 20261013142239"],excludeKeywords:[],productId:"pullup"});
  const result=matcher.matchAdProducts({adExecutionProductName:"-",adName:"[Video] 내 동영상 20261013142239",conversionProductName:"-"},[videoRule],date);
  assert.equal(result.spend.productId,"pullup");
  assert.equal(result.conversion.productId,null);
  assert.equal(result.inferred,false);
});

test("normalized rule reuse observes edits to both keyword arrays and source objects", () => {
  const r=rule(), source={productName:"베놈",optionName:"1개"};
  assert.equal(matcher.matchProduct(source,[r],date).productId,"venom");
  r.includeKeywords[1]="2개";
  assert.equal(matcher.matchProduct(source,[r],date).productId,null);
  source.optionName="2개";
  assert.equal(matcher.matchProduct(source,[r],date).productId,"venom");
  r.excludeKeywords.push("2개");
  assert.equal(matcher.matchProduct(source,[r],date).reason,"EXCLUDED_BY_KEYWORD");
});
