param([Parameter(Mandatory)][ValidateSet('Prepare','RotateDatabase','RotateRelay','InspectRelay')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$stage='START';$mutation=$false;$live=$null;$old=$null;$fresh=$null;$headers=$null
try{
 Import-Phase08SchedulerChildDefinitions
 $live=Get-IncidentState;$snapshot=Get-IncidentSnapshot;Assert-IncidentContained $snapshot
 $old=Read-IncidentPrivate 'compromised-baseline'
 if($Mode -ceq 'Prepare'){
  Assert-IncidentVarsEqual $live.variables $old.variables
  if($snapshot.runtime_role.login -cne $false -or $snapshot.runtime_backends -ne 0){throw 'NOT_ISOLATED'}
  $fresh=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'incident-core.mjs') @{action='prepare';before=$live.variables}
  Write-IncidentPrivate $fresh 'fresh-core-v2'
  Write-IncidentReceipt (@{kind='INCIDENT_FRESH_CORE_PREPARED';at=[DateTimeOffset]::UtcNow.ToString('o');protectedReference=(Join-Path $script:IncidentPrivate 'fresh-core-v2.dpapi');safe=$fresh.safeSummary;rawValuesReturned=0;remoteChanges=0}) 'core-prepared-v2'
 }elseif($Mode -ceq 'RotateDatabase'){
  $fresh=Read-IncidentPrivate 'fresh-core-v2'
  if($snapshot.runtime_role.login -cne $false -or $snapshot.runtime_backends -ne 0){throw 'DB_ROLE_ACTIVE'}
  Write-IncidentReceipt @{kind='INCIDENT_DB_PASSWORD_REPLACEMENT_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');runtimeRole='phase08_runtime';loginRemainsDisabled=$true;grantsBefore=$snapshot.runtime_grants_md5} 'db-rotate-attempt'
  $sql=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'incident-core.mjs') @{action='passwordSql';databaseUrl=$fresh.changes.DATABASE_URL}
  $stage='ONE_PASSWORD_CHANGE';$mutation=$true;$null=Invoke-Phase08Management -Action Query -Query $sql.sql
  $after=Get-IncidentSnapshot;Assert-IncidentContained $after
  if($after.runtime_role.login -cne $false -or (Get-IncidentHash $snapshot.table_digests) -cne (Get-IncidentHash $after.table_digests) -or $snapshot.runtime_grants_md5 -cne $after.runtime_grants_md5){throw 'PASSWORD_PRESERVATION'}
  Write-IncidentReceipt @{kind='INCIDENT_DB_PASSWORD_REPLACED_LOGIN_HELD';at=[DateTimeOffset]::UtcNow.ToString('o');runtimeRole='phase08_runtime';businessRowsUnchanged=$true;runtimeGrantsUnchanged=$true;runtimeLogin=$after.runtime_role.login;oldPasswordAuthenticationProof='PENDING_REENABLE_AND_NEGATIVE_TEST';rawValuesReturned=0;productionChanges=0} 'db-rotated'
 }else{
  $fresh=Read-IncidentPrivate 'fresh-core-v2';$token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)};$base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
  $reply=Invoke-WebRequest -Uri ($base+'/secrets') -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 200){throw 'EDGE_METADATA'};$before=@($reply.Content|ConvertFrom-Json -AsHashtable -Depth 15)
  $machine=@($before|Where-Object {$_.name -ceq 'PHASE08_RELAY_MACHINE_TOKEN'})
  if($machine.Count -ne 1){throw 'EDGE_MACHINE_METADATA'}
  $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fresh.changes.DAILY_SYNC_MACHINE_TOKEN))).ToLowerInvariant()
  if($Mode -ceq 'InspectRelay'){@{kind='INCIDENT_RELAY_SAFE_INSPECT';freshTokenDigestMatches=($machine[0].value -ceq $hash);secretNames=@($before.name);rawValuesReturned=0;remoteWrites=0}|ConvertTo-Json -Depth 6;exit 0}
  $oldHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($old.variables.DAILY_SYNC_MACHINE_TOKEN))).ToLowerInvariant()
  if($machine[0].value -cne $oldHash){throw 'EDGE_BEFORE_TOKEN_CHANGED'}
  Write-IncidentPrivate @{secrets=$before} 'relay-metadata-before'
  Write-IncidentReceipt @{kind='INCIDENT_RELAY_MACHINE_ROTATION_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');changedNames=@('PHASE08_RELAY_MACHINE_TOKEN');otherSecretNames=@($before|Where-Object{$_.name -cne 'PHASE08_RELAY_MACHINE_TOKEN'}|ForEach-Object{$_.name})} 'relay-rotate-attempt'
  $payload=ConvertTo-Json -InputObject @(@{name='PHASE08_RELAY_MACHINE_TOKEN';value=$fresh.changes.DAILY_SYNC_MACHINE_TOKEN}) -Compress
  $stage='ONE_EDGE_SECRET_REPLACE';$mutation=$true;$reply=Invoke-WebRequest -Uri ($base+'/secrets') -Headers $headers -Method Post -ContentType 'application/json' -Body $payload -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 201){throw 'EDGE_WRITE_UNKNOWN'}
  $reply=Invoke-WebRequest -Uri ($base+'/secrets') -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 200){throw 'EDGE_READBACK'};$after=@($reply.Content|ConvertFrom-Json -AsHashtable -Depth 15)
  if($after.Count -ne $before.Count){throw 'EDGE_SECRET_COUNT'}
  foreach($prior in $before){$found=@($after|Where-Object {$_.name -ceq $prior.name});if($found.Count -ne 1){throw 'EDGE_SECRET_NAME'};if($prior.name -ceq 'PHASE08_RELAY_MACHINE_TOKEN'){if($found[0].value -cne $hash){throw 'EDGE_NEW_TOKEN'}}elseif($found[0].value -cne $prior.value){throw 'EDGE_UNRELATED_SECRET_CHANGED'}}
  Write-IncidentReceipt @{kind='INCIDENT_RELAY_MACHINE_TOKEN_ROTATED';at=[DateTimeOffset]::UtcNow.ToString('o');changedSecretCount=1;allOtherSecretsPreserved=$true;relayFunctionRedeployed=$false;runtimeActivationVerification='PENDING';providerRequests=0;productionChanges=0} 'relay-rotated'
 }
 @{kind='INCIDENT_CORE_ACTION_COMPLETED';mode=$Mode;at=[DateTimeOffset]::UtcNow.ToString('o');rawValuesReturned=0;productionChanges=0}|ConvertTo-Json
}catch{@{kind='INCIDENT_CORE_ACTION_SAFE_REJECTION';mode=$Mode;stage=$stage;outcomeUncertain=$mutation;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{if($headers){$headers.Clear()};$headers=$null;$token=$null;$payload=$null;$live=$null;$old=$null;$fresh=$null;$sql=$null;$reply=$null;$before=$null;$after=$null;$machine=$null}
