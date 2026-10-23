param([Parameter(Mandatory)][ValidateSet('test','normal')][string]$Phase,[switch]$ExecuteApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/update-relay-restore02.ps1"
$stage='APPROVAL';$submitted=$false;$headers=$null;$token=$null
try{
 if(-not $ExecuteApproved){throw 'approval'}
 Import-Phase08SchedulerChildDefinitions
 $pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df'){throw 'source'};$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$graph=Get-Phase08SchedulerGraphState $context $pins
 if($graph.featureEnabled -isnot [bool] -or -not $graph.featureEnabled -or $graph.scheduleEnabled -isnot [bool] -or -not $graph.scheduleEnabled){throw 'runtime-flags'}
 $profile=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-profile-bridge.mjs" @{action='definitions';phase=$Phase}
 if($profile.state -cne 'PHASE08_OCTOBER16_DEFINITIONS' -or @($profile.definitions).Count -ne 3 -or @($graph.appSchedules).Count -ne 3){throw 'definitions'}
 foreach($d in $profile.definitions){$found=@($graph.appSchedules|Where-Object {$_.key -ceq $d.key});if($found.Count -ne 1 -or $found[0].connectionId -cne $d.connectionId -or $found[0].anchorAt -cne $d.anchorAt -or ($found[0].windowMinutes -isnot [int] -and $found[0].windowMinutes -isnot [long]) -or $found[0].windowMinutes -ne $d.windowMinutes){throw 'definitions'}}
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-relay-'+$Phase+'-actual-20261016.json')
 $marker=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-relay-'+$Phase+'-attempt-20261016.json')
 $root=if($Phase -ceq 'test'){'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261016-repeat-test'}else{'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261016-repeat-normal'}
 $sourceSha=if($Phase -ceq 'test'){'e3260cf730b3fa06bab17cf566ffefb8817408af1fd91a12b2d12a227f4be74c'}else{'ef35a2b91e1a130b215fe0676d90cff4f3b55b15562ab0a10ca2ca0304bfbde8'}
 $expectedRelay=if($Phase -ceq 'test'){'b60d92b96ec2bafe471a10d4f39befe0dc157d99ca7c066595fab3236cdcd105'}else{'4ca71daecd13c46488906cdabb7e5ba876c10c146e0c72f938576d89dea681ee'}
 $manifestSha=if($Phase -ceq 'test'){'0e5e8edd17586dc9620d7a76b5129bc08fbdb48a140745508dba9513e28c8a98'}else{'74e6a0ebbbc82539f01953d6af73670c5dd5bdf06a3b12e12856701a6b1980d5'}
 $stage='PUBLIC_IMMUTABLE_SOURCE';$folder=Get-Item -LiteralPath $root;if(-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'bundle'}
 foreach($pair in @(@('index.ts','23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7'),@('relay.mjs',$expectedRelay),@('source-manifest.json',$manifestSha))){$item=Get-Item -LiteralPath (Join-Path $root $pair[0]);if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536 -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'bundle-bytes'}}
 $stage='STOPPED_DATABASE';$db=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT current_database() AS database,current_user AS principal,(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND origin='https://phase08-daily-data-sync-production.up.railway.app' AND target_id='phase08-full-app') AS stopped,(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs;COMMIT;")
 if($db.Count -ne 1 -or $db[0].database -cne 'postgres' -or $db[0].principal -cne 'postgres' -or $db[0].stopped -isnot [bool] -or -not $db[0].stopped -or ($db[0].leases -isnot [int] -and $db[0].leases -isnot [long]) -or $db[0].leases -ne 0 -or ($db[0].jobs -isnot [int] -and $db[0].jobs -isnot [long]) -or $db[0].jobs -ne 149){throw 'database'}
 $snapshot=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-profile-bridge.mjs" @{action='state-sql'}
 if($snapshot.state -cne 'PHASE08_OCTOBER16_STATE_SQL' -or $snapshot.sql -isnot [string] -or -not $snapshot.sql.StartsWith('BEGIN READ ONLY;')){throw 'snapshot'}
 $beforeState=@(Invoke-Phase08Management -Action Query -Query $snapshot.sql);if($beforeState.Count -ne 1){throw 'state'}
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)};$base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
 function Get-Phase08AfternoonEdgeMetadata([string]$Path){if($Path -cnotin @('/functions','/secrets')){throw 'route'};$r=Invoke-WebRequest -Uri ($base+$Path) -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck;if([int]$r.StatusCode -ne 200 -or $r.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 1048576){throw 'metadata'};return ($r.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15)}
 $stage='CURRENT_EDGE_AND_SECRET_DIGESTS';$functions=@(Get-Phase08AfternoonEdgeMetadata '/functions');$secrets=@(Get-Phase08AfternoonEdgeMetadata '/secrets')
 $oldVersion=if($Phase -ceq 'test'){5}else{6};$receiptPath=if($Phase -ceq 'test'){'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-relay-test-actual-20261016.json'}else{'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-relay-test-actual-20261016.json'}
 $receiptFile=Get-Item -LiteralPath $receiptPath;if($receiptFile.PSIsContainer -or ($receiptFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $receiptFile.Length -gt 16384){throw 'old-edge-file'}
 $oldEvidence=[IO.File]::ReadAllText($receiptFile.FullName)|ConvertFrom-Json -AsHashtable -DateKind String
 if($oldEvidence.state -cne 'PHASE08_OCTOBER16_RELAY_VERIFIED' -or $oldEvidence.phase -cne 'test' -or ($oldEvidence.version -isnot [int] -and $oldEvidence.version -isnot [long]) -or $oldEvidence.version -ne $oldVersion -or $oldEvidence.bundleSha -isnot [string] -or $oldEvidence.bundleSha -cnotmatch '^[a-f0-9]{64}$' -or $oldEvidence.allNineSecretDigestsPreserved -isnot [bool] -or -not $oldEvidence.allNineSecretDigestsPreserved){throw 'old-edge-proof'};$oldBundle=$oldEvidence.bundleSha
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
 $out=@{state='PHASE08_OCTOBER16_RELAY_VERIFIED';phase=$Phase;observedAt=[DateTimeOffset]::UtcNow.ToString('o');projectRef='ehnfrrmbkvlsbpvqcvkr';id=$deployed.id;version=$oldVersion+1;sourceSha=$sourceSha;bundleSha=$deployed.ezbr_sha256;allNineSecretDigestsPreserved=$true;secretWrites=0;databaseWrites=0;providerRequests=0;operatingChanges=0;globalStopped=$true}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_OCTOBER16_RELAY_FAILED';stage=$stage;outcomeUncertain=$submitted;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$token=$null;$reply=$null;$form=$null;$secrets=$null;$afterSecrets=$null;$context=$null;$graph=$null;$pins=$null}
