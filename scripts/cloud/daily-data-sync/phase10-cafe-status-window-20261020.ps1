param([ValidateSet('Prepare','Execute')][string]$Mode='Prepare')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$statusRequestedMode=$Mode
. "$PSScriptRoot/phase10-cafe-field-sample-20261020.ps1"
$Mode=$statusRequestedMode
$script:CafeStatusOperation='20261020-cafe08-status-window-a'
$script:CafeStatusRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-status-window-20261020-v1'
function Write-CafeStatusReceipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'OUTPUT_NAME'}
 [void][IO.Directory]::CreateDirectory($script:CafeStatusRoot);$stream=[IO.File]::Open((Join-Path $script:CafeStatusRoot ($Name+'.json')),[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-CafeStatusPins{
 $out=Get-CafeFieldPins
 foreach($name in @('phase10-cafe-status-window-20261020.ps1','phase10-cafe-status-window-child-20261020.mjs','phase10-cafe-status-window-20261020.mjs')){$out[$name]=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()}
 return $out
}
function Invoke-CafeStatusChild($Value,[bool]$Execute){
 $child=$null;$wire=$null;$text=$null;$discard=$null
 try{
  $wire=$Value|ConvertTo-Json -Depth 45 -Compress;if([Text.Encoding]::UTF8.GetByteCount($wire)>4194304){throw 'INPUT_BOUND'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');foreach($arg in @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-status-window-child-20261020.mjs'))){$psi.ArgumentList.Add($arg)};$psi.WorkingDirectory=(Resolve-Path "$PSScriptRoot/../../..").Path;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$psi.Environment['CAFE08_STATUS_PROTECTED_PARENT']='20261020-ROOT';$psi.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json'
  $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
  $timeout=if($Execute){630000}else{30000};if(-not $child.WaitForExit($timeout)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
  $text=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null;if($child.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($text)>32768){throw 'CHILD_REJECTED'}
  return ($text|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)
 }finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$wire=$null;$text=$null;$discard=$null;$Value=$null}
}
function Invoke-CafeStatusAction([string]$Action){
 $stage='START';$submitted=$false;$live=$null;$before=$null;$cipher=$null;$checkpoint=$null;$inputValue=$null;$plan=$null;$safe=$null
 try{
  $pins=Get-CafeStatusPins;$planName='cafe08-status-window-plan-'+$script:CafeStatusOperation
  if($Action -ceq 'Execute' -and (Test-Path -LiteralPath (Join-Path $script:CafeStatusRoot 'attempt.json'))){throw 'ATTEMPT_CONSUMED_NO_RETRY'}
  $stage='HELD_BEFORE_READ';$live=Get-IncidentState;$before=Get-IncidentSnapshot;Assert-CafeRecoveryHold $before $live;Assert-CafeRecoveryDeploymentStopped
  $stage='NEW_PAIR_AND_ARCHIVE_READONLY';$cipher=Get-CafeRecoveryCipherSnapshot;$checkpoint=Get-CafeFieldCheckpoint;$inputValue=@{operationKey=$script:CafeStatusOperation;input=Get-CafeFieldProtectedInput $live $cipher $checkpoint}
  $stage='OFFLINE_PREFLIGHT';$preflight=Invoke-CafeStatusChild @{action='PREPARE';input=$inputValue} $false
  if($preflight.kind -cne 'CAFE08_STATUS_WINDOW_PREFLIGHT' -or $preflight.summary.maximumGets -ne 22 -or $preflight.summary.providerRequests -ne 0 -or $preflight.summary.fullDayComplete -cne $false -or $preflight.summary.checkpointResumed -cne $false){throw 'PREFLIGHT_SHAPE'}
  if($Action -ceq 'Prepare'){
   $plan=@{operationKey=$script:CafeStatusOperation;eligibleSecretRollback=$false;sourcePins=$pins;variableHash=Get-IncidentVariableHash $live.variables;tablesHash=Get-CafeRecoveryTablesHash $before.table_digests;controlsHash=Get-CafeRecoveryControlsHash $before;checkpointCipherSha256=$preflight.checkpointCipherSha256;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o')}
   Write-IncidentPrivate $plan $planName
   $safe=@{kind='CAFE08_STATUS_WINDOW_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');summary=$preflight.summary;sourcePins=$pins;newPairKeyVersion=2;newPairRevision=9;whole68BeforeImageBound=$true;providerRequests=0;databaseWrites=0;rawValuesReturned=0};Write-CafeStatusReceipt $safe 'prepared';return $safe
  }
  $plan=Read-IncidentPrivate $planName
  if($plan.operationKey -cne $script:CafeStatusOperation -or $plan.eligibleSecretRollback -cne $false -or [DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow -or (Get-IncidentHash $pins) -cne (Get-IncidentHash $plan.sourcePins) -or (Get-IncidentVariableHash $live.variables) -cne $plan.variableHash -or (Get-CafeRecoveryTablesHash $before.table_digests) -cne $plan.tablesHash -or (Get-CafeRecoveryControlsHash $before) -cne $plan.controlsHash -or $preflight.checkpointCipherSha256 -cne $plan.checkpointCipherSha256){throw 'PLAN_CAS'}
  $stage='CREATE_NEW_GET_ATTEMPT';Write-CafeStatusReceipt @{kind='CAFE08_STATUS_WINDOW_GET_ATTEMPT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');maximumGets=22;maximumItemGets=20;automaticRetryAllowed=$false;automaticRefreshAllowed=$false;databaseWrites=0;rawValuesReturned=0} 'attempt'
  $stage='BOUNDED_CURRENT_GET_SAMPLE';$submitted=$true;$safe=Invoke-CafeStatusChild @{action='EXECUTE';expectedCheckpointSha256=$plan.checkpointCipherSha256;input=$inputValue} $true
  if($safe.kind -cne 'CAFE08_CURRENT_STATUS_WINDOW' -or $safe.day -cne '2026-10-16' -or $safe.targetPositions.Count -ne 2 -or $safe.targetPositions[0] -ne 21 -or $safe.targetPositions[1] -ne 40 -or $safe.providerRequests -lt 1 -or $safe.providerRequests -gt 22 -or $safe.itemRequests -gt 20 -or $safe.rawValuesReturned -ne 0 -or $safe.databaseWrites -ne 0 -or $safe.fullDayComplete -cne $false -or $safe.originalFailureReproduced -cne $false -or $safe.checkpointResumed -cne $false -or $safe.originalFailureCauseConfirmed -cne $false -or $safe.approvalListChanged -cne $false -or $safe.automaticRetry -cne $false -or $safe.automaticRefresh -cne $false){throw 'PUBLIC_RESULT_SHAPE'}
  $stage='WHOLE68_AFTER_READ';$after=Get-IncidentSnapshot;$afterLive=Get-IncidentState;Assert-CafeRecoveryHold $after $afterLive;Assert-CafeRecoveryDeploymentStopped
  if((Get-CafeRecoveryTablesHash $after.table_digests) -cne (Get-CafeRecoveryTablesHash $before.table_digests) -or (Get-CafeRecoveryControlsHash $after) -cne (Get-CafeRecoveryControlsHash $before) -or (Get-IncidentVariableHash $afterLive.variables) -cne (Get-IncidentVariableHash $live.variables)){throw 'AFTER_PRESERVATION'}
  $safe.whole68Unchanged=$true;$safe.holdsAndEnvironmentUnchanged=$true;Write-CafeStatusReceipt $safe 'result';return $safe
 }catch{
  $safe=@{kind='CAFE08_STATUS_WINDOW_SAFE_FAILURE';mode=$Action;stage=$stage;requestsMayHaveStarted=$submitted;automaticRetryAllowed=$false;automaticRefreshAllowed=$false;rawErrorSuppressed=$true;rawValuesReturned=0};try{Write-CafeStatusReceipt $safe ('failure-'+$Action.ToLowerInvariant()+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddhhmmssfff'))}catch{};return $safe
 }finally{$live=$null;$before=$null;$cipher=$null;$checkpoint=$null;$inputValue=$null;$plan=$null;$safe=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$public=Invoke-CafeStatusAction $Mode;$public|ConvertTo-Json -Depth 20 -Compress
if($public.kind -ceq 'CAFE08_STATUS_WINDOW_SAFE_FAILURE'){exit 1}
