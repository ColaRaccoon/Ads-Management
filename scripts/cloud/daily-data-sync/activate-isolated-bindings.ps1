param([Parameter(Mandatory)][ValidateSet('Prepare','Status')][string]$Mode,[string]$ReviewedDeploymentId)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
$context=$null;$cfg=$null;$headers=$null;$result=$null;$variables=$null
function Invoke-Phase08BindingsRailway($query,$requestVariables){
  $body=@{query=$query;variables=$requestVariables}|ConvertTo-Json -Depth 12 -Compress
  $reply=Invoke-RestMethod -Uri 'https://backboard.railway.com/graphql/v2' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30 -MaximumRedirection 0
  if($reply.PSObject.Properties['errors']){throw 'inspect-before-retry'}
  return $reply.data
}
function Assert-Phase08BindingsIdentity($currentService,$currentVars,$targetIds,$runtimeContext){
  if($currentService.serviceId -cne $targetIds.s -or $currentService.environmentId -cne $targetIds.e -or $currentService.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $currentService.sleepApplication -ne $true -or
    $currentVars.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $currentVars.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $currentVars.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or
    $currentVars.PHASE08_SOURCE_CONTENT_SHA256 -cne 'b361da10cf16c0955ca0dc8c51bff195f289d6e8c7aae934f81f030b42a68e81' -or $currentVars.PHASE08_VERIFIED_ORIGIN -cne $runtimeContext.origin -or
    $currentVars.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $currentVars.DAILY_SYNC_SCHEDULES -cne '[]'){throw 'identity-or-schedule'}
}
try {
  $context=Read-Phase08ProtectedJson
  if($context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'context'}
  $cfg=Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.railway/config.json')|ConvertFrom-Json
  $headers=@{Authorization=('Bearer '+$cfg.user.accessToken)}
  $ids=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s=$context.serviceId}
  $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status}}}'
  $result=Invoke-Phase08BindingsRailway $query $ids
  $variables=$result.variables;$instance=$result.serviceInstance
  Assert-Phase08BindingsIdentity $instance $variables $ids $context
  $allowlist='["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'
  if($Mode -eq 'Prepare'){
    if($ReviewedDeploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $instance.latestDeployment.id -cne $ReviewedDeploymentId -or $instance.latestDeployment.status -notin @('SUCCESS','SLEEPING') -or $variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $variables.DAILY_SYNC_ALLOWED_ACCOUNTS -cne '[]'){throw 'reviewed-inert-baseline'}
    if($context.ids.metaConnectionId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'meta-aad'}
    $rows=Invoke-Phase08Management -Action ReadOnlyQuery -Query "SELECT (SELECT count(*) FROM phase08_meta_ads.source_connections)::int AS sources, (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE id='$($context.ids.metaConnectionId)'::uuid AND provider='META' AND external_account_id='2138525300002203' AND shop_key='default' AND currency_code='USD' AND time_zone='Asia/Seoul' AND enabled=false AND access_state='PENDING' AND credential_ref IS NULL AND credential_expires_at IS NULL)::int AS pending_meta, (SELECT count(*) FROM phase08_meta_ads.source_credentials)::int AS credentials, (SELECT count(*) FROM phase08_meta_ads.source_policies)::int AS policies, (SELECT count(*) FROM phase08_meta_ads.sync_runs)::int AS runs, (SELECT count(*) FROM phase08_meta_ads.app_users)::int AS users, (SELECT count(*) FROM phase08_meta_ads.app_users WHERE role='SUPER_ADMIN' AND invite_status='ACTIVE' AND is_active)::int AS operators;"
    if($rows.sources -ne 1 -or $rows.pending_meta -ne 1 -or $rows.credentials -ne 0 -or $rows.policies -ne 0 -or $rows.runs -ne 0 -or $rows.users -ne 1 -or $rows.operators -ne 1){throw 'fresh-bindings-baseline'}
    $discard=Invoke-Phase08BindingsRailway 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$ids.p;environmentId=$ids.e;serviceId=$ids.s;skipDeploys=$true;variables=@{PHASE08_ACTIVATED='true';DAILY_SYNC_FEATURE_ENABLED='true';DAILY_SYNC_SCHEDULE_ENABLED='false';DAILY_SYNC_SCHEDULES='[]';DAILY_SYNC_ALLOWED_ACCOUNTS=$allowlist}}}
    if($discard.variableCollectionUpsert -ne $true){throw 'outcome'}
    $result=Invoke-Phase08BindingsRailway $query $ids;$variables=$result.variables
    Assert-Phase08BindingsIdentity $result.serviceInstance $variables $ids $context
  }
  if($variables.PHASE08_ACTIVATED -cne 'true' -or $variables.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $variables.DAILY_SYNC_ALLOWED_ACCOUNTS -cne $allowlist -or $variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $variables.DAILY_SYNC_SCHEDULES -cne '[]'){throw 'activation-readback'}
  [ordered]@{state='PHASE08_BINDINGS_CONFIGURATION_VERIFIED';featureEnabled=$true;scheduleEnabled=$false;allowlistCount=3;schedules=0;skipDeploys=$true;requiresReviewedSourceUpload=($Mode -eq 'Prepare');operatingChanges=0;providerRequests=0}|ConvertTo-Json
} catch {[ordered]@{state='PHASE08_BINDINGS_CONFIGURATION_FAILED';mode=$Mode;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally {$context=$null;$cfg=$null;$variables=$null;$result=$null;$body=$null;if($headers){$headers.Clear()};$headers=$null}
