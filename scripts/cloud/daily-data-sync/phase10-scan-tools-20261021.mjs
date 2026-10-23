import {readFileSync,writeFileSync} from 'node:fs';
const base='scripts/cloud/daily-data-sync/';
let source=readFileSync(base+'phase10-resume-final-secret-scan-20261020.ps1','utf8');
const replace=(old,value)=>{if(!source.includes(old))throw Error('SCAN_DERIVATION_PIN');source=source.replace(old,()=>value);};
replace("$Label='resume-20261020-secret-scan-v1'","$Label='resume-20261021-secret-scan-v1'");
replace('(?:20261020|performance)','(?:20261020|20261021|performance)');
replace(')-20261020-v[1-9][0-9]*$',')-202610(?:20|21)-v[1-9][0-9]*$');
replace("$stage='APPROVED_FILE_SELECTION'\n foreach($file",`$stage='CURRENT21_PROTECTED_LITERALS'
 $current21Plans=@('cafe08-recovery-storage-probe-20261021-cafe08-epoch-live-a','cafe08-recovery-plan-20261021-cafe08-epoch-live-a','cafe08-recovery-response-20261021-cafe08-epoch-live-a','cafe08-recovery-forward-20261021-cafe08-epoch-live-a','cafe08-live-epoch-plan-20261021-cafe08-epoch-live-a','cafe08-live-epoch-normalized-20261021-cafe08-epoch-live-a-2026-10-16','cafe08-live-epoch-normalized-20261021-cafe08-epoch-live-a-2026-10-17')
 $current21Protected=0
 foreach($current21Name in $current21Plans){if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($current21Name+'.dpapi'))){
  $current21Value=Read-IncidentPrivate $current21Name
  if($current21Value.eligibleSecretRollback -cne $false){throw 'CURRENT21_QUARANTINE'}
  $current21Protected++
  foreach($field in @('refreshToken','access','observationKeyB64')){if($current21Value.ContainsKey($field) -and $current21Value[$field] -is [string]){[void]$literals.Add($current21Value[$field])}}
  if($current21Name -ceq 'cafe08-recovery-response-20261021-cafe08-epoch-live-a'){
   if($current21Value.operationKey -cne '20261021-cafe08-epoch-live-a' -or $current21Value.httpStatus -ne 200 -or $current21Value.complete -cne $true){throw 'CURRENT21_RESPONSE'}
   $current21Body=[Convert]::FromBase64String($current21Value.bodyB64)
   try{if($current21Body.Length -gt 32768){throw 'CURRENT21_BODY_BOUND'};$current21Token=[Text.Encoding]::UTF8.GetString($current21Body)|ConvertFrom-Json -AsHashtable -Depth 10
    foreach($field in @('access_token','refresh_token')){if($current21Token[$field] -isnot [string] -or $current21Token[$field].Length -lt 20){throw 'CURRENT21_TOKEN'};[void]$literals.Add($current21Token[$field])}
   }finally{[Array]::Clear($current21Body);$current21Token=$null;$current21Body=$null}
  };$current21Value=$null
 }}
 $stage='APPROVED_FILE_SELECTION'
 foreach($file`);
replace("foreach($path in @($files|Sort-Object))",`foreach($current21Root in @('continuation-20261021','independent/resume-20261021')){
  $selected21=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation' $current21Root
  if(Test-Path -LiteralPath $selected21){foreach($entry21 in Get-ChildItem -LiteralPath $selected21 -Recurse -File){if(($entry21.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'CURRENT21_REPARSE'};if($entry21.Extension -cin @('.json','.txt','.log','.md') -and $entry21.FullName -notmatch '[\\\\/](node_modules|pg-data)[\\\\/]'){[void]$files.Add($entry21.FullName)}}}
 }
 foreach($path in @($files|Sort-Object))`);
replace("'^cafe-(?:live|epoch)-local-'","'^cafe-(?:live|epoch|epoch-live)-local-'");
replace("'^cafe-(?:live|epoch)-local-[a-f0-9-]{36}$'","'^cafe-(?:live|epoch|epoch-live)-local-[a-f0-9-]{36}$'");
replace("@('initdb-owner-password.txt','epoch-owner-password.txt')","@('initdb-owner-password.txt','epoch-owner-password.txt','owner-password.txt')");
replace("$out=@{kind='INCIDENT_INDEPENDENT_FINAL_LOCAL_SECRET_SCAN'","$out=@{current21ProtectedObjectsChecked=$current21Protected;current21ScopeIncluded=$true;kind='INCIDENT_INDEPENDENT_FINAL_LOCAL_SECRET_SCAN'");
replace("Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020' ($Label+'.json')","Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021' ($Label+'.json')");
writeFileSync(base+'phase10-final-secret-scan-20261021.ps1',source,{flag:'wx'});
console.log(JSON.stringify({kind:'SCAN21_TOOL_DERIVED',sensitiveReads:0,remoteCalls:0}));
