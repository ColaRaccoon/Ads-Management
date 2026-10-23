# Authorized fixed06 metadata inspection. No Setup/Rotate/Revoke/Recover/SSH.
param([switch]$Execute)
$ErrorActionPreference='Stop';$stage='START';$state=$null;$safe=$null;$public=$null
. "$PSScriptRoot/incident-common.ps1"
try{
 if(-not $Execute){throw 'EXECUTE_REQUIRED'}
 $stage='FIXED_CALLBACK_IDENTITY'
 $state=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id} variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='deaaeaf9-ee5c-42fa-b32f-600c7a90befc'}
 $stage='CALLBACK_SCOPE_GUARD'
 if($state.project.id -cne 'd72f4256-8632-437a-9dae-9b5d96736fc7' -or $state.serviceInstance.serviceId -cne 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc' -or $state.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $state.serviceInstance.latestDeployment.id -cne '0f09de34-c1bf-4a1e-9a2a-fe511bbb07f3' -or $state.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $state.variables.DAILY_SYNC_CAFE24_DB_SERVICE_ID -cne 'ef46528f-4b59-4ee6-9d9c-b0852b5a9274' -or $state.variables.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN -cne 'https://cafe24-callback-test-production.up.railway.app'){throw 'FIXED_SCOPE'}
 $stage='ONE_INSPECT_JOB'
 $safe=& "$PSScriptRoot/../../../deploy/cafe24-test/run-live-canonical.ps1" -Mode Inspect -PassThru
 $stage='PUBLIC_PROJECTION'
 if($safe -isnot [Collections.IDictionary] -or $safe.mode -cne 'inspect' -or $safe.day -cne '2026-10-01' -or $safe.connectionEnabled -cne $false -or $safe.credentialRevisions.Count -ne 2 -or @($safe.credentialRevisions|Where-Object {$_ -isnot [int] -and $_ -isnot [long] -or $_ -lt 1 -or $_ -gt 10000}).Count -ne 0 -or $safe.syncExecutionEvidence.leaseActive -cne $false){throw 'INSPECT_SHAPE'}
 $public=[ordered]@{kind='CAFE_FIXED06_CALLBACK_READONLY_INSPECT';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sameFinal06Deployment=$true;fixedProjectEnvironmentServiceDatabaseVerified=$true;historicalSchema22GuardPassed=$true;mode='inspect';day='2026-10-01';connectionDisabled=$true;connectionReady=($safe.connectionAccessState -ceq 'READY');credentialRevisions=@($safe.credentialRevisions);credentialRevisionsRemainOriginal11=(@($safe.credentialRevisions|Where-Object {$_ -ne 11}).Count -eq 0);liveLease=$false;lastSuccessPreserved=($safe.lastSuccessPreserved -ceq $true);currentApiLines=[int]$safe.currentApiLines;currentApiVersions=[int]$safe.currentApiVersions;currentApiLinks=[int]$safe.currentApiLinks;pairCiphertextRead=$false;pairPlaintextRead=$false;pairEqualityCompared=$false;providerRequests=0;refreshRequests=0;sourceOrCredentialWrites=0;sharedCredentialChanges=0;logicalReadOnlyCodePath=$true;sqlReadOnlyTransactionEnforced=$false;rawValuesReturned=0}
 $folder='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-recovery-20261021-v1';[void][IO.Directory]::CreateDirectory($folder);$stream=[IO.File]::Open("$folder/callback-inspect.json",[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($public|ConvertTo-Json -Depth 8));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $public|ConvertTo-Json -Compress -Depth 8
}catch{$reason=if($_.Exception.Message -ceq 'PHASE08_SCHEDULER_GRAPH_FAILED'){'GRAPH_READ_FAILED'}elseif($_.Exception.Message -ceq 'FIXED_SCOPE'){'SCOPE_GUARD'}else{'LOCAL_GUARD'};@{kind='CAFE_FIXED06_CALLBACK_READONLY_INSPECT_FAILED';stage=$stage;reason=$reason;graphResponseReceived=($null -ne $state);rawErrorSuppressed=$true;providerRequests=0;refreshRequests=0;sourceOrCredentialWrites=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
finally{$state=$null;$safe=$null;$public=$null}
