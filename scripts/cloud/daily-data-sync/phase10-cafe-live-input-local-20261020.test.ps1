$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-live-input-local-20261020.ps1"
$script:Reads=0;$script:Native=0;$script:Roots=0;$script:Privacy=0;$script:Bad='';$script:Hash=('a'*64)
function Assert-Test($Value,[string]$Name){if(-not $Value){throw ('LOCAL_TEST_'+$Name)}}
function Get-FileHash{param([string]$Algorithm,[string]$LiteralPath,[string]$Path) return @{Hash=$script:Hash}}
function New-DayProof([string]$Day){return [ordered]@{kind='CAFE08_FULL_CURRENT_DAY_READ';day=$Day;status='COMPLETE_CURRENT_TWO_PASS_READ';completeTwoPass=$true;privatePayloadSealedAndReadbackVerified=$true;eligibleSecretRollback=$false;privateNormalizedReference=('cafe08-normalized-day-20261020-cafe08-full-read-b-'+$Day);lineCount=2;uniqueLineCount=2;orderCount=1;pageCount=3;fetchedAt='2026-10-20T05:00:00.000Z';normalizedPayloadSha256=('a'*64);normalizedPayloadBytes=500}}
function Read-CafeLocalPublic([string]$Name){
 if($Name -ceq 'result'){return @{kind='CAFE08_FULL_READ_RESULT';status='TWO_COMPLETED_DAYS_CURRENT_READ_PASS';dayResults=@((New-DayProof '2026-10-16'),(New-DayProof '2026-10-17'));whole68Unchanged=($script:Bad -cne 'full-preservation');holdsAndEnvironmentUnchanged=$true}}
 if($Name -ceq 'prepared'){return @{sourcePins=@{candidateV5AppSourceFileCount=$(if($script:Bad -ceq 'source-count'){284}else{285});candidateV5AppSourceClosureSha256=$script:CafeLocalClosure;'phase10-synthetic.ps1'=('a'*64)}}}
 if($Name.StartsWith('day-')){$day=$Name.Substring(4);$v=New-DayProof $day;if($script:Bad -ceq 'day-incomplete'){$v.completeTwoPass=$false};if($script:Bad -ceq 'private-ref'){$v.privateNormalizedReference='other'};if($script:Bad -ceq 'line-count'){$v.uniqueLineCount=3};return $v}
 if($Name.StartsWith('preserved-')){return @{kind='CAFE08_FULL_DAY_PRESERVATION';day=$Name.Substring(10);whole68Unchanged=($script:Bad -cne 'day-preservation');holdsAndEnvironmentUnchanged=$true}}
 throw 'OFFLINE_PUBLIC_SCOPE'
}
function Read-CafeLocalPrivate([string]$Name){$script:Reads++;return @{synthetic=$true}}
function New-CafeLocalPrivateRoot([string]$Path){$script:Roots++;if($Path -cnotmatch '/cafe-live-local-[a-f0-9-]{36}$'){throw 'OFFLINE_PATH_SCOPE'}}
function Invoke-CafeLocalChild($InputValue,[string]$PrivateRoot,[string]$PublicRoot){$script:Native++;if($script:Bad -ceq 'child-unknown'){throw 'SYNTHETIC_PRIVATE_CANARY'};return @{status='PASS';days=@(@{},@{});postgresStopExit=0;rawValuesReturned=0}}
function Get-CafeLocalNativePrivacy([string]$Root){if($script:Bad -ceq 'acl'){throw 'SYNTHETIC_ACL'};return @{privateNativeRoot=$Root;otherAllowedPrincipals=0}}
function Write-CafeLocalPrivacy($Value,[string]$PublicRoot){$script:Privacy++}
function Reset-Test{$script:Reads=0;$script:Native=0;$script:Roots=0;$script:Privacy=0;$script:Bad='';$script:Hash=('a'*64)}
$cases=0
try{
 $nativeRoot='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-live-local-00000000-0000-4000-8000-000000000001';$pidLines=@('1',($nativeRoot+'/pg-data'),'1','55436','','127.0.0.1');Assert-CafeLocalPostmasterIdentity $pidLines $nativeRoot;$cases++
 foreach($index in @(1,3,5)){$badLines=@($pidLines);$badLines[$index]='other';$rejected=$false;try{Assert-CafeLocalPostmasterIdentity $badLines $nativeRoot}catch{$rejected=$true};Assert-Test $rejected 'OWNED_PID_REJECT_WRONG_DIRECTORY_PORT_OR_LISTENER';$cases++}
 Assert-Test ((Get-CafeLocalCanonicalJson ([ordered]@{a='x';b=@(1,2)})) -ceq (Get-CafeLocalCanonicalJson ([ordered]@{b=@(1,2);a='x'}))) 'KEY_ORDER_CANONICAL';$cases++
 Assert-Test ((Get-CafeLocalCanonicalJson @{a=1}) -cne (Get-CafeLocalCanonicalJson @{a='1'})) 'VALUE_TYPE_REMAINS_EXACT';$cases++
 Reset-Test;$v=Get-CafeLocalInput ('a'*64);Assert-Test ($v.days.Count -eq 2 -and $script:Reads -eq 2 -and $script:Native -eq 0) 'PUBLIC_PROOF_THEN_TWO_REFS';$cases++
 foreach($caseFlag in @('full-preservation','source-count','day-incomplete','private-ref','line-count','day-preservation')){Reset-Test;$script:Bad=$caseFlag;$rejected=$false;try{$null=Get-CafeLocalInput ('a'*64)}catch{$rejected=$true};Assert-Test ($rejected -and $script:Native -eq 0 -and $script:Reads -eq 0) 'BAD_PROOF_BEFORE_PRIVATE';$cases++}
 Reset-Test;$rejected=$false;try{$null=Get-CafeLocalInput ('b'*64)}catch{$rejected=$true};Assert-Test ($rejected -and $script:Reads -eq 0) 'FULL_SHA_REQUIRED';$cases++
 Reset-Test;$r=Invoke-CafeLocalAction $false ('a'*64) ('a'*64) ('a'*64);Assert-Test ($r.status -ceq 'FAIL' -and $script:Reads -eq 0 -and $script:Roots -eq 0 -and $script:Native -eq 0) 'EXPLICIT_EXECUTE_REQUIRED';$cases++
 Reset-Test;$r=Invoke-CafeLocalAction $true ('b'*64) ('a'*64) ('a'*64);Assert-Test ($r.status -ceq 'FAIL' -and $script:Reads -eq 0) 'CONTROLLER_PIN';$cases++
 Reset-Test;$r=Invoke-CafeLocalAction $true ('a'*64) ('a'*64) ('a'*64);Assert-Test ($r.status -ceq 'PASS' -and $script:Reads -eq 2 -and $script:Native -eq 1 -and $script:Roots -eq 1 -and $script:Privacy -eq 1 -and $r.observationHistoryRebaselineProven -ceq $false) 'STUB_LOCAL_FLOW';$cases++
 Reset-Test;$script:Bad='child-unknown';$r=Invoke-CafeLocalAction $true ('a'*64) ('a'*64) ('a'*64);Assert-Test ($r.status -ceq 'FAIL' -and $r.stage -ceq 'LOCAL_NATIVE_WRITER' -and $r.automaticRetry -ceq $false -and $script:Privacy -eq 0 -and -not ($r|ConvertTo-Json).Contains('SYNTHETIC_PRIVATE_CANARY')) 'CHILD_UNKNOWN_NO_PASS';$cases++
 Reset-Test;$script:Bad='acl';$r=Invoke-CafeLocalAction $true ('a'*64) ('a'*64) ('a'*64);Assert-Test ($r.status -ceq 'FAIL' -and $r.stage -ceq 'PRIVATE_RETENTION_ACL_PROOF' -and $script:Privacy -eq 0) 'ACL_FAILURE_NO_PASS';$cases++
 @{kind='CAFE08_LOCAL_INPUT_CONTROLLER_STUB_PASS';cases=$cases;actualNativeStarts=0;actualDpapiReads=0;actualProviderRequests=0;actualSql=0}|ConvertTo-Json -Compress
}catch{@{kind='CAFE08_LOCAL_INPUT_CONTROLLER_STUB_FAIL';cases=$cases;safeCode=$(if($_.Exception.Message -cmatch '^LOCAL_TEST_[A-Z0-9_]+$'){$_.Exception.Message}else{'OFFLINE_TEST_REJECTED'});rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
