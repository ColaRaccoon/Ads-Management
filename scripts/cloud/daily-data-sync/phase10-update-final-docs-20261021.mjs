import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
const base='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/docs/daily-data-automation/';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const result=JSON.parse(readFileSync(E+'/continuation-20261021/cafe-oneoff-controller-v6/execute-d-result.json','utf8'));
assert.equal(result.status,'PASS');for(const k of ['containVerified','policiesRemoved','protectedRowsVerified','environmentAndStoppedImageUnchanged'])assert.equal(result.cleanup[k],true);
assert.equal(result.dayResults.length,2);assert(result.dayResults.every(x=>x.status==='PASS'));
const names=['10_배포전통합검증.md','진행표.md','records/10_결과.md','records/10_배포판정.md','records/10_배포명세.md','records/10_비밀노출사고_20261019.md','records/10_후속검증_20261020.md'];
for(const name of names){
 let s=readFileSync(base+name,'utf8');const link=(name.startsWith('records/')?'':'records/')+'10_추가실검증_20261021.md';
 const text=`**10/21 승인 범위 완료 / 운영 NO-GO:** [최종 추가 실검증](${link})이 최신이다. 원08의 신규52·70 FORCE RLS,16·17일 새 epoch/각 MANUAL1개로556주문·614품목의 실제 원격 저장과 값/연결 대조를 완료했다. 원 실패 예약·만료 checkpoint·CSV5를 보존하고 NOLOGIN/backend0·임시 권한/정책0·149예약OFF·정지 이미지/환경으로 복귀했으며 별도 조회와 독립 공개 증거 검사도 통과했다. 아래51/68·원격52 미적용 표기는 과거 이력이다. 공유 자격 실제 처분·기존 CDN 캐시·조직 실제 소비/잔여는 미해결이며 운영·공유 변경과11/12 착수는0이다.`;
 assert(/\*\*10\/21[^\r\n]*\r?\n/.test(s),name);
 s=s.replace(/\*\*10\/21[^\r\n]*/,text);
 if(name==='진행표.md')s=s.replace('갱신일: 2026-10-20 KST','갱신일: 2026-10-21 KST');
 writeFileSync(base+name,s,'utf8');
}
const path=base+'records/10_추가실검증_20261021.md';let s=readFileSync(path,'utf8');
s=s.replace('상태: **실제 공급자 입력의 새 관측·수동 복구 검증 진행 중**.','상태: **승인된 수정·격리 필수 검증 완료 / 공유·CDN·실사용량 잔여 / 운영 NO-GO**.');
s=s.replace('## 진행 중인 필수 작업과 완료 경계','## 실행 이력과 완료 경계');
s=s.replace('수정·합성 native 재검증한다.','수정했다. 새 v3 driver의 v4 합성 native32/32 검사에서 모든 명령 exit0·spawn error 없음·정상 PG 종료를 확인했다(`live-native-v4-driver-pass.json`, 독립 `live-native-v4-driver-public-audit-v1.json`).');
s+='\n\n## 최종 실제 결과와 정리 — 10:28~10:31 KST\n\n';
s+='`cafe-oneoff-controller-v6/execute-d-result.json`은 PASS다.16일287주문/310품목·582GET·1,046,506B,17일269주문/304품목·546GET·961,052B로, 합계556주문/614품목·1128GET·2,007,558B를 실제 공급자에서 새로 두 번 대조했다. 원격 새 epoch2개(관측556+checkpoint2=558행), 새 USER MANUAL2개·SUCCEEDED unit2개·값 전량/현재 연결/coverage lastSuccess 대조를 완료했다. 원 API version614+line614행 및 연결 이력은 새 run에 결속되고 CSV version5가 우선인 API shadow 상태를 유지한다. 원 실패 예약 run과 만료 checkpoint·V1 이력·다른 기존 자료는 보호 해시로 보존했다. V1 연속성 복원·정상 예약 재개·운영 배포 성공으로 확대하지 않는다.\n\n';
s+='finally의 Contain/Cleanup과 별도 `final-d-inspect.json` 조회에서70 FORCE RLS·runtime NOLOGIN/backend0/lease0·기존 민감4표 grant0·신규2표 임시 grant/policy0·149예약OFF/paused3/STOPtrue·원 환경/정지39c6 이미지 불변을 확인했다. 독립 `oneoff-continuation-actual-public-audit-v2.json`은 입력/조상/소스 지문과 합계를 검증했고, `oneoff-fresh-inspection-public-audit-v1.json`은 최종38필드 전체가 새 조회와 같은 것을 확인했다. 독립 검사는 공개 영수증/소스 검사이며 독립 DB 쿼리라고 주장하지 않는다.\n\n';
s+='`final-source-after-oneoff.json`에서 후보/현재 작업 공간495개·52 migration·원 HEAD/branch·staged0·삭제240 보존을 다시 확인했다. 최종 로컬 검사에서20일07:52UTC부터 남은 Docker Desktop7개 프로세스를 발견했고, 실행 중 컨테이너0과 정확 PID/시작 구간을 확인한 뒤 공식 `docker desktop stop`으로 정상 종료했다. 첫 로컬 FAIL은 보존한다. 정리 도구 v1의 UTC/로컬 DateTime 비교 오류는 변경 전 거절됐으며 v2에서 UTC 비교만 바로잡아 완료했다. 강제 종료·컨테이너/이미지/볼륨/파일 삭제0이다. `final-local-cleanup.json`과 새 `final-local-state.json`은 검사 PG4포트와 Docker 프로세스0을 확인한다. 과거의 중지 유지 문구를 당시 실제 관측 없이 현재까지 확대하지 않는다.\n\n';
s+='최종 선정 파일의 비밀 literal/pattern·보호 자료 ACL·임시 암호 잔존·옛 백업 복원 금지 플래그는 `continuation-20261021/resume-20261021-secret-scan-v2.json`의 결과를 따른다. 새 도구/보호 plan/실패 이력과8개 문서를 결속한 최종 진입점은 `continuation-20261021/final-closeout.json`이다. 전체 대화 전사문·과거 사본의 소급 삭제 또는 모든 복원 프로그램의 개별 감사 완료로 확대하지 않는다.\n\n';
s+='승인된 수정·격리 실제 검증은 완료했다. 공유 자격 실제 폐기/전체 소비자 전환, 정확 이전 Storage URL의 캐시 거부, 조직 실제 소비·cycle·잔여 확인은 위 인계 항목으로 남는다. 원격 일회성 SQL을 일반 운영 migration 수렴 증거로 쓰지 않으며 정상 운영 NO-GO·운영 변경0·공유 자격 변경0·11/12 NOT_STARTED를 유지한다.\n';
writeFileSync(path,s,'utf8');console.log(JSON.stringify({status:'UPDATED',documents:8,operatingOrSharedCredentialChanges:0,rawValuesReturned:0}));
