param([Parameter(Mandatory)][string]$EvidencePath,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$ExpectedDeploymentId,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha,
 [Parameter(Mandatory)][Alias('ExpectedReleaseId')][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedReleaseSha)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"

function Assert-ResumeLoadAcceptance($Value){
 if($Value.kind -cne 'PHASE10_USER_REVISED_ACCEPTANCE' -or $Value.userDecisionDate -cne '2026-10-20' -or $Value.requests -ne 40 -or $Value.concurrency -ne 4 -or $Value.maximumP95Ms -ne 5000 -or $Value.maximumErrors -ne 0 -or $Value.memoryLimitBytes -ne 1000000000 -or $Value.prismaPool -ne 3 -or $Value.heavyOperationConcurrency -ne 1 -or $Value.existingFullBusinessRegression -cne 'EXCLUDED_BY_USER' -or $Value.sharedCredentialChangesAllowed -cne $false -or $Value.operatingChangesAllowed -cne $false -or $Value.stages11And12Allowed -cne $false){throw 'RESUME_ACCEPTANCE'}
 if($Value.featureOnForPublishedReadsOnly -cne $true -or $Value.scheduleEnabled -cne $false -or $Value.maximumReadTestWindowMinutes -ne 20){throw 'RESUME_READ_ACCEPTANCE'}
}
function Assert-ResumeLoadDeadline([string]$Deadline){
 $d=[DateTimeOffset]::Parse($Deadline);$now=[DateTimeOffset]::UtcNow
 if($d -le $now -or $d -gt $now.AddMinutes(20)){throw 'RESUME_READ_DEADLINE'}
}
function Get-ResumeLoadHttpTimeout([string]$Deadline){
 Assert-ResumeLoadDeadline $Deadline
 $seconds=[Math]::Floor(([DateTimeOffset]::Parse($Deadline)-[DateTimeOffset]::UtcNow).TotalSeconds)
 if($seconds -lt 1){throw 'RESUME_READ_DEADLINE'}
 return [Math]::Min(45,[int]$seconds)
}
function Get-ResumeLoadSummary($Records){
 $v=@($Records|ForEach-Object{[double]$_.elapsedMs}|Sort-Object);$n=$v.Count
 return @{requests=$n;errors=@($Records|Where-Object{$_.httpStatus -ne 200}).Count;p95Ms=$(if($n){$v[[Math]::Ceiling($n*0.95)-1]}else{$null});totalBytes=$(if($n){($Records|Measure-Object bytes -Sum).Sum}else{0})}
}
function Get-ResumeLoadContractShape([string]$Content,[ValidateSet('DASHBOARD','STOREFRONT')][string]$Endpoint){
 if($Content.Length -gt 2097152){throw 'RESUME_BODY_LIMIT'}
 $j=$Content|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String
 if($j -isnot [Collections.IDictionary] -or -not $j.Contains('totals') -or $j.totals -isnot [Collections.IDictionary]){throw 'RESUME_TOTALS_SHAPE'}
 $names=if($Endpoint -ceq 'DASHBOARD'){@('spendUsd','spendKrw','revenueKrw','marginKrw','cpaUsd','cpaKrw','cpcLinkUsd','cpcAllUsd','providerPurchaseValueUsd','providerPurchaseCpaUsd')}else{@('revenueKrw','knownSpendKrw','totalSpendKrw','mer')}
 foreach($n in $names){if(-not $j.totals.Contains($n) -or ($null -ne $j.totals[$n] -and ($j.totals[$n] -isnot [string] -or $j.totals[$n] -cnotmatch '^-?(0|[1-9]\d*)(?:\.\d+)?$'))){throw 'RESUME_MONEY_JSON_TYPE'}}
 $bigints=0
 if($Endpoint -ceq 'DASHBOARD'){
  if($j.totals.spendUsd -isnot [string] -or -not $j.totals.Contains('impressions') -or $j.totals.impressions -isnot [string] -or $j.totals.impressions -cnotmatch '^(0|[1-9]\d*)$'){throw 'RESUME_BIGINT_JSON_TYPE'};$bigints=1
  foreach($n in @('purchaseCount','linkClicks','clicksAll')){if(-not $j.totals.Contains($n)){throw 'RESUME_COUNT_JSON_TYPE'};$v=$j.totals[$n];if($null -ne $v -and (($v -isnot [int] -and $v -isnot [long] -and $v -isnot [double] -and $v -isnot [decimal]) -or -not [double]::IsFinite([double]$v) -or $v -lt 0 -or $v -gt 9007199254740991 -or [Math]::Truncate([double]$v) -ne $v)){throw 'RESUME_COUNT_JSON_TYPE'}}
  if($j.totals.spendUsd -cne '4968.99'){throw 'RESUME_PINNED_REAL_SPEND'}
 }else{
  if(-not $j.Contains('googleCampaigns') -or $j.googleCampaigns -isnot [Array]){throw 'RESUME_GOOGLE_JSON_SHAPE'}
  foreach($g in $j.googleCampaigns){foreach($n in @('costMicros','impressions','clicks')){if($g -isnot [Collections.IDictionary] -or -not $g.Contains($n) -or $g[$n] -isnot [string] -or $g[$n] -cnotmatch '^(0|[1-9]\d*)$'){throw 'RESUME_GOOGLE_BIGINT_TYPE'};$bigints++}}
 }
 return @{endpoint=$Endpoint;status='PASS';moneyFieldsChecked=$names.Count;bigintFieldsChecked=$bigints;canonicalMoneyStringOrNull=$true;rawResponseSaved=$false;actualMetaSpendExact=$(if($Endpoint -ceq 'DASHBOARD'){$true}else{$null});expectedMetaSpendUsd=$(if($Endpoint -ceq 'DASHBOARD'){'4968.99'}else{$null})}
}
function Assert-ResumeLoadEnvironment($Protected,$Live,[string]$Source,[string]$Release){
 $expected=$Protected|ConvertTo-Json -Depth 30 -Compress|ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String
 if($expected -isnot [Collections.IDictionary] -or $Live -isnot [Collections.IDictionary] -or (@($expected.Keys|Sort-Object)-join '|') -cne (@($Live.Keys|Sort-Object)-join '|')){throw 'RESUME_ENVIRONMENT_NAMES'}
 foreach($n in $expected.Keys){if($n -cin @('PHASE08_SOURCE_CONTENT_SHA256','RELEASE_GIT_SHA','DAILY_SYNC_FEATURE_ENABLED')){continue};if($expected[$n] -isnot [string] -or $Live[$n] -isnot [string] -or $expected[$n] -cne $Live[$n]){throw 'RESUME_ENVIRONMENT_CHANGED'}}
 if($expected.DAILY_SYNC_FEATURE_ENABLED -cnotin @('false','true') -or $Live.PHASE08_SOURCE_CONTENT_SHA256 -cne $Source -or $Live.RELEASE_GIT_SHA -cne $Release -or $Live.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $Live.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false'){throw 'RESUME_PINS_OR_FEATURE'}
 foreach($n in @('DAILY_SYNC_CREDENTIAL_KEY_V1','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET')){if($Live.Contains($n)){throw 'RESUME_RETIRED_VALUE_PRESENT'}}
 $expected.PHASE08_SOURCE_CONTENT_SHA256=$Source;$expected.RELEASE_GIT_SHA=$Release;$expected.DAILY_SYNC_FEATURE_ENABLED='true'
 return $expected
}
function Assert-ResumeLoadHeld($Protected,[string]$Deployment,[string]$Source,[string]$Release){
 Assert-ResumeLoadDeadline $script:ResumeReadDeadline
 $live=Get-IncidentState;$null=Assert-ResumeLoadEnvironment $Protected $live.variables $Source $Release
 $plan=Read-IncidentPrivate 'resume-20261020-v3'
 if($plan.eligibleSecretRollback -cne $false -or [string]$plan.testDeadline -cne $script:ResumeReadDeadline){throw 'RESUME_PRIVATE_READ_PLAN'}
 $custom=(Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s,unrendered:true)}' $script:IncidentScope).variables
 Assert-IncidentVarsEqual $custom $plan.after
 $custom=$null
 $plan=$null
 $r=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status deploymentStopped} activeDeployments{id status deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}
 $service=$r.serviceInstance;$active=@($service.activeDeployments|Where-Object{$_.deploymentStopped -cne $true})
 if($service.serviceId -cne $script:IncidentScope.s -or $service.environmentId -cne $script:IncidentScope.e -or $service.latestDeployment.id -cne $Deployment -or $service.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $service.latestDeployment.deploymentStopped -cne $false -or $active.Count -ne 1 -or $active[0].id -cne $Deployment){throw 'RESUME_ACTIVE_DEPLOYMENT'}
 $sql=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout='15s';
SELECT current_database()='postgres' AND current_user='postgres' AS bound,
(SELECT stopped AND target_id='phase08-full-app' FROM daily_data_sync_ops.settings WHERE singleton) AS stopped,
(SELECT count(*)::int FROM daily_data_sync_ops.schedules) AS schedules,
(SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
(SELECT count(*)::int FROM phase08_meta_ads.source_connections) AS connections,
(SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled,
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS live_leases,
(SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE status='RUNNING') AS running_runs,
(SELECT count(*)::int FROM unnest(ARRAY['source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints']) AS t(name) WHERE has_table_privilege('phase08_runtime',format('phase08_meta_ads.%I',name),'SELECT,INSERT,UPDATE,DELETE')) AS sensitive_grants,
(SELECT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication FROM pg_roles WHERE rolname='phase08_runtime') AS restricted_temporary_login,
(SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='phase08_runtime') AS role_memberships;
COMMIT;
'@
 $a=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($a.Count -ne 1 -or $a[0].bound -cne $true -or $a[0].stopped -cne $true -or $a[0].schedules -ne 3 -or $a[0].paused -ne 3 -or $a[0].jobs -ne 149 -or $a[0].active_jobs -ne 0 -or $a[0].connections -ne 3 -or $a[0].enabled -ne 0 -or $a[0].live_leases -ne 0 -or $a[0].running_runs -ne 0 -or $a[0].sensitive_grants -ne 0 -or $a[0].restricted_temporary_login -cne $true -or $a[0].role_memberships -ne 0){throw 'RESUME_HELD_CONTROLS'}
 return @{at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$Deployment;status=$service.latestDeployment.status;unstoppedDeployments=$active.Count;stopped=$true;paused=3;inactiveJobs=149;providerEnabled=0;sensitiveGrants=0;liveLeases=0;runningRuns=0;featureEnabled=$true;scheduleEnabled=$false;restrictedTemporaryLogin=$true;exactProtectedEnvironmentExceptTwoPublicPinsAndReadFlag=$true;privateReadPlanExact=$true;testDeadline=$script:ResumeReadDeadline}
}
function Assert-ResumeLoadSafeOutput([string]$Text,$Secrets){
 foreach($value in $Secrets){if($value -is [string] -and $value.Length -ge 8 -and $Text.Contains($value,[StringComparison]::Ordinal)){throw 'RESUME_OUTPUT_SECRET'}}
 if($Text -match 'sb_secret_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|postgres(?:ql)?://'){throw 'RESUME_OUTPUT_PATTERN'}
}

$base='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020'
$acceptancePath=Join-Path $base 'acceptance-read.json';$destination=[IO.Path]::GetFullPath($EvidencePath)
$origin='https://phase08-daily-data-sync-production.up.railway.app';$stage='ACCEPTANCE';$passed=$false;$loggedIn=$false;$loginAttempted=$false;$logoutAttempted=$false;$logoutVerified=$false;$sessionMayRemain=$false;$lastHttp=$null;$wall=0;$rows=@();$warmup=0;$contractChecks=@();$before=$null;$after=$null;$context=$null;$operator=$null;$headers=$null;$loadHeaders=$null;$session=$null;$secrets=[Collections.Generic.List[string]]::new();$safeRejection=$null;$acceptanceSha=$null;$canWriteReceipt=$false;$started=$null;$finished=$null
$script:ResumeReadDeadline=$null;$projectionSha=$null
try{
 $prefix=[IO.Path]::GetFullPath($base)+[IO.Path]::DirectorySeparatorChar
 if(-not $destination.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($destination) -cne '.json' -or (Test-Path -LiteralPath $destination) -or -not(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'RESUME_EVIDENCE_SCOPE'}
 $canWriteReceipt=$true;$acceptance=Get-Content -LiteralPath $acceptancePath -Raw|ConvertFrom-Json -AsHashtable -DateKind String;Assert-ResumeLoadAcceptance $acceptance;$acceptanceSha=(Get-FileHash -LiteralPath $acceptancePath).Hash.ToLowerInvariant()
 $readScope=Get-Content -LiteralPath (Join-Path $base 'bounded-plan-v3.json') -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($readScope.kind -cne 'BOUNDED_API_READ_TEST_PLAN' -or $readScope.release -cne $ExpectedReleaseSha -or $readScope.source -cne $ExpectedSourceSha -or $readScope.featureOnForPublishedReadsOnly -cne $true -or $readScope.scheduleEnabled -cne $false){throw 'RESUME_PUBLIC_READ_PLAN'}
 $script:ResumeReadDeadline=[string]$readScope.testDeadline;Assert-ResumeLoadDeadline $script:ResumeReadDeadline
 $projectionPath=Join-Path $base 'preload-meta-projection.json';$projection=Get-Content -LiteralPath $projectionPath -Raw|ConvertFrom-Json -AsHashtable -DateKind String
 if($projection.kind -cne 'PRELOAD_ACTUAL_META_CURRENT_DAY_PROJECTION' -or $projection.date -cne '2026-10-14' -or $projection.level -cne 'ADSET' -or @($projection.rows).Count -ne 1 -or $projection.rows[0].db -cne 'postgres' -or $projection.rows[0].principal -cne 'postgres' -or $projection.rows[0].source -cne 'API' -or $projection.rows[0].rows -ne 200 -or $projection.rows[0].spend_usd -cne '4968.9900' -or $projection.dataWrites -ne 0 -or $projection.providerRequests -ne 0){throw 'RESUME_REAL_PROJECTION'}
 $projectionSha=(Get-FileHash -LiteralPath $projectionPath).Hash.ToLowerInvariant()
 $stage='PROTECTED_CURRENT_CONTEXT'
 # Preserve exact ISO environment strings through the existing DPAPI reader.
 $context=& {$PSDefaultParameterValues=@{'ConvertFrom-Json:DateKind'='String'};Read-Phase08ProtectedJson}
 $operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator
 $secretNames=@('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN','DATABASE_URL','DAILY_SYNC_CREDENTIAL_KEY_V2','DAILY_SYNC_CHECKPOINT_KEY_B64','DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64','SUPABASE_SECRET_KEY','SUPABASE_STORAGE_ACCESS_TOKEN')
 foreach($n in $secretNames){if($context.env.PSObject.Properties[$n]){$secrets.Add([string]$context.env.$n)}};$secrets.Add([string]$operator.password)
 $stage='START_HELD_CONTROLS';$before=Assert-ResumeLoadHeld $context.env $ExpectedDeploymentId $ExpectedSourceSha $ExpectedReleaseSha
 $projected=$context.env|ConvertTo-Json -Depth 30 -Compress|ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String;$projected.PHASE08_SOURCE_CONTENT_SHA256=$ExpectedSourceSha;$projected.RELEASE_GIT_SHA=$ExpectedReleaseSha;$projected.DAILY_SYNC_FEATURE_ENABLED='true';$context.env=$projected
 $stage='CONSUME_SINGLE_ATTEMPT';$attempt=Join-Path $base ('light-load-attempt-'+$ExpectedDeploymentId+'.json');$planned=@{kind='PHASE10_BOUNDED_SINGLE_LIGHT_LOAD_ATTEMPT';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;releaseSha=$ExpectedReleaseSha;acceptanceSha256=$acceptanceSha;requests=40;concurrency=4;maximumP95Ms=5000;automaticRetryAllowed=$false;businessWrites=0;providerRequests=0}|ConvertTo-Json -Compress
 $f=[IO.File]::Open($attempt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[Text.Encoding]::UTF8.GetBytes($planned);$f.Write($b)}finally{$f.Dispose()}
 Assert-ResumeLoadDeadline $script:ResumeReadDeadline
 $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$headers=@{Origin=$origin};$stage='LOGIN';$loginAttempted=$true;$sessionMayRemain=$true
 try{$response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' @{email=$operator.email;password=$operator.password} $context $session $headers}finally{$lastHttp=[DateTimeOffset]::UtcNow.ToString('o')}
 Assert-Phase08LoginResponse $response $session $operator $origin;$loggedIn=$true;$response=$null
 $cookie=@($session.Cookies.GetCookies([Uri]$origin)|ForEach-Object{$_.Name+'='+$_.Value}) -join '; ';$loadHeaders=@{Cookie=$cookie;Origin=$origin;'x-user-activity-age'='0'};$cookie=$null
 $paths=@('/backend-api/dashboard/summary?from=2026-10-14&to=2026-10-14&deliveryStatus=all','/backend-api/storefront/summary?from=2026-10-09&to=2026-10-15')
 $stage='WARMUP';foreach($path in $paths){$timeout=Get-ResumeLoadHttpTimeout $script:ResumeReadDeadline;try{$response=Invoke-WebRequest -Uri ($origin+$path) -Headers $loadHeaders -TimeoutSec $timeout -MaximumRedirection 0 -SkipHttpErrorCheck}finally{$lastHttp=[DateTimeOffset]::UtcNow.ToString('o')};if([int]$response.StatusCode -ne 200 -or $response.Content.Length -gt 2097152 -or [string]$response.Headers['Content-Type'] -cnotmatch '^application/json(?:;|$)'){throw 'RESUME_WARMUP'};$contractChecks+=Get-ResumeLoadContractShape $response.Content $(if($path.Contains('/dashboard/')){'DASHBOARD'}else{'STOREFRONT'});$warmup++;$response=$null}
 $stage='LOAD_SINGLE_BATCH';Assert-ResumeLoadDeadline $script:ResumeReadDeadline;$started=[DateTimeOffset]::UtcNow.ToString('o');$watch=[Diagnostics.Stopwatch]::StartNew()
 $batchDeadline=$script:ResumeReadDeadline
 $rows=@(0..39|ForEach-Object -ThrottleLimit 4 -Parallel {
  $ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$i=$_;$available=$using:paths;$path=$available[$i%2];$h=$using:loadHeaders;$o=$using:origin;$status=0;$bytes=0;$requestWatch=[Diagnostics.Stopwatch]::StartNew();$responseTooLarge=$false
  try{$remaining=[Math]::Floor(([DateTimeOffset]::Parse($using:batchDeadline)-[DateTimeOffset]::UtcNow).TotalSeconds);if($remaining -lt 1){throw 'RESUME_READ_DEADLINE'};$reply=Invoke-WebRequest -Uri ($o+$path) -Headers $h -TimeoutSec ([Math]::Min(45,[int]$remaining)) -MaximumRedirection 0 -SkipHttpErrorCheck;$status=[int]$reply.StatusCode;$bytes=[Text.Encoding]::UTF8.GetByteCount($reply.Content);$responseTooLarge=$bytes -gt 2097152;if($responseTooLarge -or [string]$reply.Headers['Content-Type'] -cnotmatch '^application/json(?:;|$)'){$status=0}}catch{}finally{$requestWatch.Stop();$reply=$null}
  @{index=$i;path=$path;httpStatus=$status;bytes=$bytes;responseLimitExceeded=$responseTooLarge;elapsedMs=[Math]::Round($requestWatch.Elapsed.TotalMilliseconds,2);finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
 });$watch.Stop();$wall=[Math]::Round($watch.Elapsed.TotalMilliseconds,2);$finished=[DateTimeOffset]::UtcNow.ToString('o');$lastHttp=$finished
 Assert-ResumeLoadDeadline $script:ResumeReadDeadline
 $summary=Get-ResumeLoadSummary $rows;$passed=$summary.requests -eq 40 -and $summary.errors -eq 0 -and $summary.p95Ms -le 5000
}catch{$passed=$false;$safeRejection='BOUNDED_TEST_FAILED_RAW_SUPPRESSED'}
finally{
 if($loginAttempted){$stageBeforeCleanup=$stage;try{
   $csrf=@($session.Cookies.GetCookies([Uri]$origin)|Where-Object{$_.Name -ceq '__Host-phase08-meta_csrf'});if($csrf.Count -ne 1){throw 'RESUME_CSRF_CLEANUP'};$headers['X-CSRF-Token']=$csrf[0].Value;$logoutAttempted=$true
   try{$response=Invoke-WebRequest -Uri ($origin+'/backend-api/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -TimeoutSec 45 -MaximumRedirection 0 -SkipHttpErrorCheck}finally{$lastHttp=[DateTimeOffset]::UtcNow.ToString('o')}
   if([int]$response.StatusCode -ne 204){throw 'RESUME_LOGOUT'};$logoutVerified=$true;$loggedIn=$false;$sessionMayRemain=$false;$response=$null
  }catch{$passed=$false;$sessionMayRemain=$true};$stage=$stageBeforeCleanup
 }
 if($null -ne $before){try{$after=Assert-ResumeLoadHeld $context.env $ExpectedDeploymentId $ExpectedSourceSha $ExpectedReleaseSha}catch{$passed=$false;$safeRejection='FINAL_HELD_CONTROL_REJECTED'}}
 if(-not $logoutVerified){$passed=$false};if($acceptanceSha -and (Get-FileHash -LiteralPath $acceptancePath).Hash.ToLowerInvariant() -cne $acceptanceSha){$passed=$false;$safeRejection='ACCEPTANCE_CHANGED'}
 $summary=Get-ResumeLoadSummary $rows;$endpoint=@($rows|Group-Object path|ForEach-Object{@{path=$_.Name;summary=(Get-ResumeLoadSummary @($_.Group))}})
 $result=@{kind='PHASE10_USER_REVISED_ACTUAL_CANDIDATE_LIGHT_LOAD';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;releaseSha=$ExpectedReleaseSha;status=$(if($passed){'PASS'}else{'FAIL'});stage=$stage;safeRejection=$safeRejection;classification='ONE_WARMED_AUTHENTICATED_GET_BATCH';acceptanceFile=$acceptancePath;acceptanceSha256=$acceptanceSha;maximumP95Ms=5000;concurrency=4;requests=$rows;summary=$summary;endpoints=$endpoint;wallMs=$wall;loadStartedAt=$started;loadFinishedAt=$finished;warmupRequests=$warmup;warmupContractChecks=$contractChecks;lastAppHttpAt=$lastHttp;logoutAttempted=$logoutAttempted;logoutVerified=$logoutVerified;sessionMayRemain=$sessionMayRemain;heldControlsBefore=$before;heldControlsAfter=$after;automaticRetryAllowed=$false;providerRequests=0;businessWrites=0;authenticationMetadataWritesExpected=$loginAttempted;fullExistingBusinessRegression='EXCLUDED_BY_USER';rawResponsesSaved=0;plaintextSecretFilesCreated=0;dbWaitRssOomObservedByThisRunner=$false;measurementLimits=@('single authenticated client process; independent client traffic must be excluded by orchestration','management controls before/after are not a cross-platform atomic snapshot','DB wait/RSS/OOM require separately time-bounded telemetry','logout204 is verified; session row retirement is separately inspected by root')}
 $result.readScope=@{privatePlan='resume-20261020-v3';testDeadline=$script:ResumeReadDeadline;featureOnForPublishedReadsOnly=$true;scheduleEnabled=$false;normalResume=$false;preloadMetaProjectionSha256=$projectionSha;expectedMetaSpendUsd='4968.99';featureFlagAlsoEnablesGuardedMutationRoutes=$true;onlyFixedGetRequestsAuthorized=$true}
 try{if($canWriteReceipt){$json=$result|ConvertTo-Json -Depth 13;Assert-ResumeLoadSafeOutput $json $secrets;$f=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[Text.Encoding]::UTF8.GetBytes($json);$f.Write($b)}finally{$f.Dispose()}}}catch{$passed=$false}
 if($headers){$headers.Clear()};if($loadHeaders){$loadHeaders.Clear()};$context=$null;$projected=$null;$operator=$null;$session=$null;$response=$null;$csrf=$null;$secrets.Clear()
}
@{kind='PHASE10_USER_REVISED_ACTUAL_CANDIDATE_LIGHT_LOAD';status=$(if($passed){'PASS'}else{'FAIL'});summary=$summary;logoutVerified=$logoutVerified;sessionMayRemain=$sessionMayRemain;lastAppHttpAt=$lastHttp;evidence=$destination;rawValuesReturned=0}|ConvertTo-Json -Depth 4 -Compress
if(-not $passed){exit 1}
