import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {MetaMappingRuleForm,MetaMappingRules,metaRuleBody,type MetaMappingRule} from '../apps/web/src/components/meta-mapping-rules';
const rule:MetaMappingRule={id:'rule',productId:'p',product:{displayName:'케겔'},pattern:'케겔',matchType:'CONTAINS',priority:100,isActive:true,validFrom:'2026-10-28T00:00:00Z',validTo:null,updatedAt:'2026-10-29T01:00:00.000Z'};
const props={rules:[rule],products:[{id:'p',displayName:'케겔'}],busy:false,from:'2026-10-28',to:'2026-10-28',onUpdate:()=>{},onApply:()=>{}};
test('management controls expose edit, activation and explicit dated application',()=>{
 const html=renderToStaticMarkup(createElement(MetaMappingRules,{...props,canManage:true}));
 for(const text of ['케겔 규칙 수정','케겔 규칙 비활성화','케겔 선택 기간 다시 적용','2026-10-28','수동 지정은 유지'])assert.ok(html.includes(text),text);
 const readonly=renderToStaticMarkup(createElement(MetaMappingRules,{...props,canManage:false}));assert.ok(!readonly.includes('<button'));
 const inactive=renderToStaticMarkup(createElement(MetaMappingRules,{...props,rules:[{...rule,isActive:false}],canManage:true}));assert.ok(inactive.includes('케겔 규칙 활성화'));
});
test('edit payload preserves the concurrency version and nullable end date',()=>{
 const body=metaRuleBody(rule);assert.equal(body.expectedUpdatedAt,rule.updatedAt);assert.equal(body.validFrom,'2026-10-28');assert.equal(body.validTo,null);
 const html=renderToStaticMarkup(createElement(MetaMappingRuleForm,{products:props.products,rule,busy:false,onSave:()=>{}}));
 for(const label of ['연결 제품','광고 이름 패턴','적용 시작일','적용 종료일','활성'])assert.ok(html.includes(label));
 assert.ok(html.includes('value="케겔"'));assert.ok(html.includes('name="isActive"'));assert.ok(html.includes('checked=""'));
});
