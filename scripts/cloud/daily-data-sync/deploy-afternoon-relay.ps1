param([Parameter(Mandatory)][ValidateSet('test','normal')][string]$Phase,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/update-relay-restore02.ps1"
$stage='APPROVAL';$submitted=$false;$headers=$null;$token=$null
try{
 if(-not $ExecuteApproved){throw 'approval'}
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-relay-'+$Phase+'-actual-20261015.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-relay-'+$Phase+'-attempt-20261015.json')
 $root=if($Phase -ceq 'test'){'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v4'}else{'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v3'}
 $sourceSha=if($Phase -ceq 'test'){'4e51a0e0bbd200876cd2922f422cc1f3aaed0634d882565f6677ef97a9e49a92'}else{'8aa0978251a683d24a2877aec3592dfce71354dcd1e2533c6743aec40a947c1f'}
 $expectedRelay=if($Phase -ceq 'test'){'e7c2975256fbceb766c06747d941b289b3bde78bd17aca7bece2146ae2a831d5'}else{'0bdc81c5ae05c6356436a4f7688ee7576f07d455525a01dfd8a15891592e4b4c'}
 $stage='PUBLIC_IMMUTABLE_SOURCE';$folder=Get-Item -LiteralPath $root;if(-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'bundle'}
 foreach($pair in @(@('index.ts','23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7'),@('relay.mjs',$expectedRelay),@('source-manifest.json',$sourceSha))){$item=Get-Item -LiteralPath (Join-Path $root $pair[0]);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536 -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'bundle-bytes'}}
 $stage='STOPPED_DATABASE';$db=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND origin='https://phase08-daily-data-sync-production.up.railway.app' AND target_id='phase08-full-app') AS stopped,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs;COMMIT;")
 if($db.Count -ne 1 -or $db[0].database -cne 'postgres' -or $db[0].principal -cne 'postgres' -or $db[0].stopped -isnot [bool] -or -not $db[0].stopped -or ($db[0].leases -isnot [int] -and $db[0].leases -isnot [long]) -or $db[0].leases -ne 0 -or ($db[0].jobs -isnot [int] -and $db[0].jobs -isnot [long]) -or $db[0].jobs -ne 149){throw 'database'}
 $snapshot=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='state-sql'}
 if($snapshot.state -cne 'PHASE08_AFTERNOON_STATE_SQL' -or $snapshot.sql -isnot [string] -or -not $snapshot.sql.StartsWith('BEGIN READ ONLY;')){throw 'snapshot'}
 $beforeState=@(Invoke-Phase08Management -Action Query -Query $snapshot.sql);if($beforeState.Count -ne 1){throw 'state'}
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)};$base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
 function Get-Phase08AfternoonEdgeMetadata([string]$Path){if($Path -cnotin @('/functions','/secrets')){throw 'route'};$r=Invoke-WebRequest -Uri ($base+$Path) -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck;if([int]$r.StatusCode -ne 200 -or $r.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 1048576){throw 'metadata'};return ($r.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15)}
 $stage='CURRENT_EDGE_AND_SECRET_DIGESTS';$functions=@(Get-Phase08AfternoonEdgeMetadata '/functions');$secrets=@(Get-Phase08AfternoonEdgeMetadata '/secrets')
 $oldVersion=if($Phase -ceq 'test'){3}else{4};$oldBundle='4d1f31ac23eb3e6479eb747546ccee41e263c688ed9d3c0a2526e1fdf6af05ad'
 if($Phase -ceq 'normal'){$oldEvidence=[IO.File]::ReadAllText('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-relay-test-actual-20261015.json')|ConvertFrom-Json -AsHashtable -DateKind String;if($oldEvidence.state -cne 'PHASE08_AFTERNOON_RELAY_VERIFIED' -or $oldEvidence.version -ne 4 -or $oldEvidence.bundleSha -cnotmatch '^[a-f0-9]{64}$'){throw 'old-edge-proof'};$oldBundle=$oldEvidence.bundleSha}
 Assert-Phase08Relay02Metadata $functions $secrets $oldVersion $oldBundle
 $null=Write-Phase08SchedulerPublicEvidence @{classification='EXPLICIT_TEST_EDGE_CHANGE_PLANNED';phase=$Phase;sourceSha=$sourceSha;observedAt=[DateTimeOffset]::UtcNow.ToString('o');secretWrites=0;providerRequests=0} $marker
 $stage='SINGLE_EXISTING_FUNCTION_DEPLOY';$form=@{file=@((Get-Item -LiteralPath (Join-Path $root 'index.ts')),(Get-Item -LiteralPath (Join-Path $root 'relay.mjs')));metadata='{"entrypoint_path":"index.ts","name":"phase08-scheduled-relay","verify_jwt":false}'};$submitted=$true
 $reply=Invoke-WebRequest -Uri ($base+'/functions/deploy?slug=phase08-scheduled-relay') -Headers $headers -Method Post -Form $form -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
 if([int]$reply.StatusCode -ne 201 -or $reply.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($reply.Content) -gt 1048576){throw 'outcome'};$deployed=$reply.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15
 if($deployed.ezbr_sha256 -isnot [string] -or $deployed.ezbr_sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'bundle-hash'}
 $stage='READBACK';$after=@(Get-Phase08AfternoonEdgeMetadata '/functions');$afterSecrets=@(Get-Phase08AfternoonEdgeMetadata '/secrets');Assert-Phase08Relay02Metadata @($deployed) $afterSecrets ($oldVersion+1) $deployed.ezbr_sha256;Assert-Phase08Relay02Metadata $after $afterSecrets ($oldVersion+1) $deployed.ezbr_sha256
 foreach($old in $secrets){$row=@($afterSecrets|Where-Object {$_.name -ceq $old.name});if($row.Count -ne 1 -or $row[0].value -cne $old.value){throw 'secret-change'}}
 $afterState=@(Invoke-Phase08Management -Action Query -Query $snapshot.sql);if($afterState.Count -ne 1){throw 'state-after'}
 foreach($name in @('settingsMd5','schedulesMd5','jobsMd5')){if($beforeState[0].$name -isnot [string] -or $beforeState[0].$name -cnotmatch '^[a-f0-9]{32}$' -or $afterState[0].$name -cne $beforeState[0].$name){throw 'database-change'}}
 $out=@{state='PHASE08_AFTERNOON_RELAY_VERIFIED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');projectRef='ehnfrrmbkvlsbpvqcvkr';id=$deployed.id;version=$oldVersion+1;sourceSha=$sourceSha;bundleSha=$deployed.ezbr_sha256;allNineSecretDigestsPreserved=$true;secretWrites=0;databaseWrites=0;providerRequests=0;operatingChanges=0;globalStopped=$true}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_AFTERNOON_RELAY_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$token=$null;$reply=$null;$form=$null;$secrets=$null;$afterSecrets=$null}
