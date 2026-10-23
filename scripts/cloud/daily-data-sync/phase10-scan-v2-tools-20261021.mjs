import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base='scripts/cloud/daily-data-sync/';
let source=readFileSync(base+'phase10-final-secret-scan-20261021.ps1','utf8');
if(createHash('sha256').update(source).digest('hex')!=='b035ff291260e923490cc4e5e30dfc59cdbdc5d61f4b539e6efc2f51569c198d')throw Error('CONSUMED_SCAN_SOURCE_DRIFT');
const replace=(old,value)=>{if(!source.includes(old))throw Error('SCAN21_V2_DERIVATION');source=source.replace(old,()=>value);};
replace("$Label='resume-20261021-secret-scan-v1'","$Label='resume-20261021-secret-scan-v2'");
replace("foreach($field in @('refreshToken','access','observationKeyB64'))","foreach($field in @('refreshToken','access','observationKeyB64','bodyB64','normalizedPayloadBase64','databaseUrl'))");
replace('$current21Protected=0',"$current21Plans+=@('cafe08-live-epoch-plan-20261021-cafe08-epoch-live-b','cafe08-live-epoch-normalized-20261021-cafe08-epoch-live-b-2026-10-16','cafe08-live-epoch-normalized-20261021-cafe08-epoch-live-b-2026-10-17')\n $current21Protected=0");
replace('$current21Protected=0',"$current21Plans+=@('cafe08-oneoff-20261021-input-a','cafe08-oneoff-20261021-prepared-a','cafe08-oneoff-20261021-prepared-a-armed')\n $current21Protected=0");
replace('$current21Protected=0',String.raw`$current21Plans+=@('cafe08-oneoff-20261021-input-b','cafe08-oneoff-20261021-prepared-b','cafe08-oneoff-20261021-prepared-b-armed')
 foreach($oneoffFile21 in Get-ChildItem -LiteralPath $script:IncidentPrivate -File -Filter 'cafe08-oneoff-20261021-*.dpapi'){
  if($oneoffFile21.BaseName -cnotmatch '^cafe08-oneoff-20261021-(?:input|prepared)-[a-z0-9-]{1,80}$' -or ($oneoffFile21.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'CURRENT21_ONEOFF_SCOPE'}
  $current21Plans+=$oneoffFile21.BaseName
 }
 $current21Plans=@($current21Plans|Sort-Object -Unique)
 $current21Protected=0`);
replace("  if($current21Name -ceq 'cafe08-recovery-response-20261021-cafe08-epoch-live-a')", "  if($current21Value.ContainsKey('plan')){if($current21Value.plan.eligibleSecretRollback -cne $false){throw 'CURRENT21_NESTED_QUARANTINE'};foreach($field in @('access','observationKeyB64','databaseUrl')){if($current21Value.plan.ContainsKey($field) -and $current21Value.plan[$field] -is [string]){[void]$literals.Add($current21Value.plan[$field])}}}\n  if($current21Name -ceq 'cafe08-recovery-response-20261021-cafe08-epoch-live-a')");
replace("'^cafe-(?:live|epoch|epoch-live)-local-'","'^cafe-(?:(?:live|epoch|epoch-live)-local-|oneoff-guard-local-)'");
replace("'^cafe-(?:live|epoch|epoch-live)-local-[a-f0-9-]{36}$'","'^cafe-(?:(?:live|epoch|epoch-live)-local|oneoff-guard-local)-[a-f0-9-]{36}$'");
replace("'owner-password.txt'))","'owner-password.txt','oneoff-owner-password.txt'))");
replace(" foreach($current21Root in @('continuation-20261021','independent/resume-20261021')){",String.raw` foreach($sourceRoot21 in Get-ChildItem -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation' -Directory | Where-Object {$_.Name -cmatch '^cafe-[a-z0-9-]+-20261021-v[1-9][0-9]*$'}){foreach($sourceEntry21 in Get-ChildItem -LiteralPath $sourceRoot21.FullName -Recurse -File){if($sourceEntry21.Extension -cin @('.mjs','.ps1','.ts') -and $sourceEntry21.FullName -notmatch '[\\/](node_modules|pg-data)[\\/]'){if(($sourceEntry21.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'CURRENT21_SOURCE_REPARSE'};[void]$files.Add($sourceEntry21.FullName)}}}
 foreach($current21Root in @('continuation-20261021','independent/resume-20261021')){`);
replace("$out=@{current21ProtectedObjectsChecked=","$out=@{knownCurrent21WholeResponseAndNormalizedBase64LiteralsIncluded=$true;current21ProtectedObjectsChecked=");
if(process.argv.includes('--verify-only')){
 const exact=source===readFileSync(base+'phase10-final-secret-scan-v2-20261021.ps1','utf8');
 console.log(JSON.stringify({kind:'SCAN21_V2_DERIVATION_RECHECK',exact,sensitiveReads:0,remoteCalls:0}));
 if(!exact)process.exitCode=1;
}else writeFileSync(base+'phase10-final-secret-scan-v2-20261021.ps1',source,{flag:'wx'});
console.log(JSON.stringify({kind:'SCAN21_V2_TOOL_DERIVED',sensitiveReads:0,remoteCalls:0}));
