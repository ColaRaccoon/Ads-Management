param([ValidateSet('Parse','Pure','RunNativeGuard','BuildInput','Prepare','Execute','Inspect','Cleanup')][string]$Mode='Parse',[string]$InputName,[string]$PreparedName,[string]$ExpectedControllerSha256,[string]$ExpectedModuleSha256,[string]$ExpectedExecutorSha256,[string]$AttemptLabel)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
. "$PSScriptRoot/operator-session.ps1"
$script:OneoffEvidence='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/cafe-oneoff-controller-v4'
function Get-OneoffSafeNodeError($Record,[string]$Stage){
 $id=([string]$Record.FullyQualifiedErrorId).Split(',')[0]
 $code=if($id -cin @('ONEOFF_CHILD_TIMEOUT','ONEOFF_OUTPUT_BOUND')){$id}else{'ONEOFF_NODE_CALL_FAILED'}
 $type=$Record.Exception.GetType().Name;$class=if($type -cin @('RuntimeException','IOException','InvalidOperationException','Win32Exception','DecoderFallbackException','OutOfMemoryException','TimeoutException','PipelineStoppedException','MethodInvocationException')){$type}else{'OTHER_SANITIZED'}
 return @{code=$code;exceptionClass=$class;stage=$Stage;functionLine=[int]$Record.InvocationInfo.ScriptLineNumber;rawErrorSuppressed=$true}
}
function Invoke-OneoffNode([string[]]$Arguments,[string]$InputText='',[int]$Timeout=60000,[bool]$Executor=$false,[bool]$Native=$false,[string]$DiagnosticAction='LOCAL'){
 $p=$null;$text=$null;$discard=$null;$watch=[Diagnostics.Stopwatch]::StartNew();$nodeStage='START_INFO';$nodeError=$null;$stdout=$null;$stderr=$null
 $allowed=@('LOCAL','RENDER_Snapshot','RENDER_Inspect','RENDER_Migrate','RENDER_Arm','RENDER_Contain','RENDER_Cleanup','RENDER_Assert','RENDER_Validate','RENDER_NextDay','INPUT_CipherSql','INPUT_MetadataSql','INPUT_Build')
 $tag=if($DiagnosticAction -cin $allowed){$DiagnosticAction}else{'LOCAL'}
 $diagnostic=@{kind='CAFE08_ONEOFF_LOCAL_PROCESS_DIAGNOSTIC';action=$tag;status='FAIL';elapsedMs=0;exitCode=$null;stdoutBytes=$null;stderrBytes=$null;stdoutCompleted=$false;stderrCompleted=$false;rawInputReturned=0;rawOutputReturned=0;rawErrorReturned=0}
 try{
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.WorkingDirectory=(Resolve-Path "$PSScriptRoot/../../..").Path
  foreach($a in $Arguments){$psi.ArgumentList.Add($a)};$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP','ComSpec','WINDIR')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}}
  $psi.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json';if($Executor){$psi.Environment['CAFE08_ONEOFF_PARENT']='20261021-ROOT'};if($Native){$psi.Environment['CAFE08_ONEOFF_NATIVE_PARENT']='20261021-ROOT'}
  $u=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$u;$psi.StandardOutputEncoding=$u;$psi.StandardErrorEncoding=$u
  $nodeStage='PROCESS_START';$p=[Diagnostics.Process]::Start($psi);$stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync();$nodeStage='STDIN_WRITE';$p.StandardInput.Write($InputText);$nodeStage='STDIN_CLOSE';$p.StandardInput.Close();$InputText=$null
  $nodeStage='PROCESS_WAIT';if(-not $p.WaitForExit($Timeout)){throw 'ONEOFF_CHILD_TIMEOUT'};$nodeStage='STDOUT_READ';$text=$stdout.GetAwaiter().GetResult();$nodeStage='STDERR_READ';$discard=$stderr.GetAwaiter().GetResult()
  $diagnostic.stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($text);$diagnostic.stderrBytes=[Text.Encoding]::UTF8.GetByteCount($discard);$discard=$null;$nodeStage='OUTPUT_BOUND'
  if($diagnostic.stdoutBytes -gt 1048576){throw 'ONEOFF_OUTPUT_BOUND'};$diagnostic.status='COMPLETED';return @{exitCode=$p.ExitCode;text=$text}
 }catch{$nodeError=Get-OneoffSafeNodeError $_ $nodeStage;$script:OneoffNodeFailure=$nodeError;throw 'ONEOFF_NODE_CALL_FAILED'}
 finally{
  $watch.Stop();$diagnostic.elapsedMs=[math]::Round($watch.Elapsed.TotalMilliseconds,3);$diagnostic.stage=$nodeStage;$diagnostic.safeFailure=$nodeError
  if($stdout){$diagnostic.stdoutCompleted=$stdout.IsCompleted};if($stderr){$diagnostic.stderrCompleted=$stderr.IsCompleted}
  if($p){try{if(-not $p.HasExited){$p.Kill($true)};if($p.HasExited){$diagnostic.exitCode=$p.ExitCode}}catch{};try{$p.Dispose()}catch{}}
  try{$diagnostic.controllerSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-v4-20261021.ps1') -Algorithm SHA256).Hash.ToLowerInvariant();$diagnostic.moduleSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-20261021.mjs') -Algorithm SHA256).Hash.ToLowerInvariant();Write-OneoffPublic $diagnostic ('local-call-'+[Guid]::NewGuid().ToString())}catch{}
  $InputText=$null;$text=$null;$discard=$null
 }
}
function Write-OneoffPublic($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'ONEOFF_PUBLIC_NAME'};[void][IO.Directory]::CreateDirectory($script:OneoffEvidence)
 $file=[IO.File]::Open(($script:OneoffEvidence+'/'+$Name+'.json'),[IO.FileMode]::CreateNew);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 35));$file.Write($b,0,$b.Length);$file.Flush($true)}finally{$file.Dispose()}
}
function Get-OneoffPins{
 $r=[ordered]@{};foreach($n in @('phase10-cafe-oneoff-controller-v4-20261021.ps1','phase10-cafe-oneoff-controller-20261021.mjs','phase10-cafe-oneoff-controller-native-20261021.mjs','phase10-cafe-oneoff-input-v2-20261021.mjs','phase10-cafe-oneoff-executor-20261021.mjs','phase10-cafe-epoch-live-transport-v2-20261021.mjs','phase10-cafe-epoch-eval-v3-native-20261020.mjs','phase10-cafe-pair-renew-20261021.mjs','operator-session.ps1','incident-common.ps1','scheduler-live-helpers.ps1','protected-context.ps1','scheduler-signing.ps1')){$r[$n]=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $n)).Hash.ToLowerInvariant()};return $r
}
function Assert-OneoffNativeRoot([string]$Root){if($Root -cnotmatch '^C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-oneoff-guard-local-[a-f0-9-]{36}$'){throw 'ONEOFF_NATIVE_ROOT'}}
function New-OneoffNativeRoot([string]$Root){
 Assert-OneoffNativeRoot $Root;if(Test-Path -LiteralPath $Root){throw 'ONEOFF_NATIVE_EXISTS'};[void][IO.Directory]::CreateDirectory($Root);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};Set-Acl -LiteralPath $Root -AclObject $acl;Assert-Phase08PrivatePath -Path $Root -Directory
}
function Assert-OneoffNativeChildAcl([string]$Path){
 $item=Get-Item -LiteralPath $Path -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'ONEOFF_NATIVE_REPARSE'}
 $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($user,'S-1-5-18');$acl=Get-Acl -LiteralPath $Path
 foreach($r in $acl.Access){if($r.AccessControlType -ne 'Allow' -or $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'ONEOFF_NATIVE_CHILD_ACL'}}
 foreach($sid in $allowed){if(@($acl.Access|Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ceq $sid -and $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl}).Count -eq 0){throw 'ONEOFF_NATIVE_CHILD_ACL'}}
}
function Assert-OneoffNativePid($Lines,[string]$Root){Assert-OneoffNativeRoot $Root;if($Lines.Count -lt 6 -or $Lines[1].Replace('\','/') -cne ($Root+'/pg-data') -or $Lines[3] -cne '55438' -or $Lines[5] -cne '127.0.0.1'){throw 'ONEOFF_OWN_PG'}}
function Stop-OneoffNative([string]$Root){
 Assert-OneoffNativeRoot $Root;$file=$Root+'/pg-data/postmaster.pid';if(-not (Test-Path -LiteralPath $file)){return};Assert-Phase08PrivatePath -Path $Root -Directory;Assert-OneoffNativePid (Get-Content -LiteralPath $file) $Root
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');foreach($a in @('-D',($Root+'/pg-data'),'-m','fast','-w','stop')){$psi.ArgumentList.Add($a)};$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=[Diagnostics.Process]::Start($psi);try{$a=$p.StandardOutput.ReadToEndAsync();$b=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(30000)){$p.Kill($true);throw 'ONEOFF_STOP_TIMEOUT'};$null=$a.GetAwaiter().GetResult();$null=$b.GetAwaiter().GetResult();if($p.ExitCode -ne 0){throw 'ONEOFF_STOP_FAILED'}}finally{$p.Dispose()}
}
function Assert-OneoffPins($Pins,[string]$Controller,[string]$Module,[string]$Executor){
 foreach($v in @($Controller,$Module,$Executor)){if($v -cnotmatch '^[a-f0-9]{64}$'){throw 'EXPECTED_PIN_REQUIRED'}}
 if($Pins['phase10-cafe-oneoff-controller-v4-20261021.ps1'] -cne $Controller -or $Pins['phase10-cafe-oneoff-controller-20261021.mjs'] -cne $Module -or $Pins['phase10-cafe-oneoff-executor-20261021.mjs'] -cne $Executor){throw 'EXPECTED_PIN_MISMATCH'}
}
function Assert-OneoffPinSet($Actual,$Expected){if($Actual.Count -ne $Expected.Count){throw 'TOOL_SET'};foreach($k in $Actual.Keys){if($Expected.Keys -cnotcontains $k -or $Actual[$k] -cne $Expected[$k]){throw 'TOOL_CHANGED'}}}
function Assert-OneoffName([string]$Name){if($Name -cnotmatch '^cafe08-oneoff-20261021-[a-z0-9-]{1,80}$'){throw 'ONEOFF_PRIVATE_NAME'}}
function Assert-OneoffHeldState([string]$ExpectedVariables='',$Plan=$null){
 $s=Get-IncidentState
 if($s.serviceInstance.latestDeployment.id -cne '39c6b738-6d2f-4111-a97b-37f017b39886' -or $s.serviceInstance.latestDeployment.meta.imageDigest -cne 'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0' -or $s.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $s.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $s.variables.DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED -cne 'true'){throw 'ONEOFF_HELD_IMAGE_OR_ENV'}
 $h=Get-IncidentVariableHash $s.variables;if($ExpectedVariables -and $h -cne $ExpectedVariables){throw 'ONEOFF_ENV_CAS'}
 if($null -ne $Plan){
  if($s.variables.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION -cne '2' -or $s.variables.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64 -cne $Plan.observationKeyB64){throw 'ONEOFF_APPROVED_KEY_REFERENCE'}
  foreach($key in $s.variables.Keys){if(($key -cmatch '^DAILY_SYNC_CREDENTIAL_KEY_V\d+$' -or $key -ceq 'DAILY_SYNC_CHECKPOINT_KEY_B64') -and $s.variables[$key] -ceq $Plan.observationKeyB64){throw 'ONEOFF_KEY_PURPOSE_REUSE'}}
  $Plan.keyIndependenceVerified=$true
 }
 $d=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id deploymentStopped} activeDeployments{id deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}
 if($d.serviceInstance.serviceId -cne $script:IncidentScope.s -or $d.serviceInstance.environmentId -cne $script:IncidentScope.e -or $d.serviceInstance.latestDeployment.id -cne '39c6b738-6d2f-4111-a97b-37f017b39886' -or $d.serviceInstance.latestDeployment.deploymentStopped -cne $true -or @($d.serviceInstance.activeDeployments|Where-Object deploymentStopped -CNE $true).Count -ne 0){throw 'ONEOFF_APP_NOT_STOPPED'}
 $s=$null;$d=$null;return $h
}
function Invoke-OneoffWire($Wire){
 $r=Invoke-OneoffNode @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-20261021.mjs')) ($Wire|ConvertTo-Json -Depth 45 -Compress) -DiagnosticAction ('RENDER_'+$Wire.action)
 if($r.exitCode -ne 0){throw 'ONEOFF_LOCAL_VALIDATION'};return $r.text
}
function Invoke-OneoffInputWire($Wire){
 $r=Invoke-OneoffNode @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-oneoff-input-v2-20261021.mjs')) ($Wire|ConvertTo-Json -Depth 45 -Compress) -DiagnosticAction ('INPUT_'+$Wire.action)
 if($r.exitCode -ne 0){try{$safe=$r.text|ConvertFrom-Json -AsHashtable;if($safe.kind -ceq 'CAFE08_ONEOFF_INPUT_SAFE_REJECTION' -and $safe.safeStage -cin @('IDENTITY','CONFIG','PAIR','EXPIRY','KEY','ACCESS_AAD','EVIDENCE','CLOSURE','PLAN_CODE')){$script:OneoffInputFailure=$safe.safeStage}}catch{};throw 'ONEOFF_INPUT_REJECTED'};return $r.text
}
function Select-OneoffVariables($Variables){
 $r=@{};foreach($n in $Variables.Keys){if($n -cmatch '^DAILY_SYNC_CREDENTIAL_KEY_V\d+$' -or $n -cin @('DATABASE_URL','DAILY_SYNC_CHECKPOINT_KEY_B64','DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64','DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION','DAILY_SYNC_ACTIVE_KEY_VERSION','DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS','DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED','DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED','DAILY_SYNC_CAFE24_APP_API_VERSION','DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT','DAILY_SYNC_CAFE24_SELLER_DROPDOWN','DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT','DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT','DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP','DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT')){$r[$n]=$Variables[$n]}};return $r
}
function ConvertTo-OneoffSnapshot($Rows){
 $json=ConvertTo-Json -InputObject @($Rows) -Depth 45 -Compress
 if([Text.Encoding]::UTF8.GetByteCount($json) -gt 1048576){throw 'ONEOFF_REPLY_BOUND'}
 $normalized=@($json|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)
 $q=@($normalized|Where-Object {$_ -is [Collections.IDictionary] -and $_.Contains('snapshot')})
 if($q.Count -ne 1 -or $q[0].snapshot -isnot [Collections.IDictionary]){throw 'ONEOFF_SNAPSHOT_SHAPE'}
 return $q[0].snapshot
}
function Invoke-OneoffSql([string]$Action,$Plan,$Before=$null){
 $sql=$null;$rows=$null
 try{$sql=Invoke-OneoffWire @{action=$Action;plan=$Plan;before=$Before};$rows=@(Invoke-Phase08Management -Action Query -Query $sql)
  if($Action -ceq 'Contain'){return $null};return (ConvertTo-OneoffSnapshot $rows)
 }finally{$sql=$null;$rows=$null}
}
function Assert-OneoffSnapshot($Snapshot,[int]$NewTables,[bool]$Armed=$false){$null=Invoke-OneoffWire @{action='Assert';snapshot=$Snapshot;options=@{newTables=$NewTables;armed=$Armed}}}
function Read-OneoffPrepared([string]$Name){Assert-OneoffName $Name;$x=Read-IncidentPrivate $Name;if($x.kind -cne 'CAFE08_ONEOFF_PREPARED' -or $x.operationKey -cne '20261021-cafe08-manual-a'){throw 'ONEOFF_PREPARED_KIND'};return $x}
function Invoke-OneoffAction([string]$Action,[string]$InputReference,[string]$Prepared,[string]$Controller,[string]$Module,[string]$Executor,[string]$Label){
 $stage='PARSE';$safeFailure=$null;$script:OneoffInputFailure=$null;$script:OneoffNodeFailure=$null;$x=$null;$plan=$null;$before=$null;$mutationPossible=$false;$armed=$false;$dayResults=@();$cleanup=@{containCommitted=$false;containVerified=$false;policiesRemoved=$false;protectedRowsVerified=$false};$success=$false
 try{
  if($Action -cnotin @('Parse','Pure','RunNativeGuard','BuildInput','Prepare','Execute','Inspect','Cleanup')){throw 'ONEOFF_MODE'}
  $pins=Get-OneoffPins
  if($Action -ceq 'Parse'){
   $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-v4-20261021.ps1'),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'ONEOFF_PS_PARSE'}
   $r=Invoke-OneoffNode @('--check',(Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-20261021.mjs'));if($r.exitCode -ne 0){throw 'ONEOFF_NODE_PARSE'};return @{status='PASS';kind='CAFE08_ONEOFF_PARSE';pins=$pins;remoteRequests=0;providerRequests=0;rawValuesReturned=0}
  }
  if($Action -ceq 'Pure'){$r=Invoke-OneoffNode @('--import','tsx','--test',(Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-20261021.test.mjs'),(Join-Path $PSScriptRoot 'phase10-cafe-oneoff-input-v2-20261021.test.mjs'));$name='pure-'+[Guid]::NewGuid().ToString();Write-OneoffPublic @{kind='CAFE08_ONEOFF_OFFLINE_TESTS';exitCode=$r.exitCode;output=$r.text;pins=$pins;remoteRequests=0} $name;return @{status=$(if($r.exitCode -eq 0){'PASS'}else{'FAIL'});evidencePath=$script:OneoffEvidence+'/'+$name+'.json';remoteRequests=0;rawValuesReturned=0}}
  Assert-OneoffPins $pins $Controller $Module $Executor
  if($Action -ceq 'RunNativeGuard'){
   $stage='NATIVE_GUARD'
   $id=[Guid]::NewGuid().ToString();$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-oneoff-guard-local-'+$id;New-OneoffNativeRoot $root
   try{
    $wire=@{privateRoot=$root}|ConvertTo-Json -Compress
    $r=Invoke-OneoffNode @((Join-Path $PSScriptRoot 'phase10-cafe-oneoff-controller-native-20261021.mjs')) $wire 300000 $false $true
    $proof=$r.text|ConvertFrom-Json -AsHashtable -Depth 25;Write-OneoffPublic @{kind='CAFE08_ONEOFF_NATIVE_RESULT';status=$proof.status;proof=$proof;pins=$pins;privateRoot=$root;rawValuesReturned=0} ('native-'+$id)
    if($r.exitCode -ne 0 -or $proof.status -cne 'PASS' -or $proof.postgresStopExit -ne 0){throw 'ONEOFF_NATIVE_FAILED'}
    $stage='NATIVE_PRIVACY';Assert-Phase08PrivatePath -Path $root -Directory;foreach($leaf in @('/pg-data','/postgres.log','/pg-data/pg_hba.conf')){Assert-OneoffNativeChildAcl ($root+$leaf)}
    $hba=@(Get-Content -LiteralPath ($root+'/pg-data/pg_hba.conf')|Where-Object {$_ -notmatch '^\s*(#|$)'});if($hba.Count -lt 1 -or @($hba|Where-Object {$_ -notmatch '\s+scram-sha-256\s*$'}).Count -gt 0 -or (Test-Path -LiteralPath ($root+'/oneoff-owner-password.txt'))){throw 'ONEOFF_LOCAL_AUTH_OR_TEMP'}
    Write-OneoffPublic @{kind='CAFE08_ONEOFF_NATIVE_PRIVACY';status='PASS';privateRoot=$root;allowedPrincipals='CurrentUser,SYSTEM';allHbaScramSha256=$true;temporarySyntheticPasswordFilesCreated=1;temporaryPasswordFilesRemaining=0;syntheticDataRetained=$true;liveCustomerInput=$false;remoteRequests=0;providerRequests=0;rawValuesReturned=0} ('native-'+$id+'-privacy')
    return @{status='PASS';cases=$proof.caseCount;postgresStopExit=0;evidencePath=$script:OneoffEvidence+'/native-'+$id+'.json';remoteRequests=0;providerRequests=0;rawValuesReturned=0}
   }finally{Stop-OneoffNative $root}
  }
  if($Label -cnotmatch '^[a-z0-9-]{1,80}$'){throw 'ONEOFF_ATTEMPT_LABEL'}
  if(Test-Path -LiteralPath ($script:OneoffEvidence+'/'+$Label+'-attempt.json')){throw 'ONEOFF_CONSUMED'}
  if($Action -ceq 'BuildInput'){
   Assert-OneoffName $InputReference;$stage='INPUT_HELD_RO';$vh=Assert-OneoffHeldState;$state=Get-IncidentState;if((Get-IncidentVariableHash $state.variables) -cne $vh){throw 'ONEOFF_INPUT_ENV_CAS'}
   $variables=Select-OneoffVariables $state.variables;$state=$null
   $stage='INPUT_OPERATOR_PROJECTION';$operator=Read-Phase08Operator;$operatorSafe=@{appId=$operator.appId;authId=$operator.authId};$operator=$null
   $stage='INPUT_CIPHER_RO';$sql=Invoke-OneoffInputWire @{action='CipherSql'};$rows=@(Invoke-Phase08Management -Action Query -Query $sql);$sql=$null;if($rows.Count -ne 1){throw 'ONEOFF_CIPHER_SHAPE'};$cipher=$rows[0];$rows=$null
   $stage='INPUT_METADATA_RO';$sql=Invoke-OneoffInputWire @{action='MetadataSql';operator=$operatorSafe};$rows=@(Invoke-Phase08Management -Action Query -Query $sql);$sql=$null;if($rows.Count -ne 1){throw 'ONEOFF_METADATA_SHAPE'};$metadata=$rows[0];$rows=$null
   $stage='INPUT_MEMORY_ONLY';$text=Invoke-OneoffInputWire @{action='Build';input=@{variables=$variables;snapshot=$cipher;metadata=$metadata;operator=$operatorSafe;holdsVerified=$true}};$plan=$text|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String;$text=$null;$variables=$null;$cipher=$null;$metadata=$null;$operatorSafe=$null
   $stage='INPUT_DPAPI';Write-IncidentPrivate $plan $InputReference;$check=Read-IncidentPrivate $InputReference;if($check.baselineApprovalSha256 -cne $plan.baselineApprovalSha256 -or $check.access -cne $plan.access -or $check.observationKeyB64 -cne $plan.observationKeyB64 -or $check.databaseUrl -cne $plan.databaseUrl){throw 'ONEOFF_INPUT_READBACK'};$check=$null
   $null=Assert-OneoffHeldState $vh $plan;Write-OneoffPublic @{kind='CAFE08_ONEOFF_PROTECTED_INPUT';status='PASS';inputReference=$InputReference;at=[DateTimeOffset]::UtcNow.ToString('o');sourceClosure=$plan.sourceClosureProof;approvalSha256=$plan.baselineApprovalSha256;approvedDays=$plan.approvedDays;keyIndependenceVerified=$true;credentialRevision=10;operatorExactActiveSuperAdmin=$true;currentCsvPolicyVersion=5;strictTlsProtectedCopyOnly=$true;environmentUnchanged=$true;newApprovalNotCopiedFromLocal=$true;privateReadbackVerified=$true;pins=$pins;providerRequests=0;remoteMutations=0;rawValuesReturned=0} ($Label+'-input')
   return @{status='PASS';inputReference=$InputReference;evidencePath=$script:OneoffEvidence+'/'+$Label+'-input.json';providerRequests=0;remoteMutations=0;rawValuesReturned=0}
  }
  if($Action -ceq 'Prepare'){
   Assert-OneoffName $InputReference;Assert-OneoffName $Prepared;$stage='PROTECTED_INPUT';$plan=Read-IncidentPrivate $InputReference
   if($plan.day -cne '2026-10-16' -or $plan.usedRequests -ne 0 -or $plan.usedBytes -ne 0){throw 'ONEOFF_FIRST_DAY'}
   $stage='HELD_RO';$vars=Assert-OneoffHeldState '' $plan;$before=Invoke-OneoffSql 'Snapshot' $plan;Assert-OneoffSnapshot $before 0
   if($before.ownRuns -ne 0){throw 'ONEOFF_EXISTING_REQUEST'}
   if($plan.expectedConnectionMd5 -cne $before.connection -or $plan.expectedPolicyMd5 -cne $before.policy){throw 'ONEOFF_INPUT_SNAPSHOT_CAS'}
   $plan.operationPreparedAt=$plan.preparedAt;$plan.operationDeadlineAt=([DateTimeOffset]::Parse($plan.preparedAt).AddMinutes(25)).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
   $stage='CHILD_PLAN_VALIDATION';$closure=Invoke-OneoffWire @{action='Validate';plan=$plan}|ConvertFrom-Json -AsHashtable
   $x=@{kind='CAFE08_ONEOFF_PREPARED';operationKey=$plan.operationKey;plan=$plan;before=$before;variablesHash=$vars;pins=$pins;eligibleSecretRollback=$false}
   Write-IncidentPrivate $x $Prepared;Write-OneoffPublic @{kind='CAFE08_ONEOFF_RO_PREPARED';status='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');preparedReference=$Prepared;variablesHash=$vars;pins=$pins;sourceClosure=$closure;before=$before;rawValuesReturned=0;providerRequests=0;remoteMutations=0;automaticRetry=$false} ($Label+'-prepared')
   return @{status='PASS';preparedReference=$Prepared;evidencePath=$script:OneoffEvidence+'/'+$Label+'-prepared.json';remoteMutations=0;providerRequests=0;rawValuesReturned=0}
  }
  $x=Read-OneoffPrepared $Prepared;$plan=$x.plan;$before=$x.before;Assert-OneoffPinSet $pins $x.pins
  if($Action -ceq 'Inspect'){$stage='INSPECT';$vh=Assert-OneoffHeldState $x.variablesHash;$s=Invoke-OneoffSql 'Inspect' $plan;Write-OneoffPublic @{kind='CAFE08_ONEOFF_RO_INSPECTION';status='INSPECTED';snapshot=$s;variablesUnchanged=$true;providerRequests=0;remoteMutations=0;rawValuesReturned=0} ($Label+'-inspect');return @{status='PASS';evidencePath=$script:OneoffEvidence+'/'+$Label+'-inspect.json';remoteMutations=0;rawValuesReturned=0}}
  $stage='PRE_EXECUTION';$null=Assert-OneoffHeldState $x.variablesHash $plan
  if($Action -ceq 'Execute'){
   $null=Invoke-OneoffWire @{action='Validate';plan=$plan}
   # CreateNew before the first management mutation. Unknown outcomes are never replayed.
   Write-OneoffPublic @{kind='CAFE08_ONEOFF_CONTROLLED_ATTEMPT';status='STARTED';at=[DateTimeOffset]::UtcNow.ToString('o');preparedReference=$Prepared;pins=$pins;approvedDays=@('2026-10-16','2026-10-17');newManualRunsOnly=$true;oldScheduledRunsModified=$false;automaticRetry=$false;rawValuesReturned=0} ($Label+'-attempt')
   $mutationPossible=$true;$stage='MIGRATION52';$s=Invoke-OneoffSql 'Migrate' $plan $before;Assert-OneoffSnapshot $s 2;$plan.newCatalogMd5=$s.newCatalog
   Write-OneoffPublic @{kind='CAFE08_ONEOFF_ADDITIVE52';status='PASS';snapshot=$s;migrationSha256='0242d0a231ffe93fa35f1a94c5effaedb0f671a29a8a8d66b7a3b7d7aae7ad99';ledgerWritten=$false;rawValuesReturned=0} ($Label+'-migration')
   $stage='ARM';$s=Invoke-OneoffSql 'Arm' $plan $before;Assert-OneoffSnapshot $s 2 $true;$plan.expectedConnectionMd5=$s.connection;$plan.armedPolicyMd5=$s.newPolicyHash;$armed=$true
   # A separate protected receipt enables guarded cleanup after a control-process interruption.
   $x.plan=$plan;Write-IncidentPrivate $x ($Prepared+'-armed');Write-OneoffPublic @{kind='CAFE08_ONEOFF_ARMED';status='PASS';snapshot=$s;protectedCleanupReference=$Prepared+'-armed';rawValuesReturned=0} ($Label+'-armed')
   foreach($day in @('2026-10-16','2026-10-17')){
    $stage='EXECUTE_'+$day;$plan=(Invoke-OneoffWire @{action='NextDay';plan=$plan;day=$day}|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)
    $null=Invoke-OneoffWire @{action='Validate';plan=$plan}
    $r=Invoke-OneoffNode @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-oneoff-executor-20261021.mjs')) ($plan|ConvertTo-Json -Depth 45 -Compress) 720000 $true
    $safe=$r.text|ConvertFrom-Json -AsHashtable -Depth 30
    if($safe.kind -cne 'CAFE08_ONEOFF_CHILD_RESULT' -or $safe.operationKey -cne $plan.operationKey -or $safe.day -cne $day -or $safe.requestKey -cne $plan.requestKey -or $safe.rawValuesReturned -ne 0 -or $safe.providerTokenPosts -ne 0){throw 'ONEOFF_CHILD_RESULT'}
    Write-OneoffPublic $safe ($Label+'-day-'+$day);$dayResults+=,$safe
    if($r.exitCode -ne 0 -or $safe.status -cne 'PASS'){throw 'ONEOFF_DAY_FAILED'}
    $plan.usedRequests=[int]$safe.cumulativeRequests;$plan.usedBytes=[long]$safe.cumulativeResponseBytes
    if($plan.usedRequests -gt 2050 -or $plan.usedBytes -gt 67108864){throw 'ONEOFF_CUMULATIVE_BOUND'}
    $null=Assert-OneoffHeldState $x.variablesHash
   };$success=$true
  }elseif($Action -ceq 'Cleanup'){$mutationPossible=$true;$armed=$plan.ContainsKey('armedPolicyMd5');$success=$armed;Write-OneoffPublic @{kind='CAFE08_ONEOFF_CLEANUP_ATTEMPT';status='STARTED';automaticRetry=$false;providerRequests=0;rawValuesReturned=0} ($Label+'-attempt')}
 }catch{$safeFailure=@{category=$_.CategoryInfo.Category.ToString();line=[int]$_.InvocationInfo.ScriptLineNumber;inputGuardStage=$script:OneoffInputFailure;nodeFailure=$script:OneoffNodeFailure;rawErrorSuppressed=$true};$success=$false}
 finally{
  if($mutationPossible -and $plan){
   # This security commit precedes every optional policy/preservation check.
   try{$null=Invoke-OneoffSql 'Contain' $plan;$cleanup.containCommitted=$true}catch{$cleanup.containCommitted=$false}
   if($cleanup.containCommitted -and $armed){try{$s=Invoke-OneoffSql 'Cleanup' $plan $before;Assert-OneoffSnapshot $s 2;$cleanup.containVerified=$true;$cleanup.policiesRemoved=$true;$cleanup.protectedRowsVerified=$true;$cleanup.snapshot=$s}catch{$success=$false}}
   elseif($cleanup.containCommitted){try{$s=Invoke-OneoffSql 'Inspect' $plan;$cleanup.snapshot=$s;$cleanup.containVerified=($s.login -ceq $false -and $s.enabled -ceq $false -and $s.backends -eq 0 -and $s.leases -eq 0 -and $s.newGrants -eq 0 -and $s.heldGrants -eq 0)}catch{$success=$false}}
   try{$null=Assert-OneoffHeldState $x.variablesHash;$cleanup.environmentAndStoppedImageUnchanged=$true}catch{$cleanup.environmentAndStoppedImageUnchanged=$false;$success=$false}
   if(-not $cleanup.containVerified -or ($armed -and -not $cleanup.policiesRemoved)){$success=$false}
   try{Write-OneoffPublic @{kind='CAFE08_ONEOFF_FINAL';status=$(if($success){'PASS'}else{'FAIL'});stage=$stage;safeFailure=$safeFailure;cleanup=$cleanup;dayResults=$dayResults;rawErrorSuppressed=$true;outcomeUncertain=(-not $success);automaticRetry=$false;inspectBeforeFurtherRun=$true;rawValuesReturned=0} ($Label+'-result')}catch{$success=$false}
  }
  $x=$null;$before=$null;$plan=$null;$safe=$null;$r=$null;$s=$null;$variables=$null;$cipher=$null;$metadata=$null;$operator=$null;$operatorSafe=$null;$text=$null;$check=$null;$state=$null;$sql=$null;$rows=$null
 }
 if(-not $mutationPossible -and $Label -cmatch '^[a-z0-9-]{1,80}$'){try{Write-OneoffPublic @{kind='CAFE08_ONEOFF_SAFE_PREFLIGHT_FAILURE';status='FAIL';stage=$stage;safeFailure=$safeFailure;outcomeUncertain=$false;remoteMutations=0;providerRequests=0;automaticRetry=$false;rawErrorSuppressed=$true;rawValuesReturned=0} ($Label+'-result')}catch{}}
 return @{kind='CAFE08_ONEOFF_CONTROL_HANDOFF';status=$(if($success){'PASS'}else{'FAIL'});stage=$stage;safeFailure=$safeFailure;cleanup=$cleanup;rawErrorSuppressed=$true;automaticRetry=$false;rawValuesReturned=0;evidencePath=$script:OneoffEvidence+'/'+$Label+'-result.json'}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$r=Invoke-OneoffAction $Mode $InputName $PreparedName $ExpectedControllerSha256 $ExpectedModuleSha256 $ExpectedExecutorSha256 $AttemptLabel;$r|ConvertTo-Json -Depth 35 -Compress;if($r.status -cne 'PASS'){exit 1}
