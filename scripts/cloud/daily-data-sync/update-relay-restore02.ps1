param([ValidateSet('Prepare','Deploy')][string]$Mode='Prepare',[switch]$DeployApproved)
# Root-only existing new08 function update. No project-wide secret mutation.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Assert-Phase08Relay02Bundle {
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v3';$expected=@{'index.ts'='23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7';'relay.mjs'='0bdc81c5ae05c6356436a4f7688ee7576f07d455525a01dfd8a15891592e4b4c'}
 $item=Get-Item -LiteralPath $root;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'bundle-root'}
 foreach($name in @('index.ts','relay.mjs','source-manifest.json')){$file=Get-Item -LiteralPath (Join-Path $root $name);if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 65536){throw 'bundle-file'};if($name -cne 'source-manifest.json' -and (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected[$name]){throw 'bundle-bytes'}}
 $json=[IO.File]::ReadAllText((Join-Path $root 'source-manifest.json'));$bytes=[Text.Encoding]::UTF8.GetBytes($json);try{$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}finally{[Array]::Clear($bytes)}
 if($hash -cne '8aa0978251a683d24a2877aec3592dfce71354dcd1e2533c6743aec40a947c1f'){throw 'bundle-manifest'}
 return $root
}
function Get-Phase08Relay02StoppedSql {
 return @"
BEGIN READ ONLY;SET LOCAL statement_timeout=10000;
SELECT current_database() AS database,current_user AS principal,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,
 (SELECT count(*)=1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') AS stopped,
 (SELECT count(*)::int FROM daily_data_sync_ops.schedules) AS schedules,
 (SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE (key='phase08-cafe24' AND connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND provider='CAFE24' AND anchor_at='2026-10-14T17:00:00Z' AND cadence_days=1 AND window_minutes=110) OR (key='phase08-google' AND connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900' AND provider='GOOGLE' AND anchor_at='2026-10-14T17:01:00Z' AND cadence_days=7 AND window_minutes=90) OR (key='phase08-meta' AND connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider='META' AND anchor_at='2026-10-14T17:02:00Z' AND cadence_days=7 AND window_minutes=90)) AS expected_schedules,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS jobs,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
 md5(jsonb_build_object('settings',(SELECT jsonb_agg(to_jsonb(x)) FROM daily_data_sync_ops.settings x),'schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY key) FROM daily_data_sync_ops.schedules x),'jobs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY jobid) FROM cron.job x),'attempts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM daily_data_sync_ops.attempts x))::text) AS digest;
COMMIT;
"@
}
function Assert-Phase08Relay02Stopped($Rows){
 if(@($Rows).Count -ne 1){throw 'stopped'};$r=@($Rows)[0]
 if($r.database -cne 'postgres' -or $r.principal -cne 'postgres' -or $r.stopped -isnot [bool] -or -not $r.stopped -or $r.digest -isnot [string] -or $r.digest -cnotmatch '^[a-f0-9]{32}$'){throw 'stopped'}
 foreach($pair in @(@('tables',68),@('schedules',3),@('expected_schedules',3),@('jobs',149),@('live_leases',0))){$name=$pair[0];if(($r.$name -isnot [int] -and $r.$name -isnot [long]) -or $r.$name -ne $pair[1]){throw 'stopped'}}
 return $r.digest
}
function Assert-Phase08Relay02Metadata($Functions,$Secrets,[int]$Version,[string]$Bundle){
 if(@($Functions).Count -ne 1 -or @($Secrets).Count -ne 9){throw 'metadata'};$r=@($Functions)[0]
 if($r.id -cne '42f4d9e1-eddb-4b00-b574-399a489f78b4' -or $r.slug -cne 'phase08-scheduled-relay' -or ($r.version -isnot [int] -and $r.version -isnot [long]) -or $r.version -ne $Version -or $r.status -cne 'ACTIVE' -or $r.verify_jwt -isnot [bool] -or $r.verify_jwt -or $r.ezbr_sha256 -cne $Bundle){throw 'metadata'}
 $names=@();foreach($secret in $Secrets){if($secret.name -isnot [string] -or $secret.name -cnotmatch '^(PHASE08_RELAY_BASIC_PASSWORD|PHASE08_RELAY_MACHINE_TOKEN|SUPABASE_[A-Z0-9_]{1,64})$' -or $secret.value -isnot [string] -or $secret.value -cnotmatch '^[a-f0-9]{64}$' -or $secret.name -cin $names){throw 'secret-metadata'};$names+=@($secret.name)}
 if('PHASE08_RELAY_BASIC_PASSWORD' -cnotin $names -or 'PHASE08_RELAY_MACHINE_TOKEN' -cnotin $names){throw 'secret-metadata'}
}
if($MyInvocation.InvocationName -cne '.'){
 $headers=$null;$token=$null;$stage='PREPARE';$postStarted=$false
 try{
  if($Mode -ceq 'Prepare'){$node=Get-Command node -ErrorAction Stop;$result=& $node.Source (Join-Path $PSScriptRoot 'prepare-relay-restore02.mjs');if($LASTEXITCODE -ne 0){throw 'prepare'};$bundle=Assert-Phase08Relay02Bundle;$result;exit 0}
  if(-not $DeployApproved){throw 'explicit-deploy-required'}
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-02-actual-20261015.json';$bundle=Assert-Phase08Relay02Bundle
  $stage='STOPPED_BASELINE';$sql=Get-Phase08Relay02StoppedSql;$beforeDigest=Assert-Phase08Relay02Stopped @(Invoke-Phase08Management -Action Query -Query $sql)
  $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)};$base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
  function Get-Phase08Relay02Metadata([string]$Path){if($Path -cnotin @('/functions','/secrets')){throw 'route'};$r=Invoke-WebRequest -Uri ($base+$Path) -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck;if([int]$r.StatusCode -ne 200 -or $r.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 1048576){throw 'metadata-http'};return ($r.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15)}
  $stage='EDGE_V2_BASELINE';$functions=@(Get-Phase08Relay02Metadata '/functions');$secrets=@(Get-Phase08Relay02Metadata '/secrets');Assert-Phase08Relay02Metadata $functions $secrets 2 'f998dd2160b7d65dc8954f984c21b5432a9860250a0ffc5f2bf4da88b7503492'
  $stage='IMMEDIATE_STOPPED';$fresh=Assert-Phase08Relay02Stopped @(Invoke-Phase08Management -Action Query -Query $sql);if($fresh -cne $beforeDigest){throw 'baseline-change'}
  $stage='DEPLOY';$form=@{file=@((Get-Item -LiteralPath (Join-Path $bundle 'index.ts')),(Get-Item -LiteralPath (Join-Path $bundle 'relay.mjs')));metadata='{"entrypoint_path":"index.ts","name":"phase08-scheduled-relay","verify_jwt":false}'};$postStarted=$true
  $reply=Invoke-WebRequest -Uri ($base+'/functions/deploy?slug=phase08-scheduled-relay') -Headers $headers -Method Post -Form $form -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 201 -or $reply.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($reply.Content) -gt 1048576){throw 'deployment-outcome'};$deployed=$reply.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15
  if($deployed.ezbr_sha256 -isnot [string] -or $deployed.ezbr_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $deployed.ezbr_sha256 -ceq 'f998dd2160b7d65dc8954f984c21b5432a9860250a0ffc5f2bf4da88b7503492'){throw 'deployment-bundle'}
  $stage='READBACK';$after=@(Get-Phase08Relay02Metadata '/functions');$afterSecrets=@(Get-Phase08Relay02Metadata '/secrets');Assert-Phase08Relay02Metadata @($deployed) $afterSecrets 3 $deployed.ezbr_sha256;Assert-Phase08Relay02Metadata $after $afterSecrets 3 $deployed.ezbr_sha256
  foreach($old in $secrets){$match=@($afterSecrets|Where-Object {$_.name -ceq $old.name});if($match.Count -ne 1 -or $match[0].value -cne $old.value){throw 'secret-change'}}
  $afterDigest=Assert-Phase08Relay02Stopped @(Invoke-Phase08Management -Action Query -Query $sql);if($afterDigest -cne $beforeDigest){throw 'database-change'}
  $evidence=@{state='PHASE08_RELAY_02_UPDATED';classification='ACTUAL_ISOLATED_NORMAL_CLOCK_RELAY_UPDATE';projectRef='ehnfrrmbkvlsbpvqcvkr';id=$deployed.id;version=3;sourceSha='8aa0978251a683d24a2877aec3592dfce71354dcd1e2533c6743aec40a947c1f';bundleSha=$deployed.ezbr_sha256;allNineSecretDigestsPreserved=$true;secretWrites=0;databaseWrites=0;providerCalls=0;schedulerRemainsStopped=$true;inspectionOnlyPrevious10am=$true;normalClock='02:00/02:01/02:02 Asia/Seoul';observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $evidence $output;$evidence|ConvertTo-Json -Depth 4 -Compress
 }catch{@{state='PHASE08_RELAY_02_UPDATE_FAILED';stage=$stage;outcomeUncertain=$postStarted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$functions=$null;$secrets=$null;$after=$null;$afterSecrets=$null;$reply=$null;$deployed=$null;$form=$null}
}
