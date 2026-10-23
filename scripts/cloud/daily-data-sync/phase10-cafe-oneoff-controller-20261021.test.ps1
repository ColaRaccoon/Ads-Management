Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-oneoff-controller-20261021.ps1"
$count=0
function Check([bool]$Value){if(-not $Value){throw 'ONEOFF_STUB_ASSERT'}}
function Case([string]$Name,[scriptblock]$Body){& $Body;$script:count++;@{case=$Name;status='PASS'}|ConvertTo-Json -Compress}
function Reject([scriptblock]$Body){$rejected=$false;try{& $Body}catch{$rejected=$true};Check $rejected}
Case 'exact private reference prefix accepts expected input/prepared only' {Assert-OneoffName 'cafe08-oneoff-20261021-input-a';Assert-OneoffName 'cafe08-oneoff-20261021-prepared-a';Reject {Assert-OneoffName '../other'};Reject {Assert-OneoffName 'compromised-baseline'}}
$native='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-oneoff-guard-local-11111111-1111-4111-8111-111111111111'
Case 'owned PG PID verifies datadir port and sixth listen line, accepts empty socket' {Assert-OneoffNativePid @('1',($native+'/pg-data'),'0','55438','','127.0.0.1') $native}
Case 'owned PG PID rejects original occupied ports' {foreach($port in @('55436','55437','55439')){Reject {Assert-OneoffNativePid @('1',($native+'/pg-data'),'0',$port,'','127.0.0.1') $native}}}
Case 'owned PG PID rejects another datadir or listener' {Reject {Assert-OneoffNativePid @('1','C:/other','0','55438','','127.0.0.1') $native};Reject {Assert-OneoffNativePid @('1',($native+'/pg-data'),'0','55438','','0.0.0.0') $native}}
Case 'minimal parent variable projection omits unrelated credentials and customer settings' {$r=Select-OneoffVariables @{DATABASE_URL='SYNTHETIC_DSN';DAILY_SYNC_CREDENTIAL_KEY_V2='SYNTHETIC_KEY';DAILY_SYNC_CHECKPOINT_KEY_B64='SYNTHETIC_CP';DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64='SYNTHETIC_OBS';DAILY_SYNC_CAFE24_CLIENT_SECRET='EXCLUDED';GOOGLE_CREDENTIALS='EXCLUDED';META_TOKEN='EXCLUDED';OTHER='EXCLUDED'};Check ($r.Count -eq 4);Check (-not $r.ContainsKey('DAILY_SYNC_CAFE24_CLIENT_SECRET'))}
Case 'exact pins reject wrong controller before private read' {$p=Get-OneoffPins;Reject {Assert-OneoffPins $p ('0'*64) $p['phase10-cafe-oneoff-controller-20261021.mjs'] $p['phase10-cafe-oneoff-executor-20261021.mjs']}}
Case 'tool dictionary equality ignores serialization order but rejects keys/values' {Assert-OneoffPinSet ([ordered]@{a='1';b='2'}) @{b='2';a='1'};Reject {Assert-OneoffPinSet @{a='1'} @{a='2'}};Reject {Assert-OneoffPinSet @{a='1'} @{z='1'}}}
# Every function that could touch credentials, management APIs, processes or disk
# is replaced before invoking the controller. These are control-flow tests only.
$script:realPins=Get-OneoffPins
$script:calls=[Collections.Generic.List[string]]::new();$script:receipts=@{};$script:failAt='';$script:dayResults=@();$script:inputs=@{}
function Get-OneoffPins{return $script:realPins}
function Assert-OneoffHeldState([string]$ExpectedVariables='',$Plan=$null){$script:calls.Add('HeldRO');return ('a'*64)}
function Write-OneoffPublic($Value,[string]$Name){if($script:receipts.ContainsKey($Name)){throw 'STUB_CONSUMED'};$script:receipts[$Name]=$Value}
function Write-IncidentPrivate($Value,[string]$Name){$script:calls.Add('PrivateWrite');$script:inputs[$Name]=$Value}
function Read-IncidentPrivate([string]$Name){$script:calls.Add('PrivateRead');return $script:inputs[$Name]}
function Invoke-OneoffWire($Wire){$script:calls.Add('Wire_'+$Wire.action);if($Wire.action -ceq 'NextDay'){$p=@{};foreach($k in $Wire.plan.Keys){$p[$k]=$Wire.plan[$k]};$p.day=$Wire.day;$p.requestKey='phase10-'+$p.operationKey+'-'+$Wire.day;return ($p|ConvertTo-Json -Depth 30 -Compress)};return '{"validated":true,"runtimeFiles":495}'}
function Invoke-OneoffSql([string]$Action,$Plan,$Before=$null){$script:calls.Add($Action);if($script:failAt -ceq $Action){throw 'STUB_SAFE_UNKNOWN'};return @{connection='b'*32;policy='c'*32;ownRuns=0;newCatalog='d'*32;newPolicyHash='e'*32;login=$false;enabled=$false;backends=0;leases=0;newGrants=0;heldGrants=0}}
function Invoke-OneoffNode([string[]]$Arguments,[string]$InputText='',[int]$Timeout=60000,[bool]$Executor=$false,[bool]$Native=$false){
 if(-not $Executor){throw 'STUB_UNEXPECTED_PROCESS'};$script:calls.Add('Child');$p=$InputText|ConvertFrom-Json -AsHashtable -Depth 30;$script:dayResults+=,$p
 $status=if($script:failAt -ceq ('Child_'+$p.day)){'FAIL'}else{'PASS'};return @{exitCode=$(if($status -ceq 'PASS'){0}else{1});text=(@{kind='CAFE08_ONEOFF_CHILD_RESULT';status=$status;operationKey=$p.operationKey;day=$p.day;requestKey=$p.requestKey;rawValuesReturned=0;providerTokenPosts=0;cumulativeRequests=$(if($p.day -ceq '2026-10-16'){582}else{1128});cumulativeResponseBytes=$(if($p.day -ceq '2026-10-16'){1046538}else{2007628})}|ConvertTo-Json -Compress)}
}
function Reset-Stubs{
 $script:calls.Clear();$script:receipts=@{};$script:failAt='';$script:dayResults=@();$p=@{kind='CAFE08_REMOTE_EXPLICIT_DAY_PLAN';operationKey='20261021-cafe08-manual-a';day='2026-10-16';requestKey='phase10-20261021-cafe08-manual-a-2026-10-16';preparedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usedRequests=0;usedBytes=0;armedPolicyMd5='e'*32}
 $script:inputs=@{'cafe08-oneoff-20261021-prepared-a'=@{kind='CAFE08_ONEOFF_PREPARED';operationKey=$p.operationKey;plan=$p;before=@{};variablesHash='a'*64;pins=$script:realPins};'cafe08-oneoff-20261021-input-a'=$p}
}
function Run-Stub([string]$Mode,[string]$Label){return Invoke-OneoffAction $Mode 'cafe08-oneoff-20261021-input-a' 'cafe08-oneoff-20261021-prepared-a' ($script:realPins['phase10-cafe-oneoff-controller-20261021.ps1']) ($script:realPins['phase10-cafe-oneoff-controller-20261021.mjs']) ($script:realPins['phase10-cafe-oneoff-executor-20261021.mjs']) $Label}
Case 'preflight wrong pin reaches no private read or mutation' {Reset-Stubs;$r=Invoke-OneoffAction Execute '' 'cafe08-oneoff-20261021-prepared-a' ('0'*64) $script:realPins['phase10-cafe-oneoff-controller-20261021.mjs'] $script:realPins['phase10-cafe-oneoff-executor-20261021.mjs'] 'wrongpin';Check ($r.status -ceq 'FAIL');Check ($script:calls.Count -eq 0)}
Case 'Prepare seals only RO before-image and makes no mutation' {Reset-Stubs;$r=Run-Stub Prepare 'prepare';Check ($r.status -ceq 'PASS');Check ($script:calls -ccontains 'Snapshot');Check ($script:calls -cnotcontains 'Migrate');Check ($script:calls -cnotcontains 'Arm');Check ($script:calls -cnotcontains 'Child')}
Case 'unknown migration outcome is never replayed and containment still runs' {Reset-Stubs;$script:failAt='Migrate';$r=Run-Stub Execute 'unknown-migration';Check ($r.status -ceq 'FAIL');Check (@($script:calls|Where-Object {$_ -ceq 'Migrate'}).Count -eq 1);Check ($script:calls -ccontains 'Contain');Check ($script:calls -cnotcontains 'Child')}
Case 'unknown Arm is contained without claiming cleanup policy verification' {Reset-Stubs;$script:failAt='Arm';$r=Run-Stub Execute 'unknown-arm';Check ($r.status -ceq 'FAIL');Check ($script:calls -ccontains 'Contain');Check ($script:calls -cnotcontains 'Child');Check (-not $r.cleanup.policiesRemoved)}
Case 'first day failure prevents second day and always contains then cleans' {Reset-Stubs;$script:failAt='Child_2026-10-16';$r=Run-Stub Execute 'first-day-fail';Check ($r.status -ceq 'FAIL');Check ($script:dayResults.Count -eq 1);Check ($script:calls.IndexOf('Contain') -lt $script:calls.IndexOf('Cleanup'))}
Case 'two explicit days pass cumulative day16 budgets to day17 and return held' {Reset-Stubs;$r=Run-Stub Execute 'two-days';Check ($r.status -ceq 'PASS');Check ($script:dayResults.Count -eq 2);Check ($script:dayResults[1].usedRequests -eq 582);Check ($script:dayResults[1].usedBytes -eq 1046538);Check ($r.cleanup.containVerified -and $r.cleanup.policiesRemoved -and $r.cleanup.protectedRowsVerified)}
Case 'cleanup CAS failure preserves committed containment and is not PASS' {Reset-Stubs;$script:failAt='Cleanup';$r=Run-Stub Execute 'cleanup-fail';Check ($r.status -ceq 'FAIL');Check $r.cleanup.containCommitted;Check (-not $r.cleanup.policiesRemoved);Check ($script:calls.IndexOf('Contain') -lt $script:calls.IndexOf('Cleanup'))}
Case 'Inspect uses no child or management mutation path' {Reset-Stubs;$r=Run-Stub Inspect 'inspect';Check ($r.status -ceq 'PASS');foreach($bad in @('Migrate','Arm','Contain','Cleanup','Child')){Check ($script:calls -cnotcontains $bad)}}
Case 'explicit cleanup performs no second provider execution' {Reset-Stubs;$r=Run-Stub Cleanup 'explicit-cleanup';Check ($r.status -ceq 'PASS');Check ($script:calls -ccontains 'Contain');Check ($script:calls -ccontains 'Cleanup');Check ($script:calls -cnotcontains 'Child')}
@{kind='CAFE08_ONEOFF_PS_STUB_TESTS';status='PASS';cases=$count;remoteRequests=0;actualDatabaseStarts=0;actualDpapiReads=0;providerRequests=0}|ConvertTo-Json -Compress
