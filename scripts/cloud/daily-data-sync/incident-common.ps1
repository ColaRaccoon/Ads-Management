# Definitions only. Values are returned solely to protected callers, never the tool output.
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$script:IncidentScope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
$script:IncidentEvidence='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019'
$script:IncidentPrivate='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/incident-20261019'
function Get-IncidentHash($Value){return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 40 -Compress)))).ToLowerInvariant()}
function Get-IncidentVariableHash($Value){$ordered=[ordered]@{};foreach($name in @($Value.Keys|Sort-Object)){$ordered[$name]=$Value[$name]};return Get-IncidentHash $ordered}
function Write-IncidentReceipt($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'RECEIPT_NAME'}
 [void][IO.Directory]::CreateDirectory($script:IncidentEvidence)
 $path=Join-Path $script:IncidentEvidence ($Name+'.json');$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 40));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Write-IncidentPrivate($Value,[string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'PRIVATE_NAME'}
 Assert-Phase08PrivatePath -Path 'C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime' -Directory
 if(-not (Test-Path -LiteralPath $script:IncidentPrivate)){[void][IO.Directory]::CreateDirectory($script:IncidentPrivate);Set-Phase08NewPrivateAcl -Path $script:IncidentPrivate -Directory}
 Assert-Phase08PrivatePath -Path $script:IncidentPrivate -Directory
 $path=Join-Path $script:IncidentPrivate ($Name+'.dpapi');$plain=$null;$encrypted=$null
 try{$plain=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 45 -Compress));$encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsIncident20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($encrypted,0,$encrypted.Length);$stream.Flush($true)}finally{$stream.Dispose()};Set-Phase08NewPrivateAcl -Path $path}
 finally{if($plain){[Array]::Clear($plain,0,$plain.Length)};if($encrypted){[Array]::Clear($encrypted,0,$encrypted.Length)}}
}
function Read-IncidentPrivate([string]$Name){
 if($Name -cnotmatch '^[a-z0-9-]+$'){throw 'PRIVATE_NAME'}
 $path=Join-Path $script:IncidentPrivate ($Name+'.dpapi');Assert-Phase08PrivatePath -Path $path
 Assert-Phase08PrivatePath -Path $script:IncidentPrivate -Directory
 $info=Get-Item -LiteralPath $path;if($info.Length -lt 32 -or $info.Length -gt 4194304){throw 'PRIVATE_SIZE'}
 $encrypted=$null;$plain=$null
 try{$encrypted=[IO.File]::ReadAllBytes($path);$plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[Text.Encoding]::ASCII.GetBytes('MetaAdsIncident20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);return ([Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)}
 finally{if($plain){[Array]::Clear($plain,0,$plain.Length)};if($encrypted){[Array]::Clear($encrypted,0,$encrypted.Length)}}
}
function Get-IncidentState {
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id environments{edges{node{id unmergedChangesCount}}}} variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status meta} activeDeployments{id status}}}' $script:IncidentScope
 $v=$r.variables;$s=$r.serviceInstance
 if($r.project.id -cne $script:IncidentScope.p -or $s.serviceId -cne $script:IncidentScope.s -or $s.environmentId -cne $script:IncidentScope.e -or $v.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $v.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated' -or $v.PRISMA_CONNECTION_LIMIT -cne '3' -or $v.HEAVY_OPERATION_CONCURRENCY -cne '1' -or $s.sleepApplication -cne $true -or $s.startCommand -cne 'node deploy/cloud/phase08-launch.mjs'){throw 'INCIDENT_TARGET'}
 $envMeta=@($r.project.environments.edges|Where-Object {$_.node.id -ceq $script:IncidentScope.e})
 if($envMeta.Count -ne 1 -or ($null -ne $envMeta[0].node.unmergedChangesCount -and $envMeta[0].node.unmergedChangesCount -ne 0)){throw 'INCIDENT_PENDING_CHANGES'}
 return $r
}
function Get-IncidentSnapshot {
 $sql=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout=20000;
DO $snap$ DECLARE t record;n bigint;d text;data jsonb:='[]';BEGIN
FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='phase08_meta_ads' ORDER BY tablename LOOP
EXECUTE format('SELECT count(*),md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM phase08_meta_ads.%I x',t.tablename) INTO n,d;
data:=data||jsonb_build_array(jsonb_build_object('table',t.tablename,'rows',n,'md5',d));END LOOP;
PERFORM set_config('incident.tables',data::text,true);END $snap$;
SELECT current_database() AS db,current_user AS principal,current_setting('incident.tables')::json AS table_digests,
(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS force_rls,
(SELECT json_build_object('login',rolcanlogin,'super',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'bypassrls',rolbypassrls,'replication',rolreplication,'configMd5',md5(coalesce(rolconfig::text,''))) FROM pg_roles WHERE rolname='phase08_runtime') AS runtime_role,
(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY grantee,table_name,privilege_type)::text,'[]')) FROM information_schema.role_table_grants x WHERE table_schema='phase08_meta_ads' AND grantee='phase08_runtime') AS runtime_grants_md5,
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
(SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime') AS runtime_backends,
(SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,
(SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
(SELECT md5(coalesce(jsonb_agg(to_jsonb(x)-'active' ORDER BY jobid)::text,'[]')) FROM cron.job x WHERE jobname LIKE 'daily-data-sync-08-%') AS job_definitions_md5,
(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY jobid)::text,'[]')) FROM cron.job x WHERE jobname NOT LIKE 'daily-data-sync-08-%') AS other_jobs_md5,
(SELECT md5(jsonb_agg(to_jsonb(x) ORDER BY id)::text) FROM daily_data_sync_ops.attempts x WHERE id<=152) AS original152_md5,
(SELECT md5(pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure))) AS call_md5,
(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM storage.objects x WHERE bucket_id='meta-ads-phase08-isolated') AS storage_objects_md5;
COMMIT;
'@
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].table_digests.Count -ne 68 -or $rows[0].force_rls -ne 68 -or $rows[0].jobs -ne 149 -or $rows[0].original152_md5 -cne 'c044e6c4249188e410d31aacf57422dc'){throw 'INCIDENT_DATABASE_TARGET'}
 return $rows[0]
}
function Assert-IncidentContained($Snapshot){if($Snapshot.stopped -cne $true -or $Snapshot.paused -ne 3 -or $Snapshot.active_jobs -ne 0 -or $Snapshot.live_leases -ne 0){throw 'INCIDENT_NOT_CONTAINED'}}
function Assert-IncidentVarsEqual($Actual,$Expected){if((Get-IncidentVariableHash $Actual) -cne (Get-IncidentVariableHash $Expected)){throw 'INCIDENT_CONCURRENT_VARIABLE_CHANGE'}}
