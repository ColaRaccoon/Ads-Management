param([Parameter(Mandatory)][string]$ConfigurationPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduled-observation-helpers.ps1"
$stage='PUBLIC_PINS';$context=$null;$headers=$null;$body=$null;$base=$null
try {
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins;$definition=Read-Phase08SchedulerDefinitions $ConfigurationPath
 Assert-Phase08FutureProbe $definition.definitions
 $stage='PROTECTED_CONTEXT';$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='BEFORE';$before=Get-Phase08ProbeCounts;$deploymentBefore=Get-Phase08ObservedDeployment $pins
 $base=@{scheduleKey=$definition.definitions[0].key;scheduledFor=$definition.definitions[0].anchorAt};$cases=@()
 foreach($variant in @('missing','bad','probe','wrong-target')) {
  $stage='HTTP_AUTH_'+$variant
  $headers=@{'x-daily-sync-target'=$pins.identity.targetId}
  switch($variant){'bad'{$headers['x-daily-sync-token']='SYNTHETIC_INVALID_TOKEN_ONLY'}'probe'{$headers['x-daily-sync-token']=$context.env.INTERNAL_PROBE_TOKEN}'wrong-target'{$headers['x-daily-sync-token']=$context.env.DAILY_SYNC_MACHINE_TOKEN;$headers['x-daily-sync-target']='phase08-wrong-target'}}
  $cases+=Invoke-Phase08FutureHttp $context $pins $definition.definitions '/backend-api/internal/daily-sync' $headers $base 403 'MACHINE_SYNC_FORBIDDEN'
 }
 $stage='HTTP_UNKNOWN_KEY';$headers=@{'x-daily-sync-token'=$context.env.DAILY_SYNC_MACHINE_TOKEN;'x-daily-sync-target'=$pins.identity.targetId}
 $cases+=Invoke-Phase08FutureHttp $context $pins $definition.definitions '/backend-api/internal/daily-sync' $headers @{scheduleKey='phase08-unknown-key';scheduledFor=$base.scheduledFor} 409 'ACCOUNT_SCOPE_MISMATCH'
 foreach($field in @('fromDate','toDate','account','connectionId')) {
  $stage='HTTP_INJECTION_'+$field
  $body=@{scheduleKey=$base.scheduleKey;scheduledFor=$base.scheduledFor};$body[$field]='SYNTHETIC_INJECTED_VALUE'
  $headers=@{'x-daily-sync-token'=$context.env.DAILY_SYNC_MACHINE_TOKEN;'x-daily-sync-target'=$pins.identity.targetId}
  $cases+=Invoke-Phase08FutureHttp $context $pins $definition.definitions '/backend-api/internal/daily-sync' $headers $body 400 ''
 }
 foreach($row in $definition.definitions) {
  $stage='HTTP_FUTURE_'+$row.provider
  $headers=@{'x-daily-sync-token'=$context.env.DAILY_SYNC_MACHINE_TOKEN;'x-daily-sync-target'=$pins.identity.targetId}
  $cases+=Invoke-Phase08FutureHttp $context $pins $definition.definitions '/backend-api/internal/daily-sync/status' $headers @{scheduleKey=$row.key;scheduledFor=$row.anchorAt} 400 'RUN_LIMIT_EXCEEDED'
 }
 $stage='AFTER';$after=Get-Phase08ProbeCounts;$deploymentAfter=Get-Phase08ObservedDeployment $pins
 @{state='PHASE08_FUTURE_HTTP_PROBES_VERIFIED';cases=@($cases);preCounts=$before;postCounts=$after;deploymentBefore=$deploymentBefore;deploymentAfter=$deploymentAfter;providerRequests=0;scheduledCollectionStarted=$false;actualOnTimeEvidence=$false;rawResponsesSuppressed=$true}|ConvertTo-Json -Depth 10 -Compress
}catch{@{state='PHASE08_FUTURE_HTTP_PROBES_FAILED';stage=$stage;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$body=$null;$base=$null;if($headers){$headers.Clear()};$headers=$null}
