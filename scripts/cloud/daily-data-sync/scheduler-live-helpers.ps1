# Definitions only. Protected material is read only by explicitly invoked entrypoints.
. "$PSScriptRoot/protected-context.ps1"
. "$PSScriptRoot/scheduler-signing.ps1"
function Import-Phase08SchedulerChildDefinitions {
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'seed-isolated-business-config.ps1'),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'child-definition'}
 foreach($name in @('Test-Phase08BusinessDiagnostic','Get-Phase08BusinessSafeErrorType','Invoke-Phase08ConfigurationChild')) {
  $fn=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name})
  if($fn.Count -ne 1){throw 'child-definition'}
  # Functions enter the caller's script scope, never the seed script's executable body.
  $parameters=($fn[0].Parameters|ForEach-Object {$_.Extent.Text}) -join ','
  $body=$fn[0].Body.Extent.Text.Substring(1,$fn[0].Body.Extent.Text.Length-2)
  Set-Item -LiteralPath ("function:script:"+$name) -Value ([scriptblock]::Create("param($parameters)`n"+$body))
 }
}
function Invoke-Phase08SchedulerNode($Value) {
 return (Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'scheduler-parent-bridge.mjs') $Value)
}
function Get-Phase08SchedulerPins {
 $pins=Invoke-Phase08SchedulerNode @{action='pins'}
 if($pins.sourceSha -isnot [string] -or $pins.sourceSha -cnotmatch '^[a-f0-9]{64}$' -or $pins.deploymentId -isnot [string] -or
   $pins.deploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $pins.publicKeyB64 -isnot [string] -or $pins.publicKeyB64.Length -ne 60){throw 'reviewed-pins-missing'}
 return $pins
}
function Assert-Phase08SchedulerContext($Context,$Pins) {
 if($Context.projectRef -cne $Pins.identity.projectRef -or $Context.serviceId -cne $Pins.identity.serviceId -or $Context.origin -cne $Pins.identity.origin -or
   $Context.env.SUPABASE_DATABASE_SCHEMA -cne $Pins.identity.schema -or $Context.env.SUPABASE_DATABASE_RUNTIME_USER -cne $Pins.identity.runtimeUser -or
   $Context.env.RUNTIME_API_TARGET_ID -cne $Pins.identity.targetId){throw 'protected-context-identity'}
}
function Read-Phase08SchedulerDefinitions([string]$Path) {
 $file=Get-Item -LiteralPath $Path -ErrorAction Stop
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 65536){throw 'configuration-file'}
 $value=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 20
 if($value -isnot [Array]){throw 'configuration-array'}
 $now=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
 return (Invoke-Phase08SchedulerNode @{action='definitions';definitions=@($value);observedAt=$now})
}
function Invoke-Phase08SchedulerGraph([string]$Query,$Variables) {
 $cfg=$null;$headers=$null;$body=$null;$reply=$null
 try {
  $cfg=[IO.File]::ReadAllText((Join-Path $env:USERPROFILE '.railway/config.json'))|ConvertFrom-Json -Depth 20
  $headers=@{Authorization=('Bearer '+$cfg.user.accessToken)};$body=@{query=$Query;variables=$Variables}|ConvertTo-Json -Depth 15 -Compress
  $reply=Invoke-WebRequest -Uri 'https://backboard.railway.com/graphql/v2' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($reply.Content) -gt 2097152){throw 'graph-response'}
  $data=$reply.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25
  if($data.ContainsKey('errors') -and @($data.errors|Where-Object {$null -ne $_}).Count -gt 0){throw 'graph-errors'}
  return $data.data
 } catch {throw 'PHASE08_SCHEDULER_GRAPH_FAILED'}
 finally {if($headers){$headers.Clear()};$cfg=$null;$headers=$null;$body=$null;$reply=$null;$data=$null}
}
function Get-Phase08SchedulerGraphState($Context,$Pins) {
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status createdAt} activeDeployments{id status}} project(id:$p){id services{edges{node{id}}}}}'
 $result=Invoke-Phase08SchedulerGraph $query @{p=$Pins.identity.projectId;e=$Pins.identity.environmentId;s=$Pins.identity.serviceId}
 $svc=$result.serviceInstance;$vars=$result.variables
 if($result.project.id -cne $Pins.identity.projectId -or @($result.project.services.edges|Where-Object {$_.node.id -ceq $Pins.identity.serviceId}).Count -ne 1 -or
   $svc.serviceId -cne $Pins.identity.serviceId -or $svc.environmentId -cne $Pins.identity.environmentId -or $svc.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $svc.sleepApplication -isnot [bool] -or $svc.sleepApplication -ne $true -or
   $svc.latestDeployment.id -cne $Pins.deploymentId -or $svc.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or @($svc.activeDeployments).Count -ne 1 -or $svc.activeDeployments[0].id -cne $Pins.deploymentId -or $svc.activeDeployments[0].status -cnotin @('SUCCESS','SLEEPING') -or
   $vars.PHASE08_SOURCE_CONTENT_SHA256 -cne $Pins.sourceSha -or $vars.PHASE08_VERIFIED_ORIGIN -cne $Pins.identity.origin -or $vars.PHASE08_ACTIVATED -cne 'true' -or
   $vars.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $vars.DAILY_SYNC_SCHEDULE_ENABLED -cnotin @('true','false') -or
   $vars.DAILY_SYNC_ALLOWED_ACCOUNTS -cne '["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'){throw 'graph-identity'}
 $reviewed=@{PHASE08_ACTIVATED='true';DAILY_SYNC_CAFE24_SCHEDULED_BOOTSTRAP_ENABLED='true';DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED='true';DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE='API_ACTUAL_PRODUCT_PLUS_SHIPPING';DAILY_SYNC_CAFE24_APP_API_VERSION='2026-09-01';DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT='2026-10-01';DAILY_SYNC_CAFE24_SELLER_DROPDOWN='true';DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT='2026-10-01';DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED='true';DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT='2026-10-14';DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["C40","C48","E00","N00","N20","N30","N40","R00","R30","R40"]'}
 foreach($key in $reviewed.Keys){if($vars[$key] -cne $reviewed[$key]){throw 'reviewed-runtime-variable'}}
 $mutable=@('PHASE08_SOURCE_CONTENT_SHA256','DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED','DAILY_SYNC_ALLOWED_ACCOUNTS','DAILY_SYNC_SCHEDULES','PHASE08_META_CATALOG_JSON_B64','PHASE08_META_REPORT_SCHEMA_JSON_B64')+@($reviewed.Keys)
 $contextEnv=$Context.env|ConvertTo-Json -Depth 25 -Compress|ConvertFrom-Json -AsHashtable -DateKind String
 foreach($key in $contextEnv.Keys){if($key -cnotin $mutable -and (-not $vars.ContainsKey($key) -or $vars[$key] -cne $contextEnv[$key])){throw 'immutable-runtime-variable'}}
 $metadata=@();foreach($prefix in @('PHASE08_META_CATALOG','PHASE08_META_REPORT_SCHEMA')){$metadata+=@{original=$contextEnv[$prefix+'_JSON_B64'];json=$vars[$prefix+'_JSON_B64'];gzip=$vars[$prefix+'_GZIP_B64']}}
 $checkedMetadata=Invoke-Phase08SchedulerNode @{action='metadata';values=$metadata}
 if($checkedMetadata.state -cne 'PHASE08_METADATA_BYTES_VERIFIED'){throw 'metadata-bytes'}
 $loaded=$vars.DAILY_SYNC_SCHEDULES|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15 -NoEnumerate
 if($loaded -isnot [Array] -or $loaded.Count -notin @(0,3)){throw 'loaded-definitions'}
 return @{deploymentStatus=$svc.latestDeployment.status;appSchedules=@($loaded);featureEnabled=$true;scheduleEnabled=($vars.DAILY_SYNC_SCHEDULE_ENABLED -ceq 'true');observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
}
function Get-Phase08SchedulerReady($Context,$Pins) {
 $headers=$null;$response=$null
 try {
  $headers=@{'x-internal-probe-token'=$Context.env.INTERNAL_PROBE_TOKEN}
  $response=Invoke-WebRequest -Uri ($Pins.identity.origin+'/backend-api/health/ready') -Headers $headers -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
  if([int]$response.StatusCode -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 8192 -or ($response.Headers['Cache-Control'] -join ',') -notmatch '(?i)(^|,)\s*no-store\s*(,|$)'){throw 'ready-http'}
  $body=$response.Content|ConvertFrom-Json -AsHashtable -DateKind String
  if($body.status -cne 'ready' -or $body.releaseId -cne $Pins.identity.releaseSha -or $body.runtimeConfigFingerprint -cne $Pins.identity.readyFingerprint){throw 'ready-identity'}
  return @{observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
 } finally {if($headers){$headers.Clear()};$headers=$null;$response=$null;$body=$null}
}
function Get-Phase08SchedulerDatabase($Pins,$Ranges) {
 # One real privileged READ ONLY batch; the separate read-only endpoint runs a
 # different role and cannot attest the postgres installation principal.
 $query="BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'privilegedRole',current_user,'runtimeRole',(SELECT rolname FROM pg_roles WHERE rolname='phase08_runtime'),'schema','phase08_meta_ads','tableCount',(SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads'),'forceRlsCount',(SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity),'cronTimezone',current_setting('cron.timezone',true),'storageRenewalOpsPresent',to_regnamespace('storage_renewal_ops') IS NOT NULL) AS database,
 (SELECT coalesce(json_agg(json_build_object('provider',provider::text,'connectionId',id,'account',external_account_id,'shop',shop_key,'currency',currency_code,'timeZone',time_zone,'enabled',enabled,'accessState',access_state::text) ORDER BY provider::text),'[]'::json) FROM phase08_meta_ads.source_connections) AS connections,
 (SELECT coalesce(json_agg(json_build_object('connectionId',connection_id,'dataKind',data_kind::text,'fromDate',from_date::text,'toDate',to_date::text,'primarySource',primary_source::text,'reason',reason) ORDER BY connection_id,data_kind,from_date),'[]'::json) FROM phase08_meta_ads.source_policies) AS policies; COMMIT;"
 $rows=@(Invoke-Phase08Management -Action Query -Query $query)
 if($rows.Count -ne 1){throw 'database-response'}
 $row=$rows[0];$database=$row.database
 if($database.database -cne 'postgres' -or $database.privilegedRole -cne 'postgres' -or $database.runtimeRole -cne 'phase08_runtime' -or $database.schema -cne 'phase08_meta_ads' -or
   $database.tableCount -ne 68 -or $database.forceRlsCount -ne 68 -or $database.cronTimezone -cnotin @('GMT','UTC') -or $database.storageRenewalOpsPresent -isnot [bool] -or $database.storageRenewalOpsPresent -ne $false -or @($row.connections).Count -ne 3){throw 'database-identity'}
 $connections=@()
 foreach($expected in $Pins.connections) {
  $found=@($row.connections|Where-Object {$_.connectionId -ceq $expected.connectionId})
  if($found.Count -ne 1){throw 'connection-count'};$connection=$found[0]
  foreach($key in @('provider','connectionId','account','shop','currency','timeZone')){if($connection.$key -cne $expected[$key]){throw 'connection-identity'}}
  if($connection.enabled -isnot [bool] -or -not $connection.enabled -or $connection.accessState -cne 'READY'){throw 'connection-not-ready'}
  $range=@($Ranges|Where-Object {$_.connectionId -ceq $expected.connectionId});if($range.Count -ne 1){throw 'range'}
  $kinds=switch($expected.provider){'CAFE24'{@('CAFE24_ORDER')}'GOOGLE'{@('GOOGLE_CAMPAIGN')}'META'{@('META_AD','META_ADSET')}};$starts=@{}
  foreach($kind in $kinds) {
   $policy=@($row.policies|Where-Object {$_.connectionId -ceq $expected.connectionId -and $_.dataKind -ceq $kind -and $_.fromDate -cle $range[0].fromDate -and ($null -eq $_.toDate -or $_.toDate -cgt $range[0].toDate)})
   if($policy.Count -ne 1 -or ($expected.provider -ceq 'CAFE24' -and $policy[0].primarySource -cnotin @('CSV','API')) -or ($expected.provider -cne 'CAFE24' -and $policy[0].primarySource -cne 'API')){throw 'covering-policy'}
   $starts[$kind]=$policy[0].fromDate
  }
  $connections+=@{provider=$expected.provider;connectionId=$expected.connectionId;account=$expected.account;shop=$expected.shop;currency=$expected.currency;timeZone=$expected.timeZone;enabled=$true;accessState='READY';policyKinds=@($kinds);policyFromDates=$starts}
 }
 return @{database=@{database='postgres';privilegedRole='postgres';runtimeRole='phase08_runtime';schema='phase08_meta_ads';tableCount=68;forceRlsCount=68;cronTimezone=$database.cronTimezone;storageRenewalOpsPresent=$false};connections=@($connections);observedAt=[DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
}
function Get-Phase08SchedulerSnapshot {
 # A read-only dynamic SELECT handles the not-yet-installed namespace.
 $query=@'
BEGIN READ ONLY;
DO $snapshot$ DECLARE value json; BEGIN
 IF to_regclass('daily_data_sync_ops.settings') IS NULL THEN
  value:=json_build_object('installed',false,'settings','[]'::json,'schedules','[]'::json,'jobs','[]'::json);
 ELSE
  EXECUTE $sql$SELECT json_build_object('installed',true,
   'settings',(SELECT coalesce(json_agg(json_build_object('stopped',stopped,'targetId',target_id,'origin',origin)),'[]'::json) FROM daily_data_sync_ops.settings),
   'schedules',(SELECT coalesce(json_agg(json_build_object('key',key,'connectionId',connection_id,'provider',provider,'anchorAt',to_char(anchor_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'windowMinutes',window_minutes,'cadenceDays',cadence_days,'paused',paused) ORDER BY key),'[]'::json) FROM daily_data_sync_ops.schedules),
   'jobs',(SELECT coalesce(json_agg(json_build_object('name',jobname,'cron',schedule,'command',command,'active',active,'database',database,'username',username) ORDER BY jobname),'[]'::json) FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%'))$sql$ INTO value;
 END IF;
 PERFORM set_config('daily_data_sync.snapshot',value::text,true);
END $snapshot$;
DO $preserve$ DECLARE value text; BEGIN
 IF to_regclass('cron.job') IS NULL THEN value:='[]'; ELSE
  EXECUTE $sql$SELECT coalesce(json_agg(json_build_object('name',jobname,'cron',schedule,'command',command,'active',active,'database',database,'username',username) ORDER BY jobid)::text,'[]') FROM cron.job WHERE jobname NOT LIKE 'daily-data-sync-08-%'$sql$ INTO value;
 END IF; PERFORM set_config('daily_data_sync.other_cron_digest',md5(value),true);
END $preserve$;
SELECT current_database() AS database,current_user AS role,
 current_setting('daily_data_sync.snapshot')::json AS snapshot,
 current_setting('daily_data_sync.other_cron_digest') AS other_cron_digest,
 md5((SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.schemaname,t.tablename)::text,'[]') FROM pg_catalog.pg_tables t WHERE t.schemaname NOT IN ('daily_data_sync_ops','cron','vault')) ||
 (SELECT coalesce(json_agg(row_to_json(p) ORDER BY p.schemaname,p.tablename,p.policyname)::text,'[]') FROM pg_catalog.pg_policies p WHERE p.schemaname NOT IN ('daily_data_sync_ops','cron','vault'))) AS preserved_schema_digest;
COMMIT;
'@
 $rows=@(Invoke-Phase08Management -Action Query -Query $query)
 if($rows.Count -ne 1 -or $rows[0].database -cne 'postgres' -or $rows[0].role -cne 'postgres' -or
  $rows[0].other_cron_digest -isnot [string] -or $rows[0].other_cron_digest -cnotmatch '^[a-f0-9]{32}$' -or
  $rows[0].preserved_schema_digest -isnot [string] -or $rows[0].preserved_schema_digest -cnotmatch '^[a-f0-9]{32}$'){throw 'snapshot-identity'}
 return $rows[0]
}
function Assert-Phase08SchedulerOutputPath([string]$Path) {
 $root='C:\Users\seong\AppData\Local\MetaAdsPhase08Evaluation';$full=[IO.Path]::GetFullPath($Path)
 if(-not $full.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($full) -cne '.json' -or (Test-Path -LiteralPath $full)){throw 'output-no-overwrite'}
 $parent=[IO.Path]::GetDirectoryName($full)
 while($parent){$item=Get-Item -LiteralPath $parent -ErrorAction Stop;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'output-reparse'};$parent=[IO.Path]::GetDirectoryName($parent)}
 return $full
}
function Write-Phase08SchedulerPublicEvidence($Envelope,[string]$Path) {
 $full=Assert-Phase08SchedulerOutputPath $Path;$stream=$null;$bytes=$null
 try {$bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($Envelope|ConvertTo-Json -Depth 25 -Compress));if($bytes.Length -gt 65536){throw 'evidence-bound'}
  $stream=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
 } finally {if($stream){$stream.Dispose()};$bytes=$null}
 return $full
}
function Get-Phase08SchedulerRuntimeProof($Context) {
 $result=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'seed-isolated-business-config.mjs') @{projectRef='ehnfrrmbkvlsbpvqcvkr';freshVerified=$true;databaseUrl=$Context.env.DATABASE_URL} @('--diagnose-target')
 if($result.state -cne 'PHASE08_BUSINESS_TARGET_READONLY_VERIFIED' -or $result.targetWrites -ne 0 -or $result.providerRequests -ne 0){throw 'runtime-readonly'}
}
