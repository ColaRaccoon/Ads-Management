param([switch]$ProbeApproved)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Get-Phase08LoadedDefinitionProbeSql {
 $path=Join-Path $PSScriptRoot 'probe-relay-status.ps1';$file=Get-Item -LiteralPath $path
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 32768 -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'ef1c0cba075603fd2c01abb21280a38d84e610b2e076a68ecda991b729693c73'){throw 'template-sha'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
 $assignments=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and $_.Left.VariablePath.UserPath -ceq 'template'})
 if($errors.Count -ne 0 -or $assignments.Count -ne 1 -or $assignments[0].Right -isnot [Management.Automation.Language.CommandExpressionAst] -or $assignments[0].Right.Expression -isnot [Management.Automation.Language.StringConstantExpressionAst] -or $assignments[0].Right.Expression.StringConstantType -ne [Management.Automation.Language.StringConstantType]::SingleQuotedHereString){throw 'template-ast'}
 $sql=$assignments[0].Right.Expression.Value.Replace('__KEY__','phase08-meta').Replace('__DUE__','2026-10-15T06:00:00.000Z').Replace('__FIRST__','2026-10-08').Replace('__DAYS__','7')
 $sql=$sql.Replace('validExpiredSummary','newDefinitionLoaded').Replace('"newDefinitionLoaded":false,','"newDefinitionLoaded":false,"oldDefinitionStillLoaded":false,')
 $start=$sql.IndexOf(' IF res.status<>200 OR');$end=$sql.IndexOf(" PERFORM set_config('daily_data_sync.closed_status_summary',summary::text,true);",$start)
 if($start -lt 0 -or $end -le $start){throw 'template-response'}
 $response=@'
 IF res.status NOT IN(200,400) OR res.content IS NULL OR octet_length(res.content)>8192 THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
 body:=res.content::jsonb;
 IF jsonb_typeof(body)<>'object' OR NOT EXISTS(SELECT 1 FROM unnest(res.headers) h WHERE lower(h.field)='cache-control' AND h.value LIKE '%no-store%') THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
 IF res.status=400 AND jsonb_typeof(body->'code')='string' AND body->>'code'='RUN_LIMIT_EXCEEDED' AND (SELECT count(*) FROM jsonb_object_keys(body))=1 THEN
  summary:=jsonb_build_object('httpStatus',400,'newDefinitionLoaded',true,'oldDefinitionStillLoaded',false,'noStore',true,'code','LOADED_COLLECTION');
 ELSIF res.status=200 AND (SELECT count(*) FROM jsonb_object_keys(body))=7 AND body->>'scheduleKey'='phase08-meta' AND body->>'scheduledFor'='2026-10-15T06:00:00.000Z' AND body->>'fromDate'='2026-10-08' AND body->>'toDate'='2026-10-14' AND body->>'status'='EXPIRED' AND body->'completedUnits'='0'::jsonb AND body->'totalUnits'='7'::jsonb THEN
  summary:=jsonb_build_object('httpStatus',200,'newDefinitionLoaded',false,'oldDefinitionStillLoaded',true,'noStore',true,'code','STALE_OUTAGE');
 ELSE RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED'; END IF;
'@
 $sql=$sql.Substring(0,$start)+$response+"`n"+$sql.Substring($end)
 $guard=@'
 IF clock_timestamp()<timestamptz '2026-10-15T06:38:00Z' OR clock_timestamp()>=timestamptz '2026-10-15T07:00:00Z'
 OR (SELECT count(*) FROM daily_data_sync_ops.settings)<>1 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app')
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
 OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider='META' AND anchor_at=timestamptz '2026-10-15T07:00:00Z' AND window_minutes=90 AND cadence_days=7)
 THEN RAISE EXCEPTION 'PHASE08_STATUS_PROBE_REJECTED';END IF;
'@
 $needle=' PERFORM extensions.http_reset_curlopt();';$first=$sql.IndexOf($needle);if($first -lt 0){throw 'template-reset'};$sql=$sql.Insert($first,$guard+"`n")
 $sql=$sql.Replace('(s->>''newDefinitionLoaded'')::boolean AS "newDefinitionLoaded",','(s->>''newDefinitionLoaded'')::boolean AS "newDefinitionLoaded",(s->>''oldDefinitionStillLoaded'')::boolean AS "oldDefinitionStillLoaded",')
 if(($sql.Split("SELECT * INTO STRICT res FROM extensions.http(").Count-1) -ne 1 -or $sql -notmatch 'EXCEPTION WHEN query_canceled THEN' -or $sql -match '__[A-Z]+__'){throw 'template-final'}
 return $sql
}
function Get-Phase08LoadedDefinitionBaselineSql {
 return @'
BEGIN READ ONLY;SET LOCAL statement_timeout=15000;SET LOCAL TIME ZONE 'UTC';
DO $snapshot$ DECLARE r record; value text; all_rows text:='';BEGIN
 FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' AND tablename NOT IN('security_rate_limit_buckets','local_edge_request_nonces') ORDER BY tablename LOOP
 EXECUTE format('SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text),'''' ORDER BY md5(to_jsonb(t)::text)),'''')) FROM phase08_meta_ads.%I t',r.tablename) INTO value;
 all_rows:=all_rows||r.tablename||':'||value||';';END LOOP;
 PERFORM set_config('daily_data_sync.loaded_probe_business',md5(all_rows),true);END $snapshot$;
SELECT current_database()='postgres' AND current_user='postgres' AND current_setting('transaction_read_only')='on' AND to_regnamespace('storage_renewal_ops') IS NULL AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)=68 AS "identityVerified",
 (SELECT count(*)=1 FROM daily_data_sync_ops.settings) AND EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') AS stopped,
 (SELECT count(*)=3 FROM daily_data_sync_ops.schedules) AND (SELECT count(*)=3 FROM daily_data_sync_ops.schedules WHERE (key='phase08-cafe24' AND connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND provider='CAFE24' AND anchor_at=timestamptz '2026-10-15T06:40:00Z' AND window_minutes=110 AND cadence_days=1) OR (key='phase08-google' AND connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900' AND provider='GOOGLE' AND anchor_at=timestamptz '2026-10-14T17:01:00Z' AND window_minutes=90 AND cadence_days=7) OR (key='phase08-meta' AND connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider='META' AND anchor_at=timestamptz '2026-10-15T07:00:00Z' AND window_minutes=90 AND cadence_days=7)) AS "collectionProfileVerified",
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS "liveLeases",
 md5(jsonb_build_object('business',current_setting('daily_data_sync.loaded_probe_business'),'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY singleton) FROM daily_data_sync_ops.settings s),'schedules',(SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM daily_data_sync_ops.schedules s),'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM daily_data_sync_ops.attempts a),'jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY jobid) FROM cron.job j),'vault',(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM vault.secrets v))::text) AS digest;ROLLBACK;
'@
}
function ConvertTo-Phase08LoadedDefinitionBaseline($Rows){
 if(@($Rows).Count -ne 1){throw 'baseline-rows'};$r=@($Rows)[0];$names=@('identityVerified','stopped','collectionProfileVerified','liveLeases','digest');$keys=if($r -is [Collections.IDictionary]){@($r.Keys)}else{@($r.PSObject.Properties.Name)}
 if($keys.Count -ne 5 -or @($names|Where-Object {$_ -cnotin $keys}).Count -ne 0){throw 'baseline-shape'}
 foreach($name in @('identityVerified','stopped','collectionProfileVerified')){if($r.$name -isnot [bool] -or -not $r.$name){throw 'baseline-bool'}}
 if(($r.liveLeases -isnot [int] -and $r.liveLeases -isnot [long]) -or $r.liveLeases -ne 0 -or $r.digest -isnot [string] -or $r.digest -cnotmatch '^[a-f0-9]{32}$'){throw 'baseline-state'}
 return $r.digest
}
function ConvertTo-Phase08LoadedDefinitionResult($Rows){
 if(@($Rows).Count -ne 1){throw 'result-rows'};$r=@($Rows)[0];$names=@('httpStatus','newDefinitionLoaded','oldDefinitionStillLoaded','noStore','code');$keys=if($r -is [Collections.IDictionary]){@($r.Keys)}else{@($r.PSObject.Properties.Name)}
 if($keys.Count -ne 5 -or @($names|Where-Object {$_ -cnotin $keys}).Count -ne 0 -or $r.code -isnot [string] -or $r.code -cnotin @('LOADED_COLLECTION','STALE_OUTAGE','QUERY_CANCELED','PROBE_FAILED')){throw 'result-shape'}
 foreach($name in @('newDefinitionLoaded','oldDefinitionStillLoaded','noStore')){if($r.$name -isnot [bool]){throw 'result-bool'}}
 if($r.code -ceq 'LOADED_COLLECTION'){if(($r.httpStatus -isnot [int] -and $r.httpStatus -isnot [long]) -or $r.httpStatus -ne 400 -or -not $r.newDefinitionLoaded -or $r.oldDefinitionStillLoaded -or -not $r.noStore){throw 'result-loaded'}}
 elseif($r.code -ceq 'STALE_OUTAGE'){if(($r.httpStatus -isnot [int] -and $r.httpStatus -isnot [long]) -or $r.httpStatus -ne 200 -or $r.newDefinitionLoaded -or -not $r.oldDefinitionStillLoaded -or -not $r.noStore){throw 'result-stale'}}
 elseif($null -ne $r.httpStatus -or $r.newDefinitionLoaded -or $r.oldDefinitionStillLoaded -or $r.noStore){throw 'result-failure'}
 return @{httpStatus=$r.httpStatus;newDefinitionLoaded=$r.newDefinitionLoaded;oldDefinitionStillLoaded=$r.oldDefinitionStillLoaded;noStore=$r.noStore;code=$r.code}
}
function Assert-Phase08KnownPreviousOutage($Pins){
 $file=Get-Item -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-outage-warning-actual-20261015.json'
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 16384){throw 'known-outage-file'}
 $value=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10
 $expected=@('2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14')
 if($value.state -cne 'PHASE08_OUTAGE_WARNING_VERIFIED' -or $value.sourceSha -cne $Pins.sourceSha -or $value.deploymentId -isnot [string] -or $value.deploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $value.deploymentId -ceq $Pins.deploymentId -or $value.scheduledFor -cne '2026-10-15T06:00:00.000Z' -or $value.warningCode -cne 'MISSING_SCHEDULE' -or $value.warningStatus -cne 'EXPIRED' -or $value.missingDates -isnot [array] -or ($value.missingDates -join '|') -cne ($expected -join '|') -or $value.collectionDigestUnchanged -isnot [bool] -or -not $value.collectionDigestUnchanged -or $value.automaticBackfill -isnot [bool] -or $value.automaticBackfill -or $value.observedAt -isnot [string]){throw 'known-outage-proof'}
 $observed=[DateTimeOffset]::MinValue;if(-not [DateTimeOffset]::TryParse($value.observedAt,[ref]$observed) -or $observed -lt [DateTimeOffset]'2026-10-15T06:38:00Z' -or $observed -gt [DateTimeOffset]::UtcNow -or ([DateTimeOffset]::UtcNow-$observed).TotalMinutes -gt 20){throw 'known-outage-age'}
}
function Assert-Phase08ActiveAcceleratedRelay {
 $file=Get-Item -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-relay-test-actual-20261015.json'
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 16384){throw 'edge-proof-file'}
 $proof=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 10
 if($proof.state -cne 'PHASE08_AFTERNOON_RELAY_VERIFIED' -or $proof.phase -cne 'test' -or $proof.sourceSha -cne '4e51a0e0bbd200876cd2922f422cc1f3aaed0634d882565f6677ef97a9e49a92' -or ($proof.version -isnot [int] -and $proof.version -isnot [long]) -or $proof.version -ne 4 -or $proof.bundleSha -isnot [string] -or $proof.bundleSha -cnotmatch '^[a-f0-9]{64}$'){throw 'edge-proof'}
 $token=$null;$headers=$null;$reply=$null;$functions=$null
 try{
  $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
  $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/functions' -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 200 -or $reply.Content -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($reply.Content) -gt 1048576){throw 'edge-read'}
  $functions=@($reply.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15);if($functions.Count -ne 1){throw 'edge-count'};$f=$functions[0]
  if($f.id -cne '42f4d9e1-eddb-4b00-b574-399a489f78b4' -or $f.slug -cne 'phase08-scheduled-relay' -or ($f.version -isnot [int] -and $f.version -isnot [long]) -or $f.version -ne 4 -or $f.status -cne 'ACTIVE' -or $f.verify_jwt -isnot [bool] -or $f.verify_jwt -or $f.ezbr_sha256 -cne $proof.bundleSha){throw 'edge-identity'}
 }finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$reply=$null;$functions=$null;$proof=$null}
}
if($MyInvocation.InvocationName -cne '.'){
 $stage='APPROVAL';$context=$null;$graph=$null;$prepared=$null;$rows=$null;$out=$null;$submitted=$false
 try{
  if(-not $ProbeApproved){throw 'explicit-probe-required'};Import-Phase08SchedulerChildDefinitions
  $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/afternoon-collection-runtime-loaded-probe-actual-20261015.json'
  $stage='REVIEWED_IDENTITY';$pins=Get-Phase08SchedulerPins;if($pins.sourceSha -cne '6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde'){throw 'source'}
  $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins;$graph=Get-Phase08SchedulerGraphState $context $pins
  $defs=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-profile-bridge.mjs" @{action='definitions';phase='collection'}
  if($defs.state -cne 'PHASE08_AFTERNOON_DEFINITIONS'){throw 'definitions'};$null=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($defs.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@()}
  $stage='KNOWN_PREVIOUS_OUTAGE';Assert-Phase08KnownPreviousOutage $pins
  $stage='ACTIVE_EDGE_V4_FORWARDING';Assert-Phase08ActiveAcceleratedRelay
  $stage='STOPPED_COLLECTION_BASELINE';$baselineSql=Get-Phase08LoadedDefinitionBaselineSql;$before=ConvertTo-Phase08LoadedDefinitionBaseline @(Invoke-Phase08Management -Action Query -Query $baselineSql)
  $stage='SINGLE_NATIVE_CLOSED_STATUS';$sql=Get-Phase08LoadedDefinitionProbeSql;$submitted=$true;$rows=@(Invoke-Phase08Management -Action Query -Query $sql);$summary=ConvertTo-Phase08LoadedDefinitionResult $rows
  $stage='UNCHANGED_COLLECTION_DIGEST';$after=ConvertTo-Phase08LoadedDefinitionBaseline @(Invoke-Phase08Management -Action Query -Query $baselineSql);if($before -cne $after){throw 'collection-changed'}
  $out=@{state='PHASE08_COLLECTION_RUNTIME_DEFINITION_PROBE';classification='ACTUAL_READONLY_NATIVE_DB_EDGE_APP_CLOSED_STATUS';verified=$summary.newDefinitionLoaded;httpStatus=$summary.httpStatus;code=$summary.code;newDefinitionLoaded=$summary.newDefinitionLoaded;oldDefinitionStillLoaded=$summary.oldDefinitionStillLoaded;noStore=$summary.noStore;collectionDigestUnchanged=$true;knownPreviousOutageDefinitionVerified=$true;activeReviewedRelayV4Verified=$true;loadedDefinitionInference='KNOWN_OUTAGE_TO_COLLECTION_ONLY';sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');providerRequests=0;collectionDataWrites=0;databaseWritesScope='COLLECTION_DATA_ONLY';transportSecurityWritesExpected=$true;transportSecurityTables=@('security_rate_limit_buckets','local_edge_request_nonces');automaticBackfill=$false;regularScheduleSuccess=$false}
  $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress
  if(-not $out.verified){exit 1}
 }catch{@{state='PHASE08_COLLECTION_RUNTIME_PROBE_FAILED';stage=$stage;statusQuerySubmitted=$submitted;providerRequests=0;collectionDataWrites=0;databaseWritesScope='COLLECTION_DATA_ONLY';transportSecurityWritesExpected=$true;transportSecurityTables=@('security_rate_limit_buckets','local_edge_request_nonces');retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
 finally{$context=$null;$graph=$null;$prepared=$null;$rows=$null;$out=$null;$sql=$null}
}
