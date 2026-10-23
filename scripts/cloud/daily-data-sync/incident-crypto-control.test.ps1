Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-crypto-control.ps1"
$script:testPassed=0
function Assert-CryptoTest([bool]$Condition){if(-not $Condition){throw 'INCIDENT_CRYPTO_SYNTHETIC_TEST_FAILED'}}
try{
 # Real protected child IPC, captured in memory; never emit its secret return.
 $childKeys=Invoke-IncidentCryptoOffline @{operation='GENERATE'}
 Assert-CryptoTest ($childKeys.Keys.Count -eq 3);Assert-CryptoTest (@($childKeys.Values|Sort-Object -Unique).Count -eq 3);$childKeys=$null;$script:testPassed++
 $childSnapshot=Invoke-IncidentCryptoOffline @{operation='SNAPSHOT_SQL'};Assert-CryptoTest ($childSnapshot.sql.Contains('WITH bounds'));$childSnapshot=$null;$script:testPassed++
 # Remaining checks exercise orchestration with synthetic protected-memory
 # storage and a MOCK management transport. No actual DPAPI/remote state used.
 $script:fakePrivate=@{ 'compromised-baseline'=@{eligibleAsSecretRollback=$false;variables=@{DAILY_SYNC_CREDENTIAL_KEY_V1='SYNTHETIC_OLD_CREDENTIAL';DAILY_SYNC_CHECKPOINT_KEY_B64='SYNTHETIC_OLD_CHECKPOINT'}} }
 $script:fakeWrites=0;$script:fakeContained=$true;$script:fakeUnknown=$false
 $script:IncidentCryptoReceiptRoot=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/crypto' ('wrapper-synthetic-'+[Guid]::NewGuid().ToString('N'))
 function Read-IncidentPrivate([string]$Name){if(-not $script:fakePrivate.ContainsKey($Name)){throw 'SYNTHETIC_PRIVATE_MISSING'};return ($script:fakePrivate[$Name]|ConvertTo-Json -Depth 45 -Compress|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)}
 function Write-IncidentPrivate($Value,[string]$Name){if($script:fakePrivate.ContainsKey($Name)){throw 'SYNTHETIC_PRIVATE_EXISTS'};$script:fakePrivate[$Name]=($Value|ConvertTo-Json -Depth 45 -Compress|ConvertFrom-Json -AsHashtable -Depth 45 -DateKind String)}
 function Get-IncidentState{return @{serviceInstance=@{latestDeployment=@{id='33677c6c-2142-4938-b7f0-95e96f5de86b';status='SLEEPING'}};variables=@{PHASE08_SOURCE_CONTENT_SHA256='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1';DAILY_SYNC_CREDENTIAL_KEY_V1='SYNTHETIC_OLD_CREDENTIAL'}}}
 function Get-IncidentSnapshot{return @{stopped=$script:fakeContained;paused=3;active_jobs=0;live_leases=0;runtime_role=@{login=$false};runtime_backends=0;table_digests=@(@{table='products';rows=1;md5='SYNTHETIC_SAME'});job_definitions_md5='same';other_jobs_md5='same';original152_md5='same';call_md5='same';runtime_grants_md5='same'}}
 function Get-IncidentCryptoSnapshot{return @{credentials=@(@{kind='CAFE24_ACCESS'},@{kind='CAFE24_REFRESH'});checkpoints=@(@{unitKey='2026-10-17'})}}
 function Invoke-IncidentCryptoOffline($Value){switch -CaseSensitive ($Value.operation){
  'GENERATE' {return @{credentialV2='SYNTHETIC_NEW_CREDENTIAL';checkpoint='SYNTHETIC_NEW_CHECKPOINT';observationV2='SYNTHETIC_NEW_OBSERVATION'}}
  'PREPARE' {return @{mutationSql='SYNTHETIC_EXACT_CAS_SQL';safeSummary=@{preparedOnly=$true;mutationExecuted=$false};environmentUpdate=@{set=@{DAILY_SYNC_CREDENTIAL_KEY_V2=$Value.input.newKeys.credentialV2;DAILY_SYNC_CHECKPOINT_KEY_B64=$Value.input.newKeys.checkpoint;DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64=$Value.input.newKeys.observationV2};remove=@('DAILY_SYNC_CREDENTIAL_KEY_V1')}}}
  'VERIFY' {return @{verified=$true;providerCredentialsRevoked=$false;newCredentialKeyDecryptsSamePlaintext=$true;oldCredentialKeyCannotDecryptNewCiphertext=$true;rawValuesReturned=0}}
  default {throw 'SYNTHETIC_OFFLINE_OPERATION'}
 }}
 function Invoke-Phase08Management([string]$Action,[string]$Query){Assert-CryptoTest ($Query -ceq 'SYNTHETIC_EXACT_CAS_SQL');$script:fakeWrites++;if($script:fakeUnknown){throw 'SYNTHETIC_AMBIGUOUS_OUTCOME'};return @{credentialRowsReencrypted=2;checkpointRowsReencrypted=1;businessRowsPreserved=$true;observationBaselinePreserved=$true;providerCredentialsRevoked=$false}}
 $op='20261019-crypto-wrapper-test';$prepared=Invoke-IncidentCryptoAction 'Prepare' $op
 Assert-CryptoTest ($prepared.kind -ceq 'INCIDENT_CRYPTO_PREPARED');Assert-CryptoTest ($script:fakeWrites -eq 0)
 $privatePlan=$script:fakePrivate['crypto-plan-'+$op]|ConvertTo-Json -Depth 45 -Compress
 Assert-CryptoTest (-not $privatePlan.Contains('SYNTHETIC_OLD_CREDENTIAL'));Assert-CryptoTest (-not $privatePlan.Contains('SYNTHETIC_OLD_CHECKPOINT'));$privatePlan=$null;$script:testPassed++
 $unverifiedRejected=$false;try{$unexpected=Read-IncidentCryptoEnvironmentUpdate -OperationKey $op;$unexpected=$null}catch{$unverifiedRejected=$true};Assert-CryptoTest $unverifiedRejected;$script:testPassed++
 $oldNewKey=$script:fakePrivate['crypto-keys-'+$op].credentialV2;$script:fakePrivate['crypto-keys-'+$op].credentialV2='SYNTHETIC_CHANGED_NEW_KEY'
 $badKey=Invoke-IncidentCryptoAction 'Apply' $op;Assert-CryptoTest ($badKey.kind -ceq 'INCIDENT_CRYPTO_SAFE_REJECTION');Assert-CryptoTest ($script:fakeWrites -eq 0)
 $script:fakePrivate['crypto-keys-'+$op].credentialV2=$oldNewKey;$oldNewKey=$null;$script:testPassed++
 $applied=Invoke-IncidentCryptoAction 'Apply' $op
 Assert-CryptoTest ($applied.kind -ceq 'INCIDENT_CRYPTO_VERIFIED');Assert-CryptoTest ($script:fakeWrites -eq 1);Assert-CryptoTest ($applied.activeEnvironmentVerified -ceq $false);$script:testPassed++
 $repeat=Invoke-IncidentCryptoAction 'Apply' $op
 Assert-CryptoTest ($repeat.kind -ceq 'INCIDENT_CRYPTO_SAFE_REJECTION');Assert-CryptoTest ($script:fakeWrites -eq 1);$script:testPassed++
 $oldMarkerHash=$script:fakePrivate['crypto-verified-'+$op].environmentHash;$script:fakePrivate['crypto-verified-'+$op].environmentHash='SYNTHETIC_TAMPERED'
 $markerRejected=$false;try{$unexpected=Read-IncidentCryptoEnvironmentUpdate -OperationKey $op;$unexpected=$null}catch{$markerRejected=$true};Assert-CryptoTest $markerRejected
 $script:fakePrivate['crypto-verified-'+$op].environmentHash=$oldMarkerHash;$oldMarkerHash=$null;$script:testPassed++
 $environment=Read-IncidentCryptoEnvironmentUpdate -OperationKey $op
 Assert-CryptoTest ($environment.set.Keys.Count -eq 3);Assert-CryptoTest ($environment.remove.Count -eq 1);$environment=$null;$script:testPassed++
 $script:fakeContained=$false;$rejected=Invoke-IncidentCryptoAction 'Prepare' '20261019-crypto-not-held'
 Assert-CryptoTest ($rejected.kind -ceq 'INCIDENT_CRYPTO_SAFE_REJECTION');Assert-CryptoTest ($script:fakeWrites -eq 1);$script:fakeContained=$true;$script:testPassed++
 $unknownOp='20261019-crypto-unknown';$unknownPrepared=Invoke-IncidentCryptoAction 'Prepare' $unknownOp;Assert-CryptoTest ($unknownPrepared.kind -ceq 'INCIDENT_CRYPTO_PREPARED')
 $script:fakeUnknown=$true;$unknown=Invoke-IncidentCryptoAction 'Apply' $unknownOp;Assert-CryptoTest ($unknown.outcomeUncertain -ceq $true);$script:fakeUnknown=$false
 $countBeforeVerify=$script:fakeWrites;$verified=Invoke-IncidentCryptoAction 'Verify' $unknownOp
 Assert-CryptoTest ($verified.kind -ceq 'INCIDENT_CRYPTO_VERIFIED');Assert-CryptoTest ($script:fakeWrites -eq $countBeforeVerify);$recovered=Read-IncidentCryptoEnvironmentUpdate -OperationKey $unknownOp;Assert-CryptoTest ($recovered.remove.Count -eq 1);$recovered=$null;$script:testPassed++
 @{kind='INCIDENT_CRYPTO_WRAPPER_SYNTHETIC_TESTS';passed=$script:testPassed;failed=0;realProtectedChildIpc=$true;protectedStorage='MOCK_MEMORY';managementTransport='MOCK';remoteRequests=0;actualSecretReads=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='INCIDENT_CRYPTO_WRAPPER_SYNTHETIC_TESTS';passed=$script:testPassed;failed=1;remoteRequests=0;actualSecretReads=0;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$script:fakePrivate=$null;$childKeys=$null;$environment=$null;$prepared=$null;$applied=$null;$recovered=$null}
