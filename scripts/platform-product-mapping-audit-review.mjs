import fs from 'node:fs';
import assert from 'node:assert/strict';
const dir = 'reports/platform-product-mapping-audit-20261103/';
const live = JSON.parse(fs.readFileSync(dir + 'live-inventory.json', 'utf8'));
const naver = JSON.parse(fs.readFileSync(dir + 'live-naver-catalog.json', 'utf8'));
const norm = value => (value ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
const canonical = new Map(live.unified.products.filter(p => p.active).map(p => [norm(p.canonicalName), p.canonicalName]));
const explicit = {
  '다이어트 양말': ['다이어트양말', '표기 차이', '띄어쓰기만 다름'],
  '두줄보호대': ['두줄무릎보호대', '명칭 확인', '자사몰 두줄무릎보호대와 동일 제품인지 승인 필요'],
  '두줄보호대 2개입': ['두줄무릎보호대', '세트 통합', '동일 제품의 2개입을 제품군으로 연결'],
  '버닝슬라이드': ['버닝 슬라이드', '표기 차이', '띄어쓰기만 다름'],
  '버닝웨이브': ['버닝웨이브바', '명칭 확인', '원천 부모 상품명과 자사몰 명칭 연결'],
  '버닝웨이브바 1개입': ['버닝웨이브바', '세트 통합', '기존 쿠팡 제품군명이 버닝웨이브바'],
  '버닝웨이브바 2개입': ['버닝웨이브바', '세트 통합', '기존 쿠팡 제품군명이 버닝웨이브바'],
  '플로우라이트_1개입': ['플로우라이트', '세트 통합', '기존 쿠팡 제품군명이 플로우라이트'],
  '플로우라이트_2개입': ['플로우라이트', '세트 통합', '기존 쿠팡 제품군명이 플로우라이트'],
  '한줄보호대 2개입': ['한줄보호대', '세트 통합', '동일 제품의 개입수 구분 보존'],
  '한줄보호대 4개입': ['한줄보호대', '세트 통합', '동일 제품의 개입수 구분 보존'],
  '베놈 무릎보호대': ['베놈무릎보호대', '표기 차이', '띄어쓰기만 다름'],
  '러닝깔창 PORON 1+1': ['포론깔창', '명칭 확인', 'PORON과 포론 동일 제품 여부 승인 필요'],
  '러닝깔창 PORON 단품': ['포론깔창', '명칭 확인', 'PORON과 포론 동일 제품 여부 승인 필요'],
  '러닝깔창 데일리 1+1': ['데일리 깔창', '명칭 확인', '데일리 깔창과 동일 제품 여부 승인 필요'],
  '러닝깔창 데일리 단품': ['데일리 깔창', '명칭 확인', '데일리 깔창과 동일 제품 여부 승인 필요'],
  '러닝장갑 1+1': ['러닝장갑', '세트 통합', '단품과 1+1 구분 보존'],
  '발목보호대 데일리': ['발목보호대데일리', '표기 차이', '띄어쓰기만 다름'],
  '발목보호대 싸커': ['싸커발목보호대', '명칭 확인', '단어 순서가 다른 동일 제품 후보'],
  '손목보호대 기본형 1+1': ['손목보호대', '명칭 확인', '기본형과 프로형은 구분 유지'],
  '손목보호대 기본형 단품': ['손목보호대', '명칭 확인', '기본형과 프로형은 구분 유지'],
  '손목보호대 프로 1+1': ['손목보호대프로', '명칭 확인', '프로형은 프로 기준 제품으로 연결'],
  '손목보호대 프로 단품': ['손목보호대프로', '명칭 확인', '프로형은 프로 기준 제품으로 연결'],
  '스포츠 양말': ['스포츠양말', '표기 차이', '띄어쓰기만 다름'],
  '카프슬리브 1+1': ['카프슬리브', '세트 통합', '단품과 1+1 구분 보존'],
  '히트체인지 넥워머': ['히트체인지', '명칭 확인', '넥워머와 기존 히트체인지의 동일성 승인 필요'],
  '스텝마스터': ['스탭마스터', '명칭 확인', '스텝과 스탭 표기 차이 후보'],
  '퍼펙트 스케이트': ['퍼펙트스케이트', '표기 차이', '띄어쓰기만 다름'],
  '푸쉬업바': ['푸샵바', '명칭 확인', '푸쉬업바와 푸샵바의 동일성 승인 필요'],
  '페이스 롤러': ['페이스&바디롤러', '동일성 확인 필요', '페이스 전용과 페이스·바디 겸용의 동일 상품 여부 확인'],
  '실리콘리프팅1+1': ['실리콘리프팅밴드', '동일성 확인 필요', '별도 부모 상품으로 등록되어 동일 상품 여부 확인'],
  '무릎키퍼': ['무릎키퍼', '신규 기준제품 필요', '현재 기준에는 무릎키퍼_1개입과 _2개입만 있어 공통 기준 생성 검토'],
  '스카이깔창': ['스카이깔창', '신규 기준제품 필요', '같은 기준 제품 없음. 스카이스텝과 연결하지 않음'],
  '실리콘리프팅+페이스롤러': ['실리콘리프팅+페이스롤러', '복합상품 별도 유지', '구성품 한쪽에 전액 연결하지 않고 별도 기준 생성 검토'],
  '퍼펙트스케이트+퍼펙트슬라이드2': ['퍼펙트스케이트+퍼펙트슬라이드2', '복합상품 별도 유지', '두 구성품에 중복 반영하지 않고 별도 기준 생성 검토']
};
for (const name of ['베놈공용', '베놈공용 2개입', '베놈여성', '베놈여성 2개입'])
  explicit[name] = ['베놈무릎보호대', '제품군 통합 확인', '공용·여성을 동일 제품군으로 묶는지 승인 필요'];
const storeName = key => naver.inventory.stores.find(s => s.id === key)?.name ??
  (key === 'LEGACY_COUPANG_SINGLE_UPLOAD' ? '쿠팡 단일 업로드' : key === 'LEGACY_UNBOUND' ? '기존 자사몰' : '자사몰');
const sourceRows = [...live.sources.catalog, ...naver.inventory.catalog];
function propose(row) {
  if (explicit[row.source_name]) return explicit[row.source_name];
  const stripped = row.source_name?.replace(/(?:_| )?\d+개입$| \d+개$/u, '');
  if (stripped !== row.source_name && canonical.has(norm(stripped)))
    return [canonical.get(norm(stripped)), '세트 통합', '동일 명칭의 개입수만 다른 상품. 제품군 합산 승인 필요'];
  if (row.source_group === 'COUPANG' && /^풀업밴드 (그린|레드|블랙|퍼플|세트)$/.test(row.source_name))
    return ['풀업밴드', '옵션 통합 확인', '색상·세트 차이를 원천에 보존하고 공통 제품군으로 합산할지 확인'];
  return [canonical.get(norm(row.published_name)) ?? '', '현재 유지', ''];
}
const all = live.unified.nativeProducts.filter(row => !row.store_level).map(row => {
  const exists = canonical.has(norm(row.published_name));
  const [target, decision, reason] = propose(row);
  const changed = target && norm(target) !== norm(row.published_name);
  return { ...row, store: storeName(row.scope_key), target, targetExists: canonical.has(norm(target)), decision, reason,
    issue: !exists ? '기준제품 없음' : changed ? '제품군 분리' : '동일명 연결', needsReview: !exists || Boolean(changed) };
});
const review = all.filter(row => row.needsReview).sort((a, b) =>
  (a.issue === '기준제품 없음' ? 0 : 1) - (b.issue === '기준제품 없음' ? 0 : 1) || a.source_group.localeCompare(b.source_group) || a.source_name.localeCompare(b.source_name));
const catalogs = sourceRows.map(row => {
  const group = row.platform === 'NAVER_UNIT' ? 'NAVER' : row.platform === 'COUPANG' ? 'COUPANG' : 'STOREFRONT';
  const facts = all.filter(f => f.source_group === group && (group !== 'NAVER' || f.scope_key === row.scope_key) &&
    (f.source_product_key === row.source_ref || f.source_product_key.endsWith(':' + row.source_ref)));
  const parentFacts = group === 'NAVER' && row.parent_name ? all.filter(f => f.source_group === 'NAVER' && f.scope_key === row.scope_key && norm(f.source_name) === norm(row.parent_name)) : [];
  return { ...row, store: storeName(row.scope_key), state: row.store_level === 'true' ? '상점 광고·미식별 항목' : facts.length ? '실적 발행됨' :
    parentFacts.length ? '부모 상품 집계에 포함' : '독립 발행 실적 없음', publishedNames: [...new Set(facts.map(f => f.published_name))].join(', ') };
});
assert.equal(all.length, 201);
assert.equal(all.filter(r => r.issue === '기준제품 없음').length, 36);
assert.equal(review.filter(r => !r.target).length, 0);
const result = { observedAt: live.observedAt, businessWrites: 0, sourceRecords: catalogs.length,
  summary: ['STOREFRONT', 'GOOGLE', 'NAVER', 'COUPANG'].map(group => ({ group, total: all.filter(r => r.source_group === group).length,
    missing: all.filter(r => r.source_group === group && r.issue === '기준제품 없음').length,
    split: all.filter(r => r.source_group === group && r.issue === '제품군 분리').length })),
  all, review, catalogs, canonicalProducts: live.unified.products,
  coverage: live.unified.publicationCoverage.map(p => ({ ...p, store: storeName(p.scope_key) })),
  excludedStoreLevel: live.unified.nativeProducts.filter(r => r.store_level) };
fs.writeFileSync(dir + 'mapping-review.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ summary: result.summary, review: review.length, catalog: catalogs.length,
  unresolved: review.filter(r => ['신규 기준제품 필요', '복합상품 별도 유지', '동일성 확인 필요'].includes(r.decision)).map(r => ({ name: r.source_name, target: r.target, decision: r.decision })) }));
