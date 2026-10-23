Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/cafe24-scheduled-configuration.ps1"
function Assert-Test($ok){if(-not $ok){throw 'PHASE08_SCHEDULED_CONFIG_SYNTHETIC_ASSERT'}}
$context=[pscustomobject]@{projectRef='ehnfrrmbkvlsbpvqcvkr';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c';origin='https://phase08-daily-data-sync-production.up.railway.app'}
$hash='b'*64
$reviewDate='2026-10-14'
function New-Fixture {
 $script:new=[pscustomobject]@{serviceInstance=[pscustomobject]@{serviceId=$context.serviceId;environmentId='d261a432-a6a4-4031-b8ea-c619ac263cc3';startCommand='node deploy/cloud/phase08-launch.mjs';sleepApplication=$true};
  variables=[pscustomobject]@{SUPABASE_DATABASE_PROJECT_REF='ehnfrrmbkvlsbpvqcvkr';SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_DATABASE_RUNTIME_USER='phase08_runtime';
   PHASE08_SOURCE_CONTENT_SHA256=$hash;PHASE08_VERIFIED_ORIGIN=$context.origin;PHASE08_ACTIVATED='true';DAILY_SYNC_FEATURE_ENABLED='true';DAILY_SYNC_SCHEDULE_ENABLED='false';
   DAILY_SYNC_SCHEDULES='[]';DAILY_SYNC_ALLOWED_ACCOUNTS='["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'}}
 $script:mutations=0;$script:badReadback=$false
}
$mock={param($query,$vars)
 Assert-Test ($(if($query.StartsWith('mutation')){$vars.input.serviceId}else{$vars.s}) -ceq $context.serviceId)
 if($query.StartsWith('mutation')) {
  Assert-Test ($vars.input.projectId -ceq 'd72f4256-8632-437a-9dae-9b5d96736fc7' -and $vars.input.environmentId -ceq 'd261a432-a6a4-4031-b8ea-c619ac263cc3')
  Assert-Test ($vars.input.skipDeploys -eq $true -and $vars.input.replace -eq $false -and $vars.input.variables.Count -eq 10)
  Assert-Test (-not $vars.input.variables.ContainsKey('DAILY_SYNC_SCHEDULE_ENABLED') -and -not $vars.input.variables.ContainsKey('DATABASE_URL'))
  foreach($key in $vars.input.variables.Keys){$script:new.variables|Add-Member -NotePropertyName $key -NotePropertyValue $vars.input.variables[$key] -Force}
  $script:mutations++
  if($script:badReadback){$script:new.variables.DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE='UNKNOWN'}
  return [pscustomobject]@{variableCollectionUpsert=$true}
 }
 return $script:new
}
New-Fixture
$result=Invoke-Phase08CafeScheduledConfiguration 'Prepare' $hash $reviewDate $context $mock
Assert-Test ($result.newServiceChanges -eq 1 -and $script:mutations -eq 1 -and $result.deploymentStarted -eq $false)
$result=Invoke-Phase08CafeScheduledConfiguration 'Status' $hash $reviewDate $context $mock
Assert-Test ($result.newServiceChanges -eq 0 -and $script:mutations -eq 1)
foreach($case in @('ref','schema','runtime','source','origin','command','sleep','schedule','list','allowlist','existing','readback')) {
 New-Fixture
 switch($case) {
  'ref' {$script:new.variables.SUPABASE_DATABASE_PROJECT_REF='iygjmosbelbosfxidqxv'}
  'schema' {$script:new.variables.SUPABASE_DATABASE_SCHEMA='meta_ads'}
  'runtime' {$script:new.variables.SUPABASE_DATABASE_RUNTIME_USER='meta_ads_prod_runtime'}
  'source' {$script:new.variables.PHASE08_SOURCE_CONTENT_SHA256='c'*64}
  'origin' {$script:new.variables.PHASE08_VERIFIED_ORIGIN='https://patimagroup-work.com'}
  'command' {$script:new.serviceInstance.startCommand='wrong'}
  'sleep' {$script:new.serviceInstance.sleepApplication=$false}
  'schedule' {$script:new.variables.DAILY_SYNC_SCHEDULE_ENABLED='true'}
  'list' {$script:new.variables.DAILY_SYNC_SCHEDULES='[{}]'}
  'allowlist' {$script:new.variables.DAILY_SYNC_ALLOWED_ACCOUNTS='[]'}
  'existing' {$script:new.variables|Add-Member -NotePropertyName DAILY_SYNC_CAFE24_SCHEDULED_BOOTSTRAP_ENABLED -NotePropertyValue 'true'}
  'readback' {$script:badReadback=$true}
 }
 $rejected=$false
 try{$discard=Invoke-Phase08CafeScheduledConfiguration 'Prepare' $hash $reviewDate $context $mock}catch{$rejected=$true}
 Assert-Test $rejected
 Assert-Test ($script:mutations -eq $(if($case -ceq 'readback'){1}else{0}))
}
foreach($date in @('2026-99-14','2026-10-1','2000-01-01','2099-01-01')) {
 New-Fixture;$rejected=$false
 try{$discard=Invoke-Phase08CafeScheduledConfiguration 'Prepare' $hash $date $context $mock}catch{$rejected=$true}
 Assert-Test ($rejected -and $script:mutations -eq 0)
}
@{state='PHASE08_CAFE24_SCHEDULED_CONFIGURATION_SYNTHETIC_PASS';cases=18;networkRequests=0;credentialReads=0;providerRequests=0}|ConvertTo-Json
