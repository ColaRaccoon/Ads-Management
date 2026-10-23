Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/source-connection-helpers.ps1"
function Assert-Test($condition){if(-not $condition){throw 'PHASE08_SOURCE_SYNTHETIC_ASSERT'}}
$context=[pscustomobject]@{projectRef='ehnfrrmbkvlsbpvqcvkr';origin='https://phase08-daily-data-sync-production.up.railway.app';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c';
  env=[pscustomobject]@{SUPABASE_URL='https://ehnfrrmbkvlsbpvqcvkr.supabase.co';SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_DATABASE_PROJECT_REF='ehnfrrmbkvlsbpvqcvkr';SUPABASE_DATABASE_RUNTIME_USER='phase08_runtime';DEPLOYMENT_ENVIRONMENT_ID='phase08-daily-data-sync-08'};
  ids=[pscustomobject]@{metaConnectionId='33333333-3333-3333-3333-333333333333'}}
$operator=[pscustomobject]@{projectRef='ehnfrrmbkvlsbpvqcvkr';schema='phase08_meta_ads';appId='22222222-2222-2222-2222-222222222222';authId='11111111-1111-1111-1111-111111111111';email='phase08-eval-11111111-1111-1111-1111-111111111111@example.invalid'}
Assert-Phase08SourceContext $context $operator
foreach($provider in @('GOOGLE','META','CAFE24')) {
  $input=Get-Phase08ConnectionInput $provider
  $row=[pscustomobject]($input+@{id='44444444-4444-4444-4444-444444444444';enabled=$false;accessState='PENDING'})
  Assert-Phase08Connection $row $provider -Pending
  $row.enabled=$true;$rejected=$false;try{Assert-Phase08Connection $row $provider -Pending}catch{$rejected=$true};Assert-Test $rejected
}
foreach($origin in @('https://grand-fascination-staging.up.railway.app','https://patimagroup-work.com')){
  $context.origin=$origin;$rejected=$false;try{Assert-Phase08SourceContext $context $operator}catch{$rejected=$true};Assert-Test $rejected
}
$context.origin='https://phase08-daily-data-sync-production.up.railway.app'
$google=New-Phase08VerificationDto 'GOOGLE' '2026-10-04' '2026-10-04' '123' ''
Assert-Test ($google.Keys.Count -eq 3 -and $google.observedAccountCostKrw -ceq '123')
$meta=New-Phase08VerificationDto 'META' '2026-10-04' '2026-10-04' '1.2300' 'REQUIRE_VERIFIED_CONDITIONALS'
Assert-Test ($meta.Keys.Count -eq 4 -and $meta.observedAccountSpendUsd -ceq '1.2300')
foreach($args in @(@('GOOGLE','2026-02-30','2026-02-01','1',''),@('GOOGLE','2026-10-04','2026-10-04','01',''),@('GOOGLE','2026-10-04','2026-09-04','1',''),@('META','2026-10-04','2026-10-04','1',''),@('META','2026-10-04','2026-10-04','1.00001','REQUIRE_VERIFIED_CONDITIONALS'))){
  $rejected=$false;try{$discard=New-Phase08VerificationDto @args}catch{$rejected=$true};Assert-Test $rejected
}
$sql=New-Phase08MetaPendingSql $context $operator
Assert-Test ($sql.Contains("NULL,NULL,'PENDING',false") -and $sql.Contains("'USER','$($operator.appId)'::uuid") -and $sql.Contains("WHERE id='$($context.ids.metaConnectionId)'::uuid OR provider='META'"))
Assert-Test ($sql -notmatch '(?i)\b(UPDATE|DELETE|source_policies|source_credentials)\b' -and $sql -notmatch "'READY'")
Assert-Test ([regex]::Matches($sql,'INSERT INTO').Count -eq 2 -and $sql.StartsWith('-- PHASE08 ONLY: ehnfrrmbkvlsbpvqcvkr'))
[ordered]@{state='PHASE08_SOURCE_HELPERS_SYNTHETIC_PASS';networkRequests=0;credentialReads=0;providerQueries=0}|ConvertTo-Json
