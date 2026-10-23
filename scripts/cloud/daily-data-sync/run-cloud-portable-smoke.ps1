param([Parameter(Mandatory)][ValidateSet('Start','Status','Restore')][string]$Mode,[string]$DeploymentId)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
$phase08Headers=$null;$phase08Context=$null;$phase08Cfg=$null
$phase08DefaultCommand='node deploy/cloud/phase08-launch.mjs'
function Invoke-Phase08Railway([string]$Query,[hashtable]$Variables){
  $body=@{query=$Query;variables=$Variables}|ConvertTo-Json -Depth 15 -Compress
  $result=Invoke-RestMethod -Uri 'https://backboard.railway.com/graphql/v2' -Method Post -Headers $phase08Headers -ContentType 'application/json' -Body $body -MaximumRedirection 0 -TimeoutSec 30
  if($result.PSObject.Properties['errors']){throw 'outcome-inspect-no-retry'}
  return $result.data
}
function Convert-Phase08SmokeLogSummary($line) {
  $keys=@('state','googleState','metaState','providerRequests','googleSdkRequestsFullyObserved','datedStatsRequests','mcpInsightsRequests','dbWrites')
  $selected=@{}
  if($line.PSObject.Properties['attributes']) {
    foreach($attribute in $line.attributes) {
      if($attribute.key -cin $keys) {
        if($selected.ContainsKey($attribute.key) -or $attribute.value -isnot [string] -or $attribute.value.Length -gt 1024){throw 'summary-attribute'}
        # Railway structured values are JSON encoded; unrelated keys are never parsed or emitted.
        $selected[$attribute.key]=$attribute.value|ConvertFrom-Json
      }
    }
  }
  if($selected.ContainsKey('state')){$value=[pscustomobject]$selected}
  elseif($line.PSObject.Properties['message'] -and $line.message -is [string] -and $line.message -cmatch '^\{"state":"PORTABLE_') {
    if($line.message.Length -gt 4096){throw 'summary-size'}
    $value=$line.message|ConvertFrom-Json
  } else {return $null}
  if($value.state -cin @('PORTABLE_SMOKE_TIMEOUT','PORTABLE_BOOTSTRAP_FAILED','PORTABLE_BUNDLE_FAILED')){return @{state=$value.state}}
  if($value.state -cnotin @('PORTABLE_METADATA_VERIFIED','PORTABLE_METADATA_PARTIAL')){return $null}
  if($value.googleState -cnotin @('GOOGLE_METADATA_VERIFIED','GOOGLE_METADATA_FAILED') -or $value.metaState -cnotin @('META_METADATA_VERIFIED','META_METADATA_FAILED') -or
    $value.googleSdkRequestsFullyObserved -isnot [bool] -or $value.googleSdkRequestsFullyObserved -ne $false -or
    $value.datedStatsRequests -ne 0 -or $value.mcpInsightsRequests -ne 0 -or $value.dbWrites -ne 0){throw 'summary'}
  foreach($key in @('datedStatsRequests','mcpInsightsRequests','dbWrites')) {
    if($value.$key -isnot [long] -and $value.$key -isnot [int]){throw 'summary-zero-type'}
  }
  $counts=@{}
  foreach($key in @('googleAdsPost','metaGraphGet','googleSdkFetchObserved')) {
    $count=$value.providerRequests.$key
    if(($count -isnot [long] -and $count -isnot [int]) -or $count -lt 0 -or $count -gt 1000){throw 'count'}
    $counts[$key]=$count
  }
  return @{state=$value.state;googleState=$value.googleState;metaState=$value.metaState;providerRequests=$counts;
    googleSdkRequestsFullyObserved=$false;datedStatsRequests=0;mcpInsightsRequests=0;dbWrites=0}
}
try {
  $phase08Cfg=Get-Content -Raw -LiteralPath (Join-Path $env:USERPROFILE '.railway/config.json')|ConvertFrom-Json
  $phase08Headers=@{Authorization=('Bearer '+$phase08Cfg.user.accessToken)}
  $target=@{environmentId='d261a432-a6a4-4031-b8ea-c619ac263cc3';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
  $identity=Invoke-Phase08Railway 'query($environmentId:String!,$serviceId:String!){serviceInstance(environmentId:$environmentId,serviceId:$serviceId){serviceId environmentId startCommand sleepApplication latestDeployment{id status}}}' $target
  $instance=$identity.serviceInstance
  if($instance.serviceId -cne $target.serviceId -or $instance.environmentId -cne $target.environmentId -or $instance.sleepApplication -ne $true){throw 'target'}
  if($Mode -eq 'Status'){
    if($DeploymentId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $DeploymentId -cne $instance.latestDeployment.id){throw 'latest-deployment-required'}
    $logs=Invoke-Phase08Railway 'query($id:String!){deploymentLogs(deploymentId:$id,limit:300){message attributes{key value}}}' @{id=$DeploymentId}
    $summaries=@()
    foreach($line in $logs.deploymentLogs){
      $summary=Convert-Phase08SmokeLogSummary $line
      if($null -ne $summary){$summaries+=$summary}
    }
    @{state='PHASE08_CLOUD_SMOKE_STATUS';deploymentId=$DeploymentId;deploymentStatus=$instance.latestDeployment.status;smokeSummaries=$summaries;rawLogsSuppressed=$true}|ConvertTo-Json -Depth 8
  } else {
    $source=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'cloud-portable-smoke.mjs'))
    if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($source)).ToLowerInvariant() -cne '03b921fe7b858faaf4721834175ed95b7d6a195aa4a97641794bcee5a840f340'){throw 'reviewed-source'}
    $inline='node --input-type=module -e ''await import("data:text/javascript;base64,'+[Convert]::ToBase64String($source)+'")'''
    [Array]::Clear($source,0,$source.Length)
    if($Mode -eq 'Start'){
      if($null -ne $instance.startCommand -and $instance.startCommand -ne '' -and $instance.startCommand -cne $phase08DefaultCommand){throw 'fresh-command-required'}
      $reviewedDeployment=if($DeploymentId){$DeploymentId}else{'f6755f54-453c-443c-9232-3c8e595a6b35'}
      if($reviewedDeployment -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $instance.latestDeployment.id -cne $reviewedDeployment){throw 'reviewed-deployment-required'}
      $phase08Context=Read-Phase08ProtectedJson
      if($phase08Context.serviceId -cne $target.serviceId -or $phase08Context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $phase08Context.env.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $phase08Context.env.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false'){throw 'context'}
      $discard=Invoke-Phase08Railway 'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}' @{input=@{projectId='d72f4256-8632-437a-9dae-9b5d96736fc7';environmentId=$target.environmentId;serviceId=$target.serviceId;skipDeploys=$true;variables=@{PHASE08_META_CONNECTION_ID=$phase08Context.ids.metaConnectionId}}}
      if($discard.variableCollectionUpsert -ne $true){throw 'variables-outcome'}
      $target.input=@{startCommand=$inline}
    } else {
      if($instance.startCommand -cne $inline){throw 'expected-smoke-command-required'}
      # Railway currently ignores explicit null; use the reviewed Docker CMD instead.
      $target.input=@{startCommand=$phase08DefaultCommand}
    }
    $discard=Invoke-Phase08Railway 'mutation($environmentId:String,$serviceId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input)}' $target
    if($discard.serviceInstanceUpdate -ne $true){throw 'command-outcome'}
    $readback=Invoke-Phase08Railway 'query($environmentId:String!,$serviceId:String!){serviceInstance(environmentId:$environmentId,serviceId:$serviceId){serviceId environmentId startCommand sleepApplication}}' @{environmentId=$target.environmentId;serviceId=$target.serviceId}
    if($readback.serviceInstance.serviceId -cne $target.serviceId -or $readback.serviceInstance.environmentId -cne $target.environmentId -or
      $readback.serviceInstance.sleepApplication -ne $true -or $readback.serviceInstance.startCommand -cne $target.input.startCommand){throw 'command-readback'}
    # Redeploy reuses a deployment's old service config and does not apply this startCommand.
    # Root must submit the reviewed v3 source with CLI up as a separate explicit action.
    @{state='PHASE08_CLOUD_SMOKE_CONFIG_PREPARED';mode=$Mode;configurationReadbackVerified=$true;requiresReviewedCliUp=$true;deploymentStarted=$false;operatingChanges=0;scheduledStatsRequests=0}|ConvertTo-Json -Depth 6
  }
} catch {@{state='PHASE08_CLOUD_SMOKE_CONTROL_FAILED';mode=$Mode;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally {$phase08Context=$null;$phase08Cfg=$null;$inline=$null;$logs=$null;$identity=$null;$redeploy=$null;if($phase08Headers){$phase08Headers.Clear()};$phase08Headers=$null}
