Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/cafe24-oauth-configuration.ps1"
function Assert-Test($condition){if(-not $condition){throw 'PHASE08_CAFE_CONFIG_SYNTHETIC_ASSERT'}}
$context=[pscustomobject]@{projectRef='ehnfrrmbkvlsbpvqcvkr';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c';origin='https://phase08-daily-data-sync-production.up.railway.app'}
$script:secret='SYNTHETIC_CLIENT_SECRET_NEVER_OUTPUT'
function New-Fixture {
  $script:old=[pscustomobject]@{serviceInstance=[pscustomobject]@{serviceId='deaaeaf9-ee5c-42fa-b32f-600c7a90befc';environmentId='d261a432-a6a4-4031-b8ea-c619ac263cc3'};
    variables=[pscustomobject]@{DAILY_SYNC_FEATURE_ENABLED='false';DAILY_SYNC_CAFE24_ISOLATED_ORIGIN='https://cafe24-callback-test-production.up.railway.app';DAILY_SYNC_CAFE24_REDIRECT_URI='https://cafe24-callback-test-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback';DAILY_SYNC_CAFE24_CLIENT_ID='tVV6DZtPOFRlpPk1ex7ISA';DAILY_SYNC_CAFE24_CLIENT_SECRET=$script:secret;DAILY_SYNC_CAFE24_MALL_ID='didadi0729';DAILY_SYNC_CAFE24_SHOP_KEY='shop1'}}
  $script:new=[pscustomobject]@{serviceInstance=[pscustomobject]@{serviceId=$context.serviceId;environmentId='d261a432-a6a4-4031-b8ea-c619ac263cc3';startCommand='node deploy/cloud/phase08-launch.mjs';sleepApplication=$true};
    variables=[pscustomobject]@{SUPABASE_DATABASE_PROJECT_REF='ehnfrrmbkvlsbpvqcvkr';SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_DATABASE_RUNTIME_USER='phase08_runtime';PHASE08_SOURCE_CONTENT_SHA256='b361da10cf16c0955ca0dc8c51bff195f289d6e8c7aae934f81f030b42a68e81';PHASE08_VERIFIED_ORIGIN=$context.origin;PHASE08_ACTIVATED='true';DAILY_SYNC_FEATURE_ENABLED='true';DAILY_SYNC_SCHEDULE_ENABLED='false';DAILY_SYNC_SCHEDULES='[]';DAILY_SYNC_ALLOWED_ACCOUNTS='["GOOGLE/1391592099/default","META/2138525300002203/default","CAFE24/didadi0729/shop1"]'}}
  $script:mutations=0;$script:oldQueries=0;$script:badReadback=$false
}
$mock={param($query,$variables)
  if($query.StartsWith('mutation')) {
    Assert-Test ($variables.input.serviceId -ceq $context.serviceId -and $variables.input.projectId -ceq 'd72f4256-8632-437a-9dae-9b5d96736fc7' -and $variables.input.skipDeploys -eq $true -and $variables.input.replace -eq $false)
    Assert-Test ($variables.input.variables.Count -eq 4 -and $query -notmatch 'deploymentRedeploy')
    foreach($key in $variables.input.variables.Keys){$script:new.variables|Add-Member -NotePropertyName $key -NotePropertyValue $variables.input.variables[$key] -Force}
    $script:mutations++;if($script:badReadback){$script:new.variables.DAILY_SYNC_CAFE24_REDIRECT_URI='https://patimagroup-work.com'}
    return [pscustomobject]@{variableCollectionUpsert=$true}
  }
  if($variables.s -ceq 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc'){$script:oldQueries++;return $script:old};return $script:new
}
New-Fixture
$result=Invoke-Phase08CafeOAuthConfiguration 'Prepare' $context $mock
Assert-Test ($result.newServiceMutations -eq 1 -and $result.deploymentStarted -eq $false -and $script:mutations -eq 1 -and $script:oldQueries -eq 1 -and -not ($result|ConvertTo-Json).Contains($script:secret))
$result=Invoke-Phase08CafeOAuthConfiguration 'Status' $context $mock
Assert-Test ($result.newServiceMutations -eq 0 -and $script:mutations -eq 1)
foreach($field in @('old-feature','old-client','new-ref','new-schedule','new-source','old-origin','new-command','existing-config','readback')) {
  New-Fixture
  switch($field) {
    'old-feature' {$script:old.variables.DAILY_SYNC_FEATURE_ENABLED='true'}
    'old-client' {$script:old.variables.DAILY_SYNC_CAFE24_CLIENT_ID='wrong'}
    'new-ref' {$script:new.variables.SUPABASE_DATABASE_PROJECT_REF='iygjmosbelbosfxidqxv'}
    'new-schedule' {$script:new.variables.DAILY_SYNC_SCHEDULE_ENABLED='true'}
    'new-source' {$script:new.variables.PHASE08_SOURCE_CONTENT_SHA256='0'*64}
    'old-origin' {$script:old.variables.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN='https://grand-fascination-staging.up.railway.app'}
    'new-command' {$script:new.serviceInstance.startCommand='different'}
    'existing-config' {$script:new.variables|Add-Member -NotePropertyName DAILY_SYNC_CAFE24_CLIENT_SECRET -NotePropertyValue 'existing'}
    'readback' {$script:badReadback=$true}
  }
  $rejected=$false;try{$discard=Invoke-Phase08CafeOAuthConfiguration 'Prepare' $context $mock}catch{$rejected=$true}
  Assert-Test $rejected;Assert-Test ($script:mutations -eq $(if($field -ceq 'readback'){1}else{0}))
}
@{state='PHASE08_CAFE24_OAUTH_CONFIGURATION_SYNTHETIC_PASS';cases=11;networkRequests=0;credentialReads=0;providerRequests=0}|ConvertTo-Json
