param([ValidateSet('Prepare','Execute')][string]$Mode='Prepare')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
# Load definitions only; do not call any recovery POST action.
$fieldRequestedMode=$Mode
. "$PSScriptRoot/phase10-cafe-pair-recovery-20261020.ps1"
$Mode=$fieldRequestedMode
$script:CafeFieldOperation='20261020-cafe08-field-sample-a'
$script:CafeFieldRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-field-sample-20261020-v1'
function Write-CafeFieldReceipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'OUTPUT_NAME'}
 [void][IO.Directory]::CreateDirectory($script:CafeFieldRoot);$stream=[IO.File]::Open((Join-Path $script:CafeFieldRoot ($Name+'.json')),[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-CafeFieldPins{
 $out=[ordered]@{};foreach($name in @('phase10-cafe-field-sample-20261020.ps1','phase10-cafe-field-sample-child-20261020.mjs','phase10-cafe-field-sample-20261020.mjs','phase10-cafe-pair-recovery-20261020.ps1','phase10-cafe-pair-recovery-child-20261020.mjs','phase10-cafe-pair-recovery-20261020.mjs')){$out[$name]=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant()}
 $repo=(Resolve-Path "$PSScriptRoot/../../..").Path;$candidate='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v5'
 $sourceRoot=Join-Path $repo 'apps/api/src';$candidateRoot=Join-Path $candidate 'apps/api/src'
 $files=@(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter '*.ts'|Sort-Object FullName);$fixed=@(Get-ChildItem -LiteralPath $candidateRoot -Recurse -File -Filter '*.ts')
 if($files.Count -lt 100 -or $files.Count -ne $fixed.Count){throw 'APP_SOURCE_CLOSURE'}
 $closure=[Collections.Generic.List[object]]::new();foreach($file in $files){$relative=[IO.Path]::GetRelativePath($repo,$file.FullName).Replace('\','/');$hash=(Get-FileHash -Algorithm SHA256 $file.FullName).Hash.ToLowerInvariant();if($hash -cne (Get-FileHash -Algorithm SHA256 (Join-Path $candidate $relative)).Hash.ToLowerInvariant()){throw 'APP_CANDIDATE_SOURCE_PIN'};$closure.Add([ordered]@{name=$relative;bytes=$file.Length;sha256=$hash})}
 $out['candidateV5AppSourceFileCount']=$files.Count;$out['candidateV5AppSourceClosureSha256']=Get-IncidentHash @($closure);$out['candidateName']='candidate-20261020-v5'
 return $out
}
function Invoke-CafeFieldChild($Value,[bool]$Execute){
 $child=$null;$wire=$null;$text=$null;$discard=$null
 try{
  $wire=$Value|ConvertTo-Json -Depth 45 -Compress;if([Text.Encoding]::UTF8.GetByteCount($wire)>4194304){throw 'INPUT_BOUND'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');foreach($arg in @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-field-sample-child-20261020.mjs'))){$psi.ArgumentList.Add($arg)};$psi.WorkingDirectory=(Resolve-Path "$PSScriptRoot/../../..").Path;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$psi.Environment['CAFE08_FIELD_PROTECTED_PARENT']='20261020-ROOT';$psi.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json'
  $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
  $timeout=if($Execute){630000}else{30000};if(-not $child.WaitForExit($timeout)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
  $text=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null;if($child.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($text)>32768){throw 'CHILD_REJECTED'}
  return ($text|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)
 }finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$wire=$null;$text=$null;$discard=$null;$Value=$null}
}
function Get-CafeFieldCheckpoint{
 $sql=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout=20000;
SELECT current_database() AS db,current_user AS principal,c.run_id AS "runId",r.connection_id AS "connectionId",c.unit_key AS "unitKey",c.revision,c.expires_at AS "expiresAt",replace(encode(c.ciphertext,'base64'),chr(10),'') AS "ciphertextB64",encode(c.iv,'base64') AS "ivB64",encode(c.auth_tag,'base64') AS "authTagB64"
FROM phase08_meta_ads.sync_unit_checkpoints c JOIN phase08_meta_ads.sync_runs r ON r.id=c.run_id JOIN phase08_meta_ads.run_units u ON u.run_id=r.id AND u.unit_key=c.unit_key
WHERE r.id='a4f7bcea-bfa8-4699-b3f0-34e118889710'::uuid AND r.connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND c.unit_key='2026-10-17' AND r.status='ACTION_REQUIRED' AND r.safe_error_code='FIELD_UNSUPPORTED' AND r.rows_published=0 AND u.status='ACTION_REQUIRED' AND u.published_count=0 AND octet_length(c.ciphertext)=126852 LIMIT 2;
ROLLBACK;
'@
 try{$rows=@(Invoke-Phase08Management -Action Query -Query $sql);if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres'){throw 'CHECKPOINT_SCOPE'};return ($rows[0]|ConvertTo-Json -Depth 20 -Compress|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)}finally{$rows=$null;$sql=$null}
}
function Get-CafeFieldProtectedInput($Live,$Snapshot,$Checkpoint){
 $recoveryPlan=$null;$forward=$null;$response=$null
 try{
  $recoveryPlan=Read-IncidentPrivate 'cafe08-recovery-plan-20261020-cafe08-read-recovery-a';$forward=Read-IncidentPrivate 'cafe08-recovery-forward-20261020-cafe08-read-recovery-a';$response=Read-IncidentPrivate 'cafe08-recovery-response-20261020-cafe08-read-recovery-a'
  $evidence=[ordered]@{};foreach($name in $Live.variables.Keys){if($name.StartsWith('DAILY_SYNC_CAFE24_') -and $name -notmatch 'CLIENT_SECRET|KEY|TOKEN'){$evidence[$name]=$Live.variables[$name]}}
  return @{operationKey=$script:CafeFieldOperation;holdsVerified=$true;recoveryVerified=$true;snapshot=$Snapshot;checkpoint=$Checkpoint;checkpointKey=$Live.variables.DAILY_SYNC_CHECKPOINT_KEY_B64;forward=$forward;response=$response;clientId=$Live.variables.DAILY_SYNC_CAFE24_CLIENT_ID;evidence=$evidence;recoveryPlan=@{credentialKeyV2=$Live.variables.DAILY_SYNC_CREDENTIAL_KEY_V2;snapshot=$recoveryPlan.snapshot}}
 }finally{$recoveryPlan=$null;$forward=$null;$response=$null}
}
function Invoke-CafeFieldAction([string]$Action){
 $stage='START';$submitted=$false;$live=$null;$before=$null;$cipher=$null;$checkpoint=$null;$inputValue=$null;$plan=$null;$safe=$null
 try{
  $pins=Get-CafeFieldPins;$planName='cafe08-field-plan-'+$script:CafeFieldOperation
  if($Action -ceq 'Execute' -and (Test-Path -LiteralPath (Join-Path $script:CafeFieldRoot 'attempt.json'))){throw 'ATTEMPT_CONSUMED_NO_RETRY'}
  $stage='HELD_BEFORE_READ';$live=Get-IncidentState;$before=Get-IncidentSnapshot;Assert-CafeRecoveryHold $before $live;Assert-CafeRecoveryDeploymentStopped
  $stage='NEW_PAIR_AND_ARCHIVE_READONLY';$cipher=Get-CafeRecoveryCipherSnapshot;$checkpoint=Get-CafeFieldCheckpoint;$inputValue=Get-CafeFieldProtectedInput $live $cipher $checkpoint
  $stage='OFFLINE_PREFLIGHT';$preflight=Invoke-CafeFieldChild @{action='PREPARE';input=$inputValue} $false
  if($preflight.kind -cne 'CAFE08_FIELD_SAMPLE_PREFLIGHT' -or $preflight.summary.maximumGets -ne 42 -or $preflight.summary.providerRequests -ne 0 -or $preflight.summary.snapshotComplete -cne $false -or $preflight.summary.checkpointResumed -cne $false){throw 'PREFLIGHT_SHAPE'}
  if($Action -ceq 'Prepare'){
   $plan=@{operationKey=$script:CafeFieldOperation;eligibleSecretRollback=$false;sourcePins=$pins;variableHash=Get-IncidentVariableHash $live.variables;tablesHash=Get-CafeRecoveryTablesHash $before.table_digests;controlsHash=Get-CafeRecoveryControlsHash $before;checkpointCipherSha256=$preflight.checkpointCipherSha256;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o')}
   Write-IncidentPrivate $plan $planName
   $safe=@{kind='CAFE08_FIELD_SAMPLE_PREPARED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');summary=$preflight.summary;sourcePins=$pins;newPairKeyVersion=2;newPairRevision=9;whole68BeforeImageBound=$true;providerRequests=0;databaseWrites=0;rawValuesReturned=0};Write-CafeFieldReceipt $safe 'prepared';return $safe
  }
  $plan=Read-IncidentPrivate $planName
  if($plan.operationKey -cne $script:CafeFieldOperation -or $plan.eligibleSecretRollback -cne $false -or [DateTimeOffset]::Parse($plan.expiresAt) -le [DateTimeOffset]::UtcNow -or (Get-IncidentHash $pins) -cne (Get-IncidentHash $plan.sourcePins) -or (Get-IncidentVariableHash $live.variables) -cne $plan.variableHash -or (Get-CafeRecoveryTablesHash $before.table_digests) -cne $plan.tablesHash -or (Get-CafeRecoveryControlsHash $before) -cne $plan.controlsHash -or $preflight.checkpointCipherSha256 -cne $plan.checkpointCipherSha256){throw 'PLAN_CAS'}
  $stage='CREATE_NEW_GET_ATTEMPT';Write-CafeFieldReceipt @{kind='CAFE08_FIELD_SAMPLE_GET_ATTEMPT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');maximumGets=42;maximumItemGets=40;automaticRetryAllowed=$false;automaticRefreshAllowed=$false;databaseWrites=0;rawValuesReturned=0} 'attempt'
  $stage='BOUNDED_CURRENT_GET_SAMPLE';$submitted=$true;$safe=Invoke-CafeFieldChild @{action='EXECUTE';expectedCheckpointSha256=$plan.checkpointCipherSha256;input=$inputValue} $true
  if($safe.kind -cne 'CAFE08_CURRENT_FIELD_SAMPLE' -or $safe.providerRequests -lt 1 -or $safe.providerRequests -gt 42 -or $safe.itemRequests -gt 40 -or $safe.rawValuesReturned -ne 0 -or $safe.databaseWrites -ne 0 -or $safe.snapshotComplete -cne $false -or $safe.originalFailureReproduced -cne $false -or $safe.checkpointResumed -cne $false){throw 'PUBLIC_RESULT_SHAPE'}
  $stage='WHOLE68_AFTER_READ';$after=Get-IncidentSnapshot;$afterLive=Get-IncidentState;Assert-CafeRecoveryHold $after $afterLive;Assert-CafeRecoveryDeploymentStopped
  if((Get-CafeRecoveryTablesHash $after.table_digests) -cne (Get-CafeRecoveryTablesHash $before.table_digests) -or (Get-CafeRecoveryControlsHash $after) -cne (Get-CafeRecoveryControlsHash $before) -or (Get-IncidentVariableHash $afterLive.variables) -cne (Get-IncidentVariableHash $live.variables)){throw 'AFTER_PRESERVATION'}
  $safe.whole68Unchanged=$true;$safe.holdsAndEnvironmentUnchanged=$true;Write-CafeFieldReceipt $safe 'result';return $safe
 }catch{
  $safe=@{kind='CAFE08_FIELD_SAMPLE_SAFE_FAILURE';mode=$Action;stage=$stage;requestsMayHaveStarted=$submitted;automaticRetryAllowed=$false;automaticRefreshAllowed=$false;rawErrorSuppressed=$true;rawValuesReturned=0};try{Write-CafeFieldReceipt $safe ('failure-'+$Action.ToLowerInvariant()+'-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddhhmmssfff'))}catch{};return $safe
 }finally{$live=$null;$before=$null;$cipher=$null;$checkpoint=$null;$inputValue=$null;$plan=$null;$safe=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$public=Invoke-CafeFieldAction $Mode;$public|ConvertTo-Json -Depth 20 -Compress
if($public.kind -ceq 'CAFE08_FIELD_SAMPLE_SAFE_FAILURE'){exit 1}
