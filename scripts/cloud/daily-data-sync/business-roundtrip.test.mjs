import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assertBusinessTarget, businessFailureDiagnostic} from './seed-isolated-business-config.mjs';
export function fixture() {
  const configuration = {products:[],costRules:[],productRules:[],couponRules:[]};
  for (let i=0;i<18;i++) configuration.products.push({id:`product-${i}`,code:`code-${i}`,name:'한글 상품 / & < >',displayName:null,sortOrder:i,isActive:true});
  for (let i=0;i<24;i++) configuration.costRules.push({id:`cost-${i}`,productId:'product-0',salePriceKrw:'1000.00',vatKrw:'0',productCostKrw:'123.45',shippingKrw:'0',extraCostKrw:null,fxRateKrwPerUsd:'1380.000000',effectiveFrom:'2026-09-29',effectiveTo:null});
  for (let i=0;i<35;i++) configuration.productRules.push({id:`rule-${i}`,productId:'product-0',displayName:'상품',productNumbers:[],productNameAliases:['가','나'],optionIncludeKeywords:[],optionExcludeKeywords:[],adCostSourceProductId:null,roasGroup:null,salePriceKrwOverride:null,productCostKrwOverride:null,shippingKrwOverride:null,extraCostKrwOverride:null,priority:i,isActive:true,validFrom:'2026-10-01',validTo:null,createdAt:'2026-10-13T01:02:03.123Z'});
  for (let i=0;i<2;i++) configuration.couponRules.push({id:`coupon-${i}`,name:'쿠폰',scope:'ORDER',productId:null,discountKrw:'100.00',priority:i,validFrom:'2026-10-01',validTo:null,isActive:true,createdAt:'2026-10-13T01:02:03.123Z'});
  return {readOnly:true,source:'CURRENT_INTERNAL_CONFIGURATION',observedAt:'2026-10-13T01:02:03.123Z',fingerprint:createHash('sha256').update(JSON.stringify(configuration)).digest('hex'),counts:{products:18,costRules:24,productRules:35,couponRules:2},configuration};
}
const target = {projectRef:'ehnfrrmbkvlsbpvqcvkr',freshVerified:true,databaseUrl:'postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:SYNTHETIC@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full&connection_limit=3&pool_timeout=10&connect_timeout=10'};
if (process.argv[1]?.endsWith('business-roundtrip.test.mjs')) {
if (process.argv.includes('--fixture')) process.stdout.write(JSON.stringify(fixture()));
else {
  let raw=''; for await(const bytes of process.stdin) raw+=bytes;
  const configuration=JSON.parse(raw);
  try {
    assertBusinessTarget({...target,configuration});
    const expected=fixture();
    assert.deepEqual(configuration.products,expected.configuration.products);
    assert.deepEqual(configuration.costRules,expected.configuration.costRules);
    assert.deepEqual(configuration.productRules,expected.configuration.productRules);
    assert.deepEqual(configuration.couponRules,expected.configuration.couponRules);
    assert.equal(configuration.observedAt,expected.observedAt);
    assert.equal(configuration.hash,expected.fingerprint);
    assert.equal(businessFailureDiagnostic({code:['P1001','SYNTHETIC_PRIVATE']}).code,'UNCLASSIFIED');
    assert.equal(businessFailureDiagnostic({code:'P1001'}).code,'P1001');
    assert.equal(businessFailureDiagnostic(new Error('CONFIGURATION_FINGERPRINT_MISMATCH'),'CONFIGURATION').code,'CONFIGURATION_FINGERPRINT_MISMATCH');
    process.stdout.write(JSON.stringify({state:'BUSINESS_SERIALIZATION_PASS',providerRequests:0,networkRequests:0}));
  } catch(error) { process.stdout.write(JSON.stringify(businessFailureDiagnostic(error))); process.exitCode=1; }
}
}
