Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020/reopened-hold-baseline.json'
$live=$null;$snapshot=$null;$deployment=$null;$prior=$null;$stage='START'
try {
 if(Test-Path -LiteralPath $destination){throw 'RECEIPT_CONSUMED'}
 $stage='FRESH_FIXED_TARGET';$live=Get-IncidentState;$snapshot=Get-IncidentSnapshot;Assert-IncidentContained $snapshot
 $deployment=(Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){latestDeployment{id deploymentStopped} activeDeployments{id deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}).serviceInstance
 if($live.serviceInstance.latestDeployment.id -cne '39c6b738-6d2f-4111-a97b-37f017b39886' -or $live.serviceInstance.latestDeployment.meta.imageDigest -cne 'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0' -or $deployment.latestDeployment.id -cne $live.serviceInstance.latestDeployment.id -or $deployment.latestDeployment.deploymentStopped -cne $true -or @($deployment.activeDeployments|Where-Object {$_.deploymentStopped -cne $true}).Count -ne 0 -or $snapshot.runtime_role.login -cne $false -or $snapshot.runtime_backends -ne 0 -or $live.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $live.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false'){throw 'HELD_STATE_REQUIRED'}
 $stage='PRIOR_TABLE_COMPARISON';$prior=Get-Content -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v4/final-held.json' -Raw|ConvertFrom-Json -Depth 40 -DateKind String
 if((Get-IncidentHash $prior.snapshot.table_digests) -cne (Get-IncidentHash $snapshot.table_digests)){throw 'BEFORE68_CHANGED'}
 $names=@('runtime_grants_md5','job_definitions_md5','other_jobs_md5','original152_md5','call_md5','storage_objects_md5')
 foreach($name in $names){if([string]::IsNullOrWhiteSpace($snapshot.$name) -or $snapshot.$name -cne $prior.snapshot.$name){throw 'PRESERVATION_DIGEST_CHANGED'}}
 $proof=@{kind='PHASE10_REOPENED_FRESH_HELD_BASELINE';status='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');snapshot=$snapshot;deployment=$deployment.latestDeployment;unstopped=0;all68SameAsPriorFinal=$true;sixPreservationDigestsSame=$true;variablesHash=(Get-IncidentVariableHash $live.variables);sharedCredentialChanges=0;operatingChanges=0;providerCalls=0;appHttpCalls=0;remoteMutations=0;rawValuesReturned=0;normalResume=$false;stages11And12Started=$false}
 $file=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$file.Write([Text.Encoding]::UTF8.GetBytes(($proof|ConvertTo-Json -Depth 40)));$file.Flush($true)}finally{$file.Dispose()}
 @{status='PASS';all68SameAsPriorFinal=$true;sixPreservationDigestsSame=$true;noLoginBackend0Stopped=$true;evidence=$destination;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{
 @{status='FAIL';safeStage=$stage;rawErrorSuppressed=$true;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1
}finally{$live=$null;$snapshot=$null;$deployment=$null;$prior=$null}
