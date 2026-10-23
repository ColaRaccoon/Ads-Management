param([ValidateSet('Prepare','Execute')][string]$Mode='Prepare')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$fullRequestedMode=$Mode
. "$PSScriptRoot/phase10-cafe-field-sample-20261020.ps1"
$Mode=$fullRequestedMode
$script:CafeFullOperation='20261020-cafe08-full-read-a'
$script:CafeFullRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-full-read-20261020-v1'
function Write-CafeFullReceipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'OUTPUT_NAME'}
 [void][IO.Directory]::CreateDirectory($script:CafeFullRoot);$stream=[IO.File]::Open((Join-Path $script:CafeFullRoot ($Name+'.json')),[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-CafeFullPins{
 $out=Get-CafeFieldPins
 foreach($name in @('phase10-cafe-full-read-20261020.ps1','phase10-cafe-full-read-child-20261020.mjs','phase10-cafe-full-read-20261020.mjs')){$out[$name]=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()}
 return $out
}
function Invoke-CafeFullChild($Value,[bool]$Execute){
 $child=$null;$wire=$null;$text=$null;$discard=$null
 try{
  $wire=$Value|ConvertTo-Json -Depth 45 -Compress;if([Text.Encoding]::UTF8.GetByteCount($wire)>4194304){throw 'INPUT_BOUND'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');foreach($arg in @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-full-read-child-20261020.mjs'))){$psi.ArgumentList.Add($arg)};$psi.WorkingDirectory=(Resolve-Path "$PSScriptRoot/../../..").Path;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$psi.Environment['CAFE08_FULL_READ_PROTECTED_PARENT']='20261020-ROOT';$psi.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json'
  $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
  $timeout=if($Execute){630000}else{30000};if(-not $child.WaitForExit($timeout)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
  $text=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null;if($child.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($text)>32768){throw 'CHILD_REJECTED'}
  return ($text|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)
 }finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$wire=$null;$text=$null;$discard=$null;$Value=$null}
}
function Assert-CafeFullUnchanged($Before,$Live){
 $current=Get-IncidentSnapshot;$currentLive=Get-IncidentState;Assert-CafeRecoveryHold $current $currentLive;Assert-CafeRecoveryDeploymentStopped
 if((Get-CafeRecoveryTablesHash $current.table_digests) -cne (Get-CafeRecoveryTablesHash $Before.table_digests) -or (Get-CafeRecoveryControlsHash $current) -cne (Get-CafeRecoveryControlsHash $Before) -or (Get-IncidentVariableHash $currentLive.variables) -cne (Get-IncidentVariableHash $Live.variables)){throw 'PRESERVATION'}
}
function Invoke-CafeFullAction([string]$Action){
 $stage='START';$submitted=$false;$live=$null;$before=$null;$cipher=$null;$checkpoint=$null;$inputValue=$null;$plan=$null;$safe=$null;$days=[Collections.Generic.List[object]]::new();$usedRequests=0;$usedBytes=0
 try{
  $pins=Get-CafeFullPins;$planName='cafe08-full-read-plan-'+$script:CafeFullOperation
  if($Action -ceq 'Execute' -and (Test-Path -LiteralPath (Join-Path $script:CafeFullRoot 'attempt.json'))){throw 'ATTEMPT_CONSUMED_NO_RETRY'}
  $stage='HELD_BEFORE_READ';$live=Get-IncidentState;$before=Get-IncidentSnapshot;Assert-CafeRecoveryHold $before $live;Assert-CafeRecoveryDeploymentStopped
  $stage='NEW_PAIR_AND_ARCHIVE_READONLY';$cipher=Get-CafeRecoveryCipherSnapshot;$checkpoint=Get-CafeFieldCheckpoint;$inputValue=@{operationKey=$script:CafeFullOperation;input=Get-CafeFieldProtectedInput $live $cipher $checkpoint}
  $stage='OFFLINE_PREFLIGHT';$preflight=Invoke-CafeFullChild @{action='PREPARE';input=$inputValue} $false
  if($preflight.kind -cne 'CAFE08_FULL_READ_PREFLIGHT' -or $preflight.summary.maximumGets -ne 2050 -or $preflight.summary.maximumTotalBytes -ne 67108864 -or $preflight.summary.providerRequests -ne 0 -or $preflight.summary.databaseWrites -ne 0 -or $preflight.summary.canonicalPublished -cne $false){throw 'PREFLIGHT_SHAPE'}
  if($Action -ceq 'Prepare'){
   $plan=@{operationKey=$script:CafeFullOperation;eligibleSecretRollback=$false;sourcePins=$pins;variableHash=Get-IncidentVariableHash $live.variables;tablesHash=Get-CafeRecoveryTablesHash $before.table_digests;controlsHash=Get-CafeRecoveryControlsHash $before;checkpointCipherSha256=$preflight.checkpointCipherSha256;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o')}
   Write-IncidentPrivate $plan $planName
   $safe=@{kind='CAFE08_FULL_READ_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');summary=$preflight.summary;sourcePins=$pins;newPairKeyVersion=2;newPairRevision=9;whole68BeforeImageBound=$true;providerRequests=0;databaseWrites=0;rawValuesReturned=0};Write-CafeFullReceipt $safe 'prepared';return $safe
  }
  $plan=Read-IncidentPrivate $planName
  if($plan.operationKey -cne $script:CafeFullOperation -or $plan.eligibleSecretRollback -cne $false -or [DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow -or (Get-IncidentHash $pins) -cne (Get-IncidentHash $plan.sourcePins) -or (Get-IncidentVariableHash $live.variables) -cne $plan.variableHash -or (Get-CafeRecoveryTablesHash $before.table_digests) -cne $plan.tablesHash -or (Get-CafeRecoveryControlsHash $before) -cne $plan.controlsHash -or $preflight.checkpointCipherSha256 -cne $plan.checkpointCipherSha256){throw 'PLAN_CAS'}
  $stage='CREATE_NEW_GET_ATTEMPT';Write-CafeFullReceipt @{kind='CAFE08_FULL_READ_GET_ATTEMPT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');unitDays=@('2026-10-16','2026-10-17');maximumGets=2050;maximumTotalBytes=67108864;diagnosticOrderCapPerDay=500;automaticRetryAllowed=$false;automaticRefreshAllowed=$false;databaseWrites=0;rawValuesReturned=0} 'attempt'
  foreach($day in @('2026-10-16','2026-10-17')){
   $stage='FRESH_DAY_HOLD';Assert-CafeFullUnchanged $before $live
   $stage='BOUNDED_CURRENT_DAY_READ';$submitted=$true
   try{
    $dayResult=Invoke-CafeFullChild @{action='EXECUTE_DAY';day=$day;usedRequests=$usedRequests;usedBytes=$usedBytes;expectedCheckpointSha256=$plan.checkpointCipherSha256;input=$inputValue} $true
    if($dayResult.kind -cne 'CAFE08_FULL_CURRENT_DAY_READ' -or $dayResult.day -cne $day -or $dayResult.providerRequests -lt 0 -or $dayResult.providerRequests+$usedRequests -gt 2050 -or $dayResult.responseBytes -lt 0 -or $dayResult.responseBytes+$usedBytes -gt 67108864 -or $dayResult.rawValuesReturned -ne 0 -or $dayResult.databaseWrites -ne 0 -or $dayResult.canonicalPublished -cne $false -or $dayResult.originalFailedRunChanged -cne $false -or $dayResult.checkpointResumed -cne $false -or $dayResult.automaticRetry -cne $false -or $dayResult.automaticRefresh -cne $false -or ($dayResult.completeTwoPass -ceq $true -and ($dayResult.responseBytesKnown -cne $true -or $dayResult.pendingTransfersAtReturn -ne 0 -or $dayResult.status -cne 'COMPLETE_CURRENT_TWO_PASS_READ'))){throw 'PUBLIC_RESULT_SHAPE'}
    $usedRequests+=$dayResult.providerRequests;$usedBytes+=$dayResult.responseBytes
   }catch{$dayResult=@{kind='CAFE08_FULL_DAY_UNKNOWN_SAFE_FAILURE';day=$day;status='CHILD_OR_PROJECTION_REJECTED';completeTwoPass=$false;requestCountKnown=$false;requestsMayHaveStarted=$true;automaticRetry=$false;automaticRefresh=$false;databaseWrites=0;rawValuesReturned=0}}
   # A completed day or safe failure is durable before any further management call.
   $dayResult.preservationPending=$true;Write-CafeFullReceipt $dayResult ('day-'+$day);$days.Add($dayResult)
   $stage='WHOLE68_AFTER_DAY';Assert-CafeFullUnchanged $before $live
   Write-CafeFullReceipt @{kind='CAFE08_FULL_DAY_PRESERVATION';day=$day;whole68Unchanged=$true;holdsAndEnvironmentUnchanged=$true;databaseWrites=0;rawValuesReturned=0} ('preserved-'+$day)
   if($dayResult.completeTwoPass -cne $true){break}
  }
  $countsKnown=@($days|Where-Object {$_.kind -cne 'CAFE08_FULL_CURRENT_DAY_READ'}).Count -eq 0
  $bytesKnown=$countsKnown -and @($days|Where-Object {$_.responseBytesKnown -cne $true}).Count -eq 0
  $safe=@{kind='CAFE08_FULL_READ_RESULT';completedAt=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($days.Count -eq 2 -and @($days|Where-Object completeTwoPass -CNE $true).Count -eq 0){'TWO_COMPLETED_DAYS_CURRENT_READ_PASS'}else{'STOPPED_WITH_PARTIAL_OR_SAFE_FAILURE'});dayResults=@($days.ToArray());providerRequestsKnown=$countsKnown;providerRequests=$(if($countsKnown){$usedRequests}else{$null});responseBytesKnown=$bytesKnown;responseBytes=$(if($bytesKnown){$usedBytes}else{$null});knownProviderRequestsLowerBound=$usedRequests;acceptedResponseBytesLowerBound=$usedBytes;whole68Unchanged=$true;holdsAndEnvironmentUnchanged=$true;canonicalPublished=$false;originalFailedRunsChanged=$false;originalFailureCauseConfirmed=$false;checkpointResumed=$false;observationHoldPreserved=$true;databaseWrites=0;rawValuesReturned=0};Write-CafeFullReceipt $safe 'result';return $safe
 }catch{
  $safe=@{kind='CAFE08_FULL_READ_SAFE_FAILURE';mode=$Action;stage=$stage;requestsMayHaveStarted=$submitted;savedDayResults=$days.Count;automaticRetryAllowed=$false;automaticRefreshAllowed=$false;rawErrorSuppressed=$true;rawValuesReturned=0};try{Write-CafeFullReceipt $safe ('failure-'+$Action.ToLowerInvariant()+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddHHmmssfff'))}catch{};return $safe
 }finally{$live=$null;$before=$null;$cipher=$null;$checkpoint=$null;$inputValue=$null;$plan=$null;$safe=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$public=Invoke-CafeFullAction $Mode;$public|ConvertTo-Json -Depth 20 -Compress
if($public.kind -ceq 'CAFE08_FULL_READ_SAFE_FAILURE'){exit 1}
