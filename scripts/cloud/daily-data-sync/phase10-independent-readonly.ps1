param([ValidatePattern('^[a-z0-9-]+$')][string]$Label='baseline')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='INITIALIZE';$v=$null;$context=$null
function Hash-Text([string]$Text){return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()}
function Import-ReadonlySnapshot {
 $tokens=$null;$errors=$null
 $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'recover-october19.ps1'),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'snapshot-parse'}
 $fn=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Snapshot'})
 if($fn.Count -ne 1){throw 'snapshot-definition'}
 $body=$fn[0].Body.Extent.Text.Substring(1,$fn[0].Body.Extent.Text.Length-2)
 # Load this reviewed READ ONLY definition only; never execute the source entrypoint.
 Set-Item -LiteralPath 'function:script:Independent-Snapshot' -Value ([scriptblock]::Create($body))
}
try {
 Import-Phase08SchedulerChildDefinitions;Import-ReadonlySnapshot
 $stage='CONTEXT_TARGET';$pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson
 Assert-Phase08SchedulerContext $context $pins
 if($pins.identity.projectId -cne 'd72f4256-8632-437a-9dae-9b5d96736fc7' -or $pins.identity.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $pins.identity.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c'){throw 'isolated-target'}
 $stage='GRAPH_READ';$r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id services{edges{node{id}}}} variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status meta} activeDeployments{id status}}}' @{p=$pins.identity.projectId;e=$pins.identity.environmentId;s=$pins.identity.serviceId}
 $v=$r.variables;$svc=$r.serviceInstance
 if($r.project.id -cne $pins.identity.projectId -or @($r.project.services.edges|Where-Object {$_.node.id -ceq $pins.identity.serviceId}).Count -ne 1 -or $svc.serviceId -cne $pins.identity.serviceId -or $svc.environmentId -cne $pins.identity.environmentId){throw 'graph-target'}
 if($v.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $v.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated'){throw 'data-target'}
 $stage='JWT_METADATA';$part=$v.SUPABASE_STORAGE_ACCESS_TOKEN.Split('.')[1].Replace('-','+').Replace('_','/')
 $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.PadRight($part.Length+(4-$part.Length%4)%4,'=')))|ConvertFrom-Json
 if($claims.role -cne 'phase08_storage_app'){throw 'storage-role'}
 $expires=[DateTimeOffset]::FromUnixTimeSeconds($claims.exp)
 $stage='VARIABLE_HASHES';$hashes=[ordered]@{};$exceptToken=[ordered]@{}
 foreach($key in @($v.Keys|Sort-Object)){$hashes[$key]=Hash-Text ([string]$v[$key]);if($key -cne 'SUPABASE_STORAGE_ACCESS_TOKEN'){$exceptToken[$key]=$v[$key]}}
 $stage='SNAPSHOT_READ';$snapshot=Independent-Snapshot
 $sql=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout=15000;
DO $independent_table_hashes$ DECLARE r record;d text;n bigint;values_json jsonb:='[]';BEGIN
FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x',r.tablename) INTO n,d;
values_json:=values_json||jsonb_build_array(jsonb_build_object('table',r.tablename,'rows',n,'md5',d));END LOOP;
PERFORM set_config('daily_data_sync.phase10_independent_tables',values_json::text,true);END $independent_table_hashes$;
SELECT current_setting('daily_data_sync.phase10_independent_tables')::json AS table_digests,
(SELECT coalesce(json_agg(json_build_object('provider',provider::text,'enabled',enabled,'accessState',access_state::text,'credentialExpiresAt',credential_expires_at) ORDER BY provider::text),'[]'::json) FROM phase08_meta_ads.source_connections) AS connections,
(SELECT coalesce(json_agg(json_build_object('provider',c.provider::text,'from',r.from_date::text,'to',r.to_date::text,'status',r.status::text,'fetched',r.rows_fetched,'published',r.rows_published,'error',r.safe_error_code) ORDER BY c.provider::text,r.started_at DESC),'[]'::json) FROM phase08_meta_ads.sync_runs r JOIN phase08_meta_ads.source_connections c ON c.id=r.connection_id WHERE r.started_at>='2026-10-16T04:51:06Z') AS recent_runs,
(SELECT coalesce(json_agg(json_build_object('id',r.id,'connectionId',r.connection_id,'requestKey',r.request_key,'trigger',r.trigger::text,'from',r.from_date::text,'to',r.to_date::text,'status',r.status::text,'safeErrorCode',r.safe_error_code,'attemptCount',r.attempt_count,'nextAttemptAt',r.next_attempt_at,'deadlineAt',r.deadline_at,
'units',(SELECT coalesce(json_agg(json_build_object('key',u.unit_key,'status',u.status::text,'attempts',u.attempts,'publishedCount',u.published_count,'fetchedCount',u.fetched_count,'checkpointPresent',u.checkpoint_value IS NOT NULL)),'[]'::json) FROM phase08_meta_ads.run_units u WHERE u.run_id=r.id),
'checkpoints',(SELECT coalesce(json_agg(json_build_object('unitKey',cp.unit_key,'expiresAt',cp.expires_at,'bytes',octet_length(cp.ciphertext),'revision',cp.revision)),'[]'::json) FROM phase08_meta_ads.sync_unit_checkpoints cp WHERE cp.run_id=r.id),
'coverage',(SELECT coalesce(json_agg(json_build_object('date',cv.metric_date,'state',cv.state::text,'warnings',cv.warning_codes,'reconciliationStatus',cv.reconciliation_status,'lastSuccessRunId',cv.last_success_run_id,'lastAttemptRunId',cv.last_attempt_run_id,'lastSuccessAt',cv.last_success_at,'lastAttemptAt',cv.last_attempt_at)),'[]'::json) FROM phase08_meta_ads.source_coverage cv WHERE cv.connection_id=r.connection_id AND cv.metric_date=r.from_date),
'diagnostics',(SELECT coalesce(json_agg(json_build_object('action',a.action,'createdAt',a.created_at,'diagnosticCode',CASE WHEN a.after_json->>'diagnosticCode' ~ '^CAFE24_[A-Z0-9_]{1,64}$' THEN a.after_json->>'diagnosticCode' ELSE NULL END)),'[]'::json) FROM phase08_meta_ads.security_audit_events a WHERE a.target_id=r.id::text||':'||r.from_date::text AND a.action IN ('SYNC_UNIT_ACTION_REQUIRED','SYNC_UNIT_FAILED'))
) ORDER BY r.from_date),'[]'::json) FROM phase08_meta_ads.sync_runs r JOIN phase08_meta_ads.source_connections c ON c.id=r.connection_id WHERE c.provider='CAFE24' AND r.from_date IN ('2026-10-16','2026-10-17') AND r.to_date=r.from_date AND r.status='ACTION_REQUIRED') AS cafe_failed_metadata,
(SELECT coalesce(json_agg(json_build_object('kind',cr.kind::text,'keyVersion',cr.key_version,'expiresAt',cr.expires_at,'revision',cr.revision,'ciphertextBytes',octet_length(cr.ciphertext),'ivBytes',octet_length(cr.iv),'tagBytes',octet_length(cr.auth_tag),'refreshOwnerPresent',cr.refresh_owner IS NOT NULL,'refreshUntil',cr.refresh_until) ORDER BY cr.kind::text),'[]'::json) FROM phase08_meta_ads.source_credentials cr WHERE cr.connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1') AS cafe_credentials_metadata;
COMMIT;
'@
 $stage='SAFE_METADATA_READ';$rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 $stage='METADATA_SHAPE'
 if($rows.Count -ne 1){throw 'recent-count'}
 $stage='RECOVERY_COMPARE'
 $recovery=Get-Content -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/recovery-20261019/verified.json' -Raw|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25
 $comparison=[ordered]@{};foreach($key in @('business_md5','jobs_md5','schedules_md5','settings_md5','call_md5','original152_md5','storage_objects_md5')){$comparison[$key]=($snapshot[$key] -ceq $recovery.snapshot[$key])}
 $nodeImage=if($v.ContainsKey('NODE_IMAGE') -and $v.NODE_IMAGE -cmatch '^node:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$'){$v.NODE_IMAGE}else{$null}
 $stage='EVIDENCE_WRITE'
 $meta=$svc.latestDeployment.meta;$imageDigest=$null;$deployHash=$null
 if($meta -is [Collections.IDictionary]){if($meta.ContainsKey('imageDigest')){$imageDigest=$meta.imageDigest};if($meta.ContainsKey('serviceManifest') -and $meta.serviceManifest -is [Collections.IDictionary] -and $meta.serviceManifest.ContainsKey('deploy')){$deployHash=Hash-Text ($meta.serviceManifest.deploy|ConvertTo-Json -Compress -Depth 25)}}
 $out=[ordered]@{kind='PHASE10_INDEPENDENT_READONLY';observedAt=[DateTimeOffset]::UtcNow.ToString('o');identity=$pins.identity;identityPinsAreHistorical=$true;actualReleaseSha=$v['RELEASE_GIT_SHA'];deploymentId=$svc.latestDeployment.id;status=$svc.latestDeployment.status;sourceSha=$v.PHASE08_SOURCE_CONTENT_SHA256;imageDigest=$imageDigest;deployConfigHash=$deployHash;imageMetadataAvailable=($null -ne $imageDigest -and $null -ne $deployHash);startCommand=$svc.startCommand;sleepApplication=$svc.sleepApplication;nodeImage=$nodeImage;variablesCount=$v.Count;variableNameHashes=$hashes;variablesExceptStorageTokenHash=(Hash-Text ($exceptToken|ConvertTo-Json -Compress -Depth 12));storageExpiresAt=$expires.ToString('o');storageMinimum24h=($expires -gt [DateTimeOffset]::UtcNow.AddHours(24));storageRenewBefore=$expires.AddHours(-24).ToString('o');snapshot=$snapshot;preservedSinceRecovery=$comparison;recent=$rows[0];appHttpRequests=0;storageRequests=0;providerRequests=0;databaseWrites=0;remoteConfigurationWrites=0;productionAccess=0}
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent';[void][IO.Directory]::CreateDirectory($root)
 $path=Join-Path $root ($Label+'.json');$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($out|ConvertTo-Json -Depth 25));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 @{kind=$out.kind;observedAt=$out.observedAt;deploymentId=$out.deploymentId;status=$out.status;storageMinimum24h=$out.storageMinimum24h;preservedSinceRecovery=$comparison;snapshot=$snapshot;recent=$out.recent;evidencePath=$path;appHttpRequests=0;databaseWrites=0}|ConvertTo-Json -Depth 15
}catch{@{kind='PHASE10_INDEPENDENT_READONLY_REJECTED';stage=$stage;rawErrorSuppressed=$true;appHttpRequests=0;providerRequests=0;databaseWrites=0;remoteConfigurationWrites=0}|ConvertTo-Json -Compress;exit 1}
finally{$v=$null;$r=$null;$context=$null;$part=$null;$claims=$null;$exceptToken=$null}
