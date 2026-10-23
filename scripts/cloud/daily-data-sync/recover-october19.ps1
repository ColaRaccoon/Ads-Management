param([Parameter(Mandatory)][ValidateSet('Baseline','Prepare','Rotate','Deploy','Status','Verify','Idle','SyncLocal')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. 'C:/Users/seong/Desktop/workspace/Meta-Ads-Performance-security-rbac/보안단계별적용/증거/0908-staging-db-roles/phase2-secret-lib.ps1'
$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/recovery-20261019'
$private='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/storage-recovery-20261019.dpapi'
$p='d72f4256-8632-437a-9dae-9b5d96736fc7';$e='d261a432-a6a4-4031-b8ea-c619ac263cc3';$s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'
$old='3ccd3843-a15f-4655-a937-c190779ce769';$source='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1'
$stage='START';$submitted=$false;$material=$null;$live=$null;$headers=$null
function Save-Public($Value,[string]$Name){
 [void][IO.Directory]::CreateDirectory($root)
 $path=Join-Path $root "$Name.json";$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 25))
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
function Read-Public([string]$Name){return ([IO.File]::ReadAllText((Join-Path $root "$Name.json"))|ConvertFrom-Json -AsHashtable -Depth 25 -DateKind String)}
function Hash-Text([string]$Text){return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()}
function Prepare-Child($InputValue){
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
 foreach($a in @('node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json',"$PSScriptRoot/recover-october19-storage.mjs")){$psi.ArgumentList.Add($a)}
 $psi.Environment.Clear();foreach($k in @('PATH','SystemRoot','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA')){if([Environment]::GetEnvironmentVariable($k)){$psi.Environment[$k]=[Environment]::GetEnvironmentVariable($k)}}
 $child=[Diagnostics.Process]::new();$child.StartInfo=$psi
 try{$null=$child.Start();$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$wire=$InputValue|ConvertTo-Json -Compress -Depth 25;$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
 if(-not $child.WaitForExit(30000)){$child.Kill($true);throw 'PREPARE_CHILD_TIMEOUT'}
 $raw=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($child.ExitCode -ne 0 -or $raw.Length -gt 1048576){throw 'PREPARE_CHILD_FAILED'};return ($raw|ConvertFrom-Json -AsHashtable -DateKind String -Depth 20)
 }finally{$raw=$null;$wire=$null;$InputValue=$null;$out=$null;$err=$null;$child.Dispose()}
}
function Variables-Digest($Variables){$ordered=[ordered]@{};foreach($k in @($Variables.Keys|Sort-Object)){if($k -cne 'SUPABASE_STORAGE_ACCESS_TOKEN'){$ordered[$k]=$Variables[$k]}};return Hash-Text ($ordered|ConvertTo-Json -Compress -Depth 12)}
function Live-State {
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id services{edges{node{id}}} environments{edges{node{id unmergedChangesCount}}}} variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status canRedeploy meta} activeDeployments{id status}}}' @{p=$p;e=$e;s=$s}
 if($r.project.id -cne $p -or @($r.project.services.edges|Where-Object {$_.node.id -ceq $s}).Count -ne 1 -or @($r.project.environments.edges|Where-Object {$_.node.id -ceq $e}).Count -ne 1 -or $r.serviceInstance.serviceId -cne $s -or $r.serviceInstance.environmentId -cne $e -or $r.serviceInstance.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $r.serviceInstance.sleepApplication -cne $true){throw 'IDENTITY'}
 $v=$r.variables
 $environment=@($r.project.environments.edges|Where-Object {$_.node.id -ceq $e})[0].node
 if(-not $environment.ContainsKey('unmergedChangesCount') -or ($null -ne $environment.unmergedChangesCount -and $environment.unmergedChangesCount -cne 0)){throw 'PENDING_ENVIRONMENT_CHANGES'}
 if($v.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $v.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $v.PHASE08_SOURCE_CONTENT_SHA256 -cne $source -or $v.PRISMA_CONNECTION_LIMIT -cne '3' -or $v.HEAVY_OPERATION_CONCURRENCY -cne '1' -or $v.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $v.DAILY_SYNC_SCHEDULE_ENABLED -cne 'true'){throw 'VARIABLE_IDENTITY'}
 if(@($r.serviceInstance.activeDeployments).Count -ne 1 -or $r.serviceInstance.activeDeployments[0].id -cne $r.serviceInstance.latestDeployment.id){throw 'ACTIVE_DEPLOYMENT'}
 return ($r|ConvertTo-Json -Depth 20|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)
}
function Snapshot {
 $sql=@'
BEGIN READ ONLY;
SET LOCAL statement_timeout=20000;
DO $snapshot$ DECLARE r record;d text;all_rows text:='';BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x',r.tablename) INTO d;
 all_rows:=all_rows||r.tablename||':'||d||';';END LOOP;
 PERFORM set_config('daily_data_sync.recovery_readonly_business',md5(all_rows),true);END $snapshot$;
SELECT current_database() AS database,current_user AS principal,current_setting('transaction_read_only') AS read_only,
 current_setting('daily_data_sync.recovery_readonly_business') AS business_md5,
 (SELECT count(*)::int FROM pg_tables WHERE schemaname='phase08_meta_ads') AS tables,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS force_rls,
 (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,
 (SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.jobid)::text,'')) FROM cron.job x) AS jobs_md5,
 (SELECT count(*)::int FROM cron.job WHERE active) AS active_jobs,
 (SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY x.key)::text) FROM daily_data_sync_ops.schedules x) AS schedules_md5,
 (SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused,
 (SELECT md5(jsonb_agg(to_jsonb(x))::text) FROM daily_data_sync_ops.settings x) AS settings_md5,
 (SELECT md5(prosrc) FROM pg_proc WHERE oid='daily_data_sync_ops.call(text,boolean)'::regprocedure) AS call_md5,
 (SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) AS original152_md5,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
 (SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime') AS runtime_backends,
 (SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id)::text,'')) FROM storage.objects x WHERE bucket_id='meta-ads-phase08-isolated') AS storage_objects_md5,
 to_regnamespace('storage_renewal_ops') IS NOT NULL AS operating_renewal_schema_present;
COMMIT;
'@
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1){throw 'SNAPSHOT_COUNT'};$r=$rows[0]
 if($r.database -cne 'postgres' -or $r.principal -cne 'postgres' -or $r.read_only -cne 'on' -or $r.tables -ne 68 -or $r.force_rls -ne 68 -or $r.stopped -cne $false -or $r.active_jobs -ne 149 -or $r.paused -ne 0 -or $r.call_md5 -cne '0f11e36961a628ab665302b950d0b9aa' -or $r.live_leases -ne 0 -or $r.operating_renewal_schema_present -cne $false){throw 'SNAPSHOT_BASELINE'}
 return ($r|ConvertTo-Json -Depth 20|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)
}
function Preserved($Before,$After){foreach($k in @('business_md5','jobs_md5','schedules_md5','settings_md5','call_md5','original152_md5','storage_objects_md5')){if($Before[$k] -cne $After[$k]){throw "PRESERVATION_$k"}}}
function Save-Private($Value){
 if(Test-Path -LiteralPath $private){throw 'PRIVATE_EXISTS'}
 $plain=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Compress -Depth 20))
 try{$bytes=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('Phase08StorageRecovery20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$stream=[IO.File]::Open($private,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()};Set-Phase08NewPrivateAcl -Path $private}finally{[Array]::Clear($plain,0,$plain.Length);if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
}
function Read-Private {
 Assert-Phase08PrivatePath -Path $private;$enc=[IO.File]::ReadAllBytes($private)
 try{$plain=[Security.Cryptography.ProtectedData]::Unprotect($enc,[Text.Encoding]::ASCII.GetBytes('Phase08StorageRecovery20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);return ([Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)}finally{[Array]::Clear($enc,0,$enc.Length);if($plain){[Array]::Clear($plain,0,$plain.Length)}}
}
function Probe-Storage($Variables,[string]$Token){
 $headers=@{apikey=$Variables.SUPABASE_PUBLISHABLE_KEY;Authorization=('Bearer '+$Token)}
 try{$reply=Invoke-WebRequest -Uri 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/storage/v1/object/authenticated/meta-ads-phase08-isolated/health/readiness-sentinel' -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 25 -SkipHttpErrorCheck;if([int]$reply.StatusCode -ne 200){throw 'STORAGE_PROBE'};return 200}finally{$headers.Clear();$reply=$null}
}
try{
 Import-Phase08SchedulerChildDefinitions
 $stage='LIVE_IDENTITY';$live=Live-State;$v=$live.variables;$d=$live.serviceInstance.latestDeployment
 if($Mode -ceq 'Status'){@{kind='PHASE08_RECOVERY_STATUS';deploymentId=$d.id;status=$d.status;observedAt=[DateTimeOffset]::UtcNow.ToString('o');appRequests=0}|ConvertTo-Json;exit 0}
 if($Mode -ceq 'Baseline'){
  if($d.id -cne $old -or $d.status -cne 'CRASHED' -or $d.canRedeploy -cne $true){throw 'BASELINE_DEPLOYMENT'}
  $stage='READONLY_SNAPSHOT';$snapshot=Snapshot
  $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($v.SUPABASE_STORAGE_ACCESS_TOKEN.Split('.')[1].Replace('-','+').Replace('_','/')).PadRight(($v.SUPABASE_STORAGE_ACCESS_TOKEN.Split('.')[1].Length+3)-(($v.SUPABASE_STORAGE_ACCESS_TOKEN.Split('.')[1].Length+3)%4),'=')))|ConvertFrom-Json
  $out=@{kind='PHASE08_RECOVERY_BASELINE';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;status=$d.status;sourceSha=$source;imageDigest=$d.meta.imageDigest;deployConfigHash=(Hash-Text ($d.meta.serviceManifest.deploy|ConvertTo-Json -Compress -Depth 25));variablesExceptTokenHash=(Variables-Digest $v);variableCount=$v.Count;storageExpiresAt=[DateTimeOffset]::FromUnixTimeSeconds($claims.exp).ToString('o');snapshot=$snapshot;databaseWrites=0;providerRequests=0};Save-Public $out 'baseline';$out|ConvertTo-Json -Depth 12;exit 0
 }
 $before=Read-Public 'baseline'
 if((Variables-Digest $v) -cne $before.variablesExceptTokenHash -or $v.Count -ne $before.variableCount){throw 'VARIABLE_PRESERVATION'}
 if($Mode -ceq 'SyncLocal'){
  $stage='LOCAL_CREDENTIAL_SYNC';$proof=Read-Public 'verified';$material=Read-Private
  if($proof.verified -cne $true -or $proof.deploymentId -cne $d.id -or $v.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.token -or $d.status -cnotin @('SUCCESS','SLEEPING')){throw 'SYNC_NOT_VERIFIED'}
  $paths=Get-Phase08ProtectedPaths;$context=Read-Phase08ProtectedJson
  if($context.env.SUPABASE_STORAGE_ACCESS_TOKEN -ceq $material.token){throw 'SYNC_ALREADY_APPLIED'}
  $oldContextHash=Variables-Digest ($context.env|ConvertTo-Json -Compress -Depth 25|ConvertFrom-Json -AsHashtable -Depth 25 -DateKind String)
  $backup=Join-Path $paths.Root 'runtime-json-before-storage-20261019.dpapi';$temp=Join-Path $paths.Root 'runtime-storage-sync-20261019.dpapi'
  foreach($path in @($paths.File,$backup,$temp)){if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -cne [IO.Path]::GetFullPath($paths.Root)){throw 'SYNC_PATH'}}
  if((Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $temp)){throw 'SYNC_FILES_EXIST'}
  $originalHash=(Get-FileHash -LiteralPath $paths.File -Algorithm SHA256).Hash
  $context.env.SUPABASE_STORAGE_ACCESS_TOKEN=$material.token;$context.storageExpiresAt=$material.expiresAt
  $body=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';context=$context}|ConvertTo-Json -Depth 30 -Compress
  $plain=[Text.Encoding]::UTF8.GetBytes($body);$body=$null
  try{
   $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
   $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-DPAPI-1');$all=[byte[]]::new($magic.Length+$encrypted.Length);[Array]::Copy($magic,0,$all,0,$magic.Length);[Array]::Copy($encrypted,0,$all,$magic.Length,$encrypted.Length)
   $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($all,0,$all.Length);$stream.Flush($true)}finally{$stream.Dispose()}
   Set-Phase08NewPrivateAcl -Path $temp
   [IO.File]::Replace($temp,$paths.File,$backup)
  }finally{foreach($bytes in @($plain,$encrypted,$all)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}}
  Assert-Phase08PrivatePath -Path $backup;Assert-Phase08PrivatePath -Path $paths.File
  $check=Read-Phase08ProtectedJson
  if((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -cne $originalHash -or $check.env.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.token -or (Variables-Digest ($check.env|ConvertTo-Json -Compress -Depth 25|ConvertFrom-Json -AsHashtable -Depth 25 -DateKind String)) -cne $oldContextHash){throw 'SYNC_READBACK'}
  $out=@{kind='PHASE08_CURRENT_DPAPI_STORAGE_SYNC';observedAt=[DateTimeOffset]::UtcNow.ToString('o');verified=$true;originalEncryptedBytesPreserved=$true;originalEncryptedSha256=$originalHash.ToLowerInvariant();backupFile='runtime-json-before-storage-20261019.dpapi';onlyCredentialAndExpiryUpdated=$true;otherContextVariablesPreserved=$true;remoteWrites=0};Save-Public $out 'local-synced';$out|ConvertTo-Json;exit 0
 }
 if($Mode -ceq 'Prepare'){
  if($d.id -cne $old -or $d.status -cne 'CRASHED'){throw 'PREPARE_BASELINE'}
  $stage='KEY_READ';$keyPath=Join-Path $env:APPDATA 'MetaAdsSecurity/staging-app-runtime/signing-key.dpapi';Assert-R2ANotReparsePoint $keyPath;Assert-R2AUserSystemOnlyAcl $keyPath
  $jwk=(Unprotect-R2APlaintextSecret ([IO.File]::ReadAllText($keyPath)))|ConvertFrom-Json -AsHashtable
  $jwks=Invoke-RestMethod 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1/.well-known/jwks.json' -MaximumRedirection 0 -TimeoutSec 15
  $stage='OFFLINE_FROZEN_VALIDATION';$material=Prepare-Child @{env=$v;jwk=$jwk;publicJwks=$jwks}
  if($material.ContainsKey('failedStage')){$material|ConvertTo-Json;throw 'CHILD_PREPARE_REJECTED'}
  $jwk=$null;$jwks=$null
  if($material.sameScope -cne $true -or $material.signatureVerified -cne $true -or $material.beforeValidation -cne 'STORAGE_MINIMUM_OVERLAP_REJECTED' -or $material.afterValidation -cne 'PASSED'){throw 'MATERIAL'}
  $stage='NEW_SCOPED_STORAGE_READ';$status=Probe-Storage $v $material.token
  $stage='DPAPI_NEW_FILE';Save-Private $material
  $out=@{};foreach($k in @('issuedAt','expiresAt','oldExpiresAt','sameScope','signatureVerified','beforeValidation','afterValidation','runtimeConfigFingerprint','frozenValidatorSha256')){$out[$k]=$material[$k]};$out.kind='PHASE08_RECOVERY_CREDENTIAL_PREPARED';$out.storageGetStatus=$status;$out.remoteWrites=0;Save-Public $out 'prepared';$out|ConvertTo-Json;exit 0
 }
 if($Mode -cin @('Rotate','Deploy')){
  $stage='CLOCK_AND_SNAPSHOT';if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]'2026-10-19T08:00:00Z'){throw 'EXECUTION_WINDOW_EXPIRED'}
  if($d.id -cne $old -or $d.status -cne 'CRASHED'){throw 'OLD_PIN'}
  $snapshot=Snapshot;Preserved $before.snapshot $snapshot;$material=Read-Private
  if([DateTimeOffset]::Parse($material.expiresAt) -lt [DateTimeOffset]::UtcNow.AddDays(5)){throw 'TOKEN_TOO_OLD'}
  if($Mode -ceq 'Rotate'){
   $context=Read-Phase08ProtectedJson;if($v.SUPABASE_STORAGE_ACCESS_TOKEN -cne $context.env.SUPABASE_STORAGE_ACCESS_TOKEN){throw 'OLD_TOKEN_CHANGED_INSPECT_BEFORE_OVERWRITE'}
   if($v.SUPABASE_STORAGE_ACCESS_TOKEN -ceq $material.token){throw 'ALREADY_ROTATED_INSPECT_RECEIPT'}
   Save-Public @{kind='ONE_TOKEN_UPDATE_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$old;onlyVariable='SUPABASE_STORAGE_ACCESS_TOKEN';skipDeploys=$true} 'rotate-attempt'
   $stage='ONE_VARIABLE_UPDATE';$submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$p;environmentId=$e;serviceId=$s;replace=$false;skipDeploys=$true;variables=@{SUPABASE_STORAGE_ACCESS_TOKEN=$material.token}}}
   if($reply.variableCollectionUpsert -cne $true){throw 'UPDATE_OUTCOME_UNKNOWN'}
   $stage='READBACK';$fresh=Live-State;if($fresh.variables.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.token -or (Variables-Digest $fresh.variables) -cne $before.variablesExceptTokenHash -or $fresh.serviceInstance.latestDeployment.id -cne $old){throw 'UPDATE_READBACK'}
   Save-Public @{kind='PHASE08_RECOVERY_TOKEN_UPDATED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');onlyOneVariableChanged=$true;skipDeploys=$true;deploymentStillOld=$true;expiresAt=$material.expiresAt;databaseWrites=0;providerRequests=0;operatingChanges=0} 'rotated';@{kind='PHASE08_RECOVERY_TOKEN_UPDATED';verified=$true}|ConvertTo-Json;exit 0
  }
  $rotated=Read-Public 'rotated';if($rotated.onlyOneVariableChanged -cne $true -or $v.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.token){throw 'ROTATED_REQUIRED'}
  Save-Public @{kind='SAME_IMAGE_DEPLOY_PLANNED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');previousDeployment=$old;imageDigest=$before.imageDigest;buildRequested=$false} 'deploy-attempt'
  $stage='ONE_SAME_IMAGE_DEPLOY';$submitted=$true;$reply=Invoke-Phase08SchedulerGraph 'mutation($id:String!){deploymentRedeploy(id:$id,usePreviousImageTag:true){id}}' @{id=$old};$new=$reply.deploymentRedeploy.id
  if($new -isnot [string] -or $new -cnotmatch '^[a-f0-9-]{36}$' -or $new -ceq $old){throw 'DEPLOY_OUTCOME_UNKNOWN'}
  Save-Public @{kind='PHASE08_RECOVERY_DEPLOY_SUBMITTED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$new;previousDeploymentId=$old;sourceSha=$source;mutationCalls=1;buildRequested=$false} 'deployment';@{kind='PHASE08_RECOVERY_DEPLOY_SUBMITTED';deploymentId=$new}|ConvertTo-Json;exit 0
 }
 $deployment=Read-Public 'deployment';if($d.id -cne $deployment.deploymentId -or $d.status -cnotin @('SUCCESS','SLEEPING')){throw 'NEW_DEPLOYMENT_NOT_READY'}
 if($d.meta.imageDigest -cne $before.imageDigest -or (Hash-Text ($d.meta.serviceManifest.deploy|ConvertTo-Json -Compress -Depth 25)) -cne $before.deployConfigHash){throw 'IMAGE_OR_RESOURCE_CHANGED'}
 $material=Read-Private;if($v.SUPABASE_STORAGE_ACCESS_TOKEN -cne $material.token){throw 'TOKEN_READBACK'}
 if($Mode -ceq 'Verify'){
  $stage='PROTECTED_READY';$context=Read-Phase08ProtectedJson;$pins=Get-Phase08SchedulerPins;$pins.deploymentId=$d.id;$ready=Get-Phase08SchedulerReady $context $pins
  $stage='STORAGE_GET';$storage=Probe-Storage $v $material.token
  $stage='PRESERVATION';$after=Snapshot;Preserved $before.snapshot $after
  $out=@{kind='PHASE08_RECOVERY_VERIFIED';verified=$true;observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;deploymentStatus=$d.status;sourceSha=$source;imageDigest=$d.meta.imageDigest;sameImageAndResources=$true;allOtherVariablesPreserved=$true;readyStatus=200;ready=$ready;storageGetStatus=$storage;storageExpiresAt=$material.expiresAt;snapshot=$after;allBusinessRowsAndSchedulesUnchanged=$true;databaseWrites=0;providerRequests=0;operatingChanges=0};Save-Public $out 'verified';$out|ConvertTo-Json -Depth 12;exit 0
 }
 $stage='IDLE_GRAPH';if($d.status -cne 'SLEEPING'){throw 'NOT_SLEEPING_YET'}
 $after=Snapshot;Preserved $before.snapshot $after;if($after.runtime_backends -ne 0){throw 'BACKENDS_NOT_ZERO_YET'}
 $out=@{kind='PHASE08_RECOVERY_IDLE_VERIFIED';verified=$true;observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$d.id;status='SLEEPING';runtimeBackends=0;liveLeases=0;allBusinessRowsAndSchedulesUnchanged=$true;activeJobs=149;stopped=$false;paused=0;appRequests=0;providerRequests=0;operatingChanges=0};Save-Public $out 'idle';$out|ConvertTo-Json
}catch{
 $message=$_.Exception.Message;$known=if($message -cmatch '^(PRESERVATION_|SNAPSHOT_|PHASE08_|VARIABLE_|OLD_|TOKEN_|EXECUTION_)[A-Za-z0-9_]+$'){$message}else{'UNCLASSIFIED'}
 @{kind='PHASE08_RECOVERY_REJECTED';mode=$Mode;stage=$stage;safeCode=$known;outcomeUncertain=$submitted;retryMutation=$false;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1
}finally{$material=$null;$live=$null;$v=$null;$context=$null;$jwk=$null;$jwks=$null;$reply=$null;$fresh=$null;if($headers){$headers.Clear()}}
