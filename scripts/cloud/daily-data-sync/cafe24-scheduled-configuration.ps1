# Definitions only. The root supplies the independently reviewed new image hash.
function Invoke-Phase08CafeScheduledConfiguration([string]$Mode,[string]$ReviewedSourceSha256,[string]$ReviewedV1Date,$Context,[scriptblock]$Railway) {
 $current=$null;$readback=$null;$values=$null
 try {
  if($Mode -cnotin @('Prepare','Status') -or $ReviewedSourceSha256 -cnotmatch '^[a-f0-9]{64}$' -or
     $Context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $Context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or
     $Context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'context'}
  $scope=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s=$Context.serviceId}
  $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication}}'
  $assert={param($data)
   $svc=$data.serviceInstance;$vars=$data.variables
   if($svc.serviceId -cne $scope.s -or $svc.environmentId -cne $scope.e -or $svc.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $svc.sleepApplication -ne $true -or
      $vars.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $vars.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $vars.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or
      $vars.PHASE08_SOURCE_CONTENT_SHA256 -cne $ReviewedSourceSha256 -or $vars.PHASE08_VERIFIED_ORIGIN -cne $Context.origin -or $vars.PHASE08_ACTIVATED -cne 'true' -or
      $vars.DAILY_SYNC_FEATURE_ENABLED -cne 'true' -or $vars.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or $vars.DAILY_SYNC_SCHEDULES -cne '[]' -or
      $vars.DAILY_SYNC_ALLOWED_ACCOUNTS -cne '["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'){throw 'target-or-schedule'}
  }
  $current=& $Railway $query $scope;& $assert $current
  # Existing version/dropdown observation dates are preserved. The v1 review date
  # records adopting the established all-items contract for this new scheduler;
  # it does not assert newly observed orders or provider parity.
  $today=[TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow,'Korea Standard Time').ToString('yyyy-MM-dd')
  $oldest=[DateTime]::ParseExact($today,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture).AddDays(-30).ToString('yyyy-MM-dd')
  if($ReviewedV1Date -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or
     [DateTime]::ParseExact($ReviewedV1Date,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture).ToString('yyyy-MM-dd') -cne $ReviewedV1Date -or
     $ReviewedV1Date -cgt $today -or $ReviewedV1Date -clt $oldest -or '2026-10-01' -clt $oldest){throw 'evidence-date'}
  $values=@{
   DAILY_SYNC_CAFE24_SCHEDULED_BOOTSTRAP_ENABLED='true';
   DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED='true';
   DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE='API_ACTUAL_PRODUCT_PLUS_SHIPPING';
   DAILY_SYNC_CAFE24_APP_API_VERSION='2026-09-01';DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT='2026-10-01';
   DAILY_SYNC_CAFE24_SELLER_DROPDOWN='true';DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT='2026-10-01';
   DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED='true';DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT=$ReviewedV1Date;
   DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["C40","C48","E00","N30","N40","R00","R30","R40"]'
  }
  if($Mode -ceq 'Prepare') {
   foreach($key in $values.Keys){if($current.variables.PSObject.Properties[$key] -and -not [string]::IsNullOrEmpty($current.variables.$key)){throw 'existing-inspect-before-overwrite'}}
   $outcome=& $Railway 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId=$scope.p;environmentId=$scope.e;serviceId=$scope.s;skipDeploys=$true;replace=$false;variables=$values}}
   if($outcome.variableCollectionUpsert -ne $true){throw 'uncertain-outcome-inspect-no-retry'}
   $readback=& $Railway $query $scope
  } else {$readback=$current}
  & $assert $readback
  foreach($key in $values.Keys){if($readback.variables.$key -cne $values[$key]){throw 'readback'}}
  return @{state='PHASE08_CAFE24_SCHEDULED_CONFIGURATION_VERIFIED';mode=$Mode;variables=$values.Count;newServiceChanges=if($Mode -ceq 'Prepare'){1}else{0};
   scheduleEnabled=$false;schedules=0;providerRequests=0;csvUploads=0;operatingChanges=0;deploymentStarted=$false;requiresReviewedCliUp=($Mode -ceq 'Prepare')}
 } finally {if($values){$values.Clear()};$current=$null;$readback=$null;$values=$null;$outcome=$null}
}
