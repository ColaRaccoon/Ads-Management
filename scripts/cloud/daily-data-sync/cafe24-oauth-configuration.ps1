# Definitions only: importing this file reads no credentials and makes no requests.
function Invoke-Phase08CafeOAuthConfiguration([string]$mode,$context,[scriptblock]$railway) {
  $old=$null;$current=$null;$readback=$null;$values=$null;$changes=0
  try {
    if($mode -cnotin @('Prepare','Status') -or $context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or
      $context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'context'}
    $scope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3'}
    $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication}}'
    $old=& $railway $query ($scope+@{s='deaaeaf9-ee5c-42fa-b32f-600c7a90befc'})
    if($old.serviceInstance.serviceId -cne 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc' -or $old.serviceInstance.environmentId -cne $scope.e -or
      $old.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or
      $old.variables.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN -cne 'https://cafe24-callback-test-production.up.railway.app' -or
      $old.variables.DAILY_SYNC_CAFE24_REDIRECT_URI -cne 'https://cafe24-callback-test-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback' -or
      $old.variables.DAILY_SYNC_CAFE24_CLIENT_ID -cne 'tVV6DZtPOFRlpPk1ex7ISA' -or
      $old.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET -isnot [string] -or [string]::IsNullOrWhiteSpace($old.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET) -or
      $old.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET.Length -gt 512 -or $old.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET -match '[\x00-\x20\x7f]' -or
      $old.variables.DAILY_SYNC_CAFE24_MALL_ID -cne 'didadi0729' -or $old.variables.DAILY_SYNC_CAFE24_SHOP_KEY -cne 'shop1'){throw 'old-callback-identity'}
    $current=& $railway $query ($scope+@{s=$context.serviceId})
    Assert-Phase08CafeOAuthTarget $current $scope $context
    $values=@{DAILY_SYNC_CAFE24_CLIENT_ID='tVV6DZtPOFRlpPk1ex7ISA';DAILY_SYNC_CAFE24_CLIENT_SECRET=$old.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET;
      DAILY_SYNC_CAFE24_REDIRECT_URI=($context.origin+'/backend-api/integrations/cafe24/oauth/callback');DAILY_SYNC_CAFE24_ISOLATED_ORIGIN=$context.origin}
    if($mode -ceq 'Prepare') {
      foreach($key in $values.Keys){if($current.variables.PSObject.Properties[$key] -and -not [string]::IsNullOrEmpty($current.variables.$key)){throw 'existing-config-inspect-no-overwrite'}}
      $discard=& $railway 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$context.serviceId;skipDeploys=$true;replace=$false;variables=$values}}
      if($discard.variableCollectionUpsert -ne $true){throw 'configuration-outcome-inspect-no-retry'};$changes=1
      $readback=& $railway $query ($scope+@{s=$context.serviceId})
    } else {$readback=$current}
    Assert-Phase08CafeOAuthTarget $readback $scope $context
    foreach($key in $values.Keys){if($readback.variables.$key -cne $values[$key]){throw 'configuration-readback'}}
    return @{state='PHASE08_CAFE24_OAUTH_CONFIG_VERIFIED';mode=$mode;configurationReadbackVerified=$true;variableCount=4;newServiceMutations=$changes;
      oldServiceMutations=0;operatingChanges=0;tokenPairsCopied=0;providerRequests=0;scheduledStatsRequests=0;deploymentStarted=$false;skipDeploys=$true;
      requiresReviewedCliUp=($mode -ceq 'Prepare');requiresPartnersCallbackRegistration=$true}
  } finally {
    if($values){$values.Clear()};$old=$null;$current=$null;$readback=$null;$discard=$null;$values=$null
  }
}
function Assert-Phase08CafeOAuthTarget($result,$scope,$context) {
  $service=$result.serviceInstance;$vars=$result.variables
  if($service.serviceId -cne $context.serviceId -or $service.environmentId -cne $scope.e -or $service.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $service.sleepApplication -ne $true -or
    $vars.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $vars.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $vars.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or
    $vars.PHASE08_SOURCE_CONTENT_SHA256 -cne 'b361da10cf16c0955ca0dc8c51bff195f289d6e8c7aae934f81f030b42a68e81' -or
    $vars.PHASE08_VERIFIED_ORIGIN -cne $context.origin -or $vars.PHASE08_ACTIVATED -cne 'true' -or
    $vars.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $vars.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $vars.DAILY_SYNC_SCHEDULES -cne '[]' -or
    $vars.DAILY_SYNC_ALLOWED_ACCOUNTS -cne '["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'){throw 'new-target-identity-or-schedule'}
}
