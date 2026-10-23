param([ValidateSet('Prepare','Apply','Verify')][string]$Mode,
 [ValidatePattern('^20261019-[a-z0-9-]{3,48}$')][string]$OperationKey='20261019-crypto-rotation-a')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$script:IncidentCryptoReceiptRoot=Join-Path $script:IncidentEvidence 'crypto'
function Get-IncidentCryptoNames([string]$Operation){return @{keys=('crypto-keys-'+$Operation);plan=('crypto-plan-'+$Operation);marker=('crypto-verified-'+$Operation);prepared=('prepared-'+$Operation);attempt=('attempt-'+$Operation);verified=('verified-'+$Operation)}}
function Get-IncidentCryptoPins {
 $pins=[ordered]@{};foreach($name in @('incident-crypto-control.ps1','incident-crypto-child.mjs','incident-crypto-transform.mjs')){
  $path=Join-Path $PSScriptRoot $name;$item=Get-Item -LiteralPath $path
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 100000){throw 'CRYPTO_SOURCE'}
  $pins[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
 };return $pins
}
function Write-IncidentCryptoReceipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'CRYPTO_RECEIPT_NAME'}
 [void][IO.Directory]::CreateDirectory($script:IncidentCryptoReceiptRoot)
 $path=Join-Path $script:IncidentCryptoReceiptRoot ($Name+'.json');$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 35))
 $file=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
}
function Invoke-IncidentCryptoOffline($Value){
 $child=$null;$wire=$null;$raw=$null;$discard=$null
 try{
  $wire=$Value|ConvertTo-Json -Depth 45 -Compress
  if([Text.Encoding]::UTF8.GetByteCount($wire) -gt 4194304){throw 'CRYPTO_INPUT_BOUND'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.ArgumentList.Add((Join-Path $PSScriptRoot 'incident-crypto-child.mjs'))
  $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
  $psi.Environment['INCIDENT_CRYPTO_PROTECTED_PARENT']='20261019-ROOT'
  $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync()
  $write=$child.StandardInput.WriteAsync($wire);if(-not $write.Wait(5000)){$child.Kill($true);throw 'CRYPTO_WRITE_TIMEOUT'};$child.StandardInput.Close();$wire=$null
  if(-not $child.WaitForExit(30000)){$child.Kill($true);throw 'CRYPTO_TIMEOUT'}
  $raw=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null
  if($child.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($raw) -gt 12582912){throw 'CRYPTO_OFFLINE_REJECTED'}
  return ($raw|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)
 }catch{throw 'INCIDENT_CRYPTO_OFFLINE_SAFE_REJECTED'}
 finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$wire=$null;$raw=$null;$discard=$null;$Value=$null}
}
function Get-IncidentCryptoSnapshot {
 $cipherSql=(Invoke-IncidentCryptoOffline @{operation='SNAPSHOT_SQL'}).sql.Trim().TrimEnd(';')
 $sql="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='20000';SELECT payload.*,current_database() AS db,current_user AS principal,(SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled_connections,(SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('cafe24_observed_order_revisions','cafe24_observed_day_checkpoints','source_credentials','sync_unit_checkpoints')) AS held_grants FROM ($cipherSql) payload;COMMIT;"
 try{
  $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
  if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].enabled_connections -ne 0 -or $rows[0].held_grants -ne 0){throw 'CRYPTO_SNAPSHOT_TARGET'}
  $row=$rows[0]|ConvertTo-Json -Depth 45 -Compress|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String
  if($row.credentials -isnot [Array] -or $row.credentials.Count -ne 2 -or $row.checkpoints -isnot [Array] -or $row.checkpoints.Count -gt 32){throw 'CRYPTO_SNAPSHOT_SHAPE'}
  return @{credentials=$row.credentials;checkpoints=$row.checkpoints}
 }finally{$sql=$null;$cipherSql=$null;$rows=$null;$row=$null}
}
function Assert-IncidentCryptoInitialLive($Live){
 if($Live.serviceInstance.latestDeployment.id -cne '33677c6c-2142-4938-b7f0-95e96f5de86b' -or $Live.serviceInstance.latestDeployment.status -cnotin @('SLEEPING','SUCCESS') -or $Live.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne '0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1'){throw 'CRYPTO_INITIAL_DEPLOYMENT'}
}
function Assert-IncidentCryptoContained($Snapshot){
 Assert-IncidentContained $Snapshot
 if($Snapshot.runtime_role.login -cne $false -or $Snapshot.runtime_backends -ne 0){throw 'CRYPTO_RUNTIME_NOT_CONTAINED'}
}
function Get-IncidentCryptoInput($Plan,$Keys,$Baseline){
 return @{projectRef='ehnfrrmbkvlsbpvqcvkr';schema='phase08_meta_ads';runtimeRole='phase08_runtime';connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';operationKey=$Plan.operationKey;protectedSnapshotVerified=$true;
  oldKeys=@{credentialV1=$Baseline.variables.DAILY_SYNC_CREDENTIAL_KEY_V1;checkpoint=$Baseline.variables.DAILY_SYNC_CHECKPOINT_KEY_B64};newKeys=$Keys;snapshot=$Plan.beforeCipherSnapshot}
}
function Assert-IncidentCryptoPreserved($Before,$After){
 foreach($table in $Before.table_digests){if($table.table -cin @('source_credentials','sync_unit_checkpoints','run_units','security_audit_events')){continue}
  $same=@($After.table_digests|Where-Object {$_.table -ceq $table.table});if($same.Count -ne 1 -or $same[0].rows -ne $table.rows -or $same[0].md5 -cne $table.md5){throw 'CRYPTO_UNRELATED_TABLE_CHANGED'}
 }
 foreach($field in @('job_definitions_md5','other_jobs_md5','original152_md5','call_md5','runtime_grants_md5')){if($Before.$field -cne $After.$field){throw 'CRYPTO_UNRELATED_CONTROL_CHANGED'}}
}
function Read-IncidentCryptoEnvironmentUpdate([Alias('OperationKey')][string]$Operation='20261019-crypto-rotation-a'){
 if($Operation -cnotmatch '^20261019-[a-z0-9-]{3,48}$'){throw 'CRYPTO_OPERATION'}
 $names=Get-IncidentCryptoNames $Operation;$marker=Read-IncidentPrivate $names.marker;$plan=Read-IncidentPrivate $names.plan
 try{
  if($plan.operationKey -cne $Operation -or $marker.operationKey -cne $Operation -or $marker.verified -cne $true -or
    $marker.environmentHash -cne (Get-IncidentHash $plan.prepared.environmentUpdate) -or $marker.sourcePinsHash -cne (Get-IncidentHash $plan.sourcePins)){throw 'CRYPTO_VERIFIED_REQUIRED'}
  return $plan.prepared.environmentUpdate
 }finally{$plan=$null;$marker=$null}
}
function Invoke-IncidentCryptoAction([string]$Action,[string]$Operation){
 $stage='START';$submitted=$false;$baseline=$null;$keys=$null;$plan=$null;$inputValue=$null;$live=$null;$gate=$null;$before=$null;$after=$null;$prepared=$null;$verification=$null
 try{
  if($Action -cnotin @('Prepare','Apply','Verify') -or $Operation -cnotmatch '^20261019-[a-z0-9-]{3,48}$'){throw 'CRYPTO_ACTION'}
  $names=Get-IncidentCryptoNames $Operation;$pins=Get-IncidentCryptoPins
  $attemptPath=Join-Path $script:IncidentCryptoReceiptRoot ($names.attempt+'.json')
  if($Action -ceq 'Apply' -and (Test-Path -LiteralPath $attemptPath)){throw 'CRYPTO_ATTEMPT_ALREADY_CONSUMED'}
  if($Action -ceq 'Verify' -and -not (Test-Path -LiteralPath $attemptPath)){throw 'CRYPTO_ATTEMPT_REQUIRED'}
  $stage='CONTAINMENT';$live=Get-IncidentState;$gate=Get-IncidentSnapshot
  if($Action -cne 'Verify'){Assert-IncidentCryptoInitialLive $live;Assert-IncidentCryptoContained $gate}else{Assert-IncidentContained $gate}
  $baseline=Read-IncidentPrivate 'compromised-baseline'
  if($baseline.eligibleAsSecretRollback -cne $false){throw 'CRYPTO_BASELINE_CLASSIFICATION'}
  if($Action -ceq 'Prepare'){
   $stage='NEW_KEYS';$keys=Invoke-IncidentCryptoOffline @{operation='GENERATE'};Write-IncidentPrivate $keys $names.keys
   $protectedKeys=Read-IncidentPrivate $names.keys;if((Get-IncidentHash $protectedKeys) -cne (Get-IncidentHash $keys)){throw 'CRYPTO_PROTECTED_KEYS_ROUNDTRIP'};$protectedKeys=$null
   $stage='READONLY_CIPHER_SNAPSHOT';$before=Get-IncidentCryptoSnapshot
   $plan=@{operationKey=$Operation;beforeCipherSnapshot=$before;sourcePins=$pins;variableHash=(Get-IncidentVariableHash $live.variables);eligibleAsSecretRollback=$false}
   $inputValue=Get-IncidentCryptoInput $plan $keys $baseline
   $stage='PREPARE';$prepared=Invoke-IncidentCryptoOffline @{operation='PREPARE';input=$inputValue}
   if($prepared.safeSummary.preparedOnly -cne $true -or $prepared.safeSummary.mutationExecuted -cne $false){throw 'CRYPTO_PREPARE_CLASSIFICATION'}
   $plan.prepared=$prepared
   if([Text.Encoding]::UTF8.GetByteCount(($plan|ConvertTo-Json -Depth 45 -Compress)) -gt 3145728){throw 'CRYPTO_PLAN_PROTECTED_BOUND'}
   $stage='PROTECT_PLAN';Write-IncidentPrivate $plan $names.plan
   Write-IncidentCryptoReceipt @{kind='INCIDENT_CRYPTO_PREPARED';safeSummary=$prepared.safeSummary;sourcePins=$pins;rawValuesReturned=0;remoteMutations=0} $names.prepared
   return @{kind='INCIDENT_CRYPTO_PREPARED';preparedOnly=$true;mutationExecuted=$false;credentialRows=2;checkpointRows=$before.checkpoints.Count;rawValuesReturned=0}
  }
  $stage='PROTECTED_PLAN';$plan=Read-IncidentPrivate $names.plan;$keys=Read-IncidentPrivate $names.keys
  if($plan.operationKey -cne $Operation -or (Get-IncidentHash $pins) -cne (Get-IncidentHash $plan.sourcePins)){throw 'CRYPTO_PLAN_BINDING'}
  $inputValue=Get-IncidentCryptoInput $plan $keys $baseline
  if($Action -ceq 'Apply'){
   $stage='PROTECTED_KEYS_AND_PLAN_BINDING';$revalidated=Invoke-IncidentCryptoOffline @{operation='PREPARE';input=$inputValue}
   if((Get-IncidentHash $revalidated.environmentUpdate) -cne (Get-IncidentHash $plan.prepared.environmentUpdate)){throw 'CRYPTO_PROTECTED_KEYS_CHANGED'};$revalidated=$null
   if((Get-IncidentVariableHash $live.variables) -cne $plan.variableHash){throw 'CRYPTO_VARIABLES_CHANGED'}
   $before=Get-IncidentSnapshot;Assert-IncidentCryptoContained $before
   $stage='ATTEMPT_RECEIPT';Write-IncidentCryptoReceipt @{kind='INCIDENT_CRYPTO_APPLY_ATTEMPT';credentialRows=2;checkpointRows=$plan.beforeCipherSnapshot.checkpoints.Count;automaticRetryAllowed=$false;providerRequests=0} $names.attempt
   $stage='EXACT_CAS_ONCE';$submitted=$true;$reply=@(Invoke-Phase08Management -Action Query -Query $plan.prepared.mutationSql)
   if($reply.Count -ne 1 -or $reply[0].credentialRowsReencrypted -ne 2 -or $reply[0].checkpointRowsReencrypted -ne $plan.beforeCipherSnapshot.checkpoints.Count -or $reply[0].businessRowsPreserved -cne $true -or $reply[0].observationBaselinePreserved -cne $true -or $reply[0].providerCredentialsRevoked -cne $false){throw 'CRYPTO_MUTATION_OUTCOME_INSPECT'}
  }
  $stage='READONLY_NEW_CIPHER_SNAPSHOT';$after=Get-IncidentCryptoSnapshot
  $stage='OFFLINE_NEW_POSITIVE_OLD_NEGATIVE';$verification=Invoke-IncidentCryptoOffline @{operation='VERIFY';input=$inputValue;after=$after}
  if($verification.verified -cne $true -or $verification.providerCredentialsRevoked -cne $false){throw 'CRYPTO_VERIFICATION_REJECTED'}
  $afterGate=Get-IncidentSnapshot;Assert-IncidentContained $afterGate
  if($Action -ceq 'Apply'){Assert-IncidentCryptoContained $afterGate;Assert-IncidentCryptoPreserved $before $afterGate}
  $environmentApplied=$true;foreach($name in $plan.prepared.environmentUpdate.set.Keys){if(-not $live.variables.Contains($name) -or $live.variables[$name] -cne $plan.prepared.environmentUpdate.set[$name]){$environmentApplied=$false}}
  foreach($name in $plan.prepared.environmentUpdate.remove){if($live.variables.Contains($name)){$environmentApplied=$false}}
  $out=@{kind='INCIDENT_CRYPTO_VERIFIED';verification=$verification;activeEnvironmentVerified=$environmentApplied;observationBaselineRemainsQuarantined=$true;providerCredentialsRevoked=$false;rawValuesReturned=0;productionChanges=0}
  $stage='PROTECTED_VERIFIED_MARKER';$markerPath=Join-Path $script:IncidentPrivate ($names.marker+'.dpapi')
  if(Test-Path -LiteralPath $markerPath){$marker=Read-IncidentPrivate $names.marker;if($marker.operationKey -cne $Operation -or $marker.verified -cne $true -or $marker.environmentHash -cne (Get-IncidentHash $plan.prepared.environmentUpdate) -or $marker.sourcePinsHash -cne (Get-IncidentHash $plan.sourcePins)){throw 'CRYPTO_MARKER_BINDING'}}
  else{Write-IncidentPrivate @{operationKey=$Operation;verified=$true;environmentHash=(Get-IncidentHash $plan.prepared.environmentUpdate);sourcePinsHash=(Get-IncidentHash $plan.sourcePins);eligibleAsSecretRollback=$false} $names.marker}
  $stage='VERIFIED_RECEIPT';$verifiedPath=Join-Path $script:IncidentCryptoReceiptRoot ($names.verified+'.json')
  if($Action -ceq 'Apply' -or -not (Test-Path -LiteralPath $verifiedPath)){
   if($Action -ceq 'Verify' -and -not (Test-Path -LiteralPath (Join-Path $script:IncidentCryptoReceiptRoot ($names.attempt+'.json')))){throw 'CRYPTO_ATTEMPT_REQUIRED'}
   Write-IncidentCryptoReceipt $out $names.verified
  }
  return $out
 }catch{return @{kind='INCIDENT_CRYPTO_SAFE_REJECTION';stage=$stage;mutationSubmitted=$submitted;outcomeUncertain=$submitted;inspectBeforeRetry=$true;automaticRetryAllowed=$false;rawErrorSuppressed=$true}}
 finally{$baseline=$null;$keys=$null;$plan=$null;$inputValue=$null;$live=$null;$gate=$null;$before=$null;$after=$null;$prepared=$null;$verification=$null;$reply=$null;$afterGate=$null;$revalidated=$null;$marker=$null;$protectedKeys=$null}
}
if($MyInvocation.InvocationName -ne '.'){
 if(-not $Mode){@{kind='INCIDENT_CRYPTO_MODE_REQUIRED';rawValuesReturned=0}|ConvertTo-Json;exit 1}
 $safe=Invoke-IncidentCryptoAction $Mode $OperationKey;$safe|ConvertTo-Json -Depth 35
 if($safe.kind -ceq 'INCIDENT_CRYPTO_SAFE_REJECTION'){exit 1}
}
