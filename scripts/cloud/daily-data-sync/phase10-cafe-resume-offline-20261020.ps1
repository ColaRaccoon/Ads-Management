param([ValidatePattern('^(v[1-9][0-9]?|independent-v[1-9][0-9]?)$')][string]$EvidenceVersion='v4')
# Local protected evidence only. Loading common definitions performs no remote I/O.
$ErrorActionPreference='Stop'
. "$PSScriptRoot/incident-common.ps1"
$baseline=$null;$plan=$null;$prep=$null;$wire=$null;$child=$null;$out=$null;$stage='BASELINE'
function Read-LocalCafeDpapiText([string]$Name){
 if($Name -cnotin @('client-secret.dpapi','credential-key.dpapi')){throw 'LOCAL_NAME'}
 $path=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsCafe24Isolated' $Name
 Assert-Phase08PrivatePath -Path $path
 $info=Get-Item -LiteralPath $path;if($info.Length -lt 32 -or $info.Length -gt 16384){throw 'LOCAL_SIZE'}
 $secure=$null;$ptr=[IntPtr]::Zero
 try{$secure=[IO.File]::ReadAllText($path)|ConvertTo-SecureString;$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)}
 finally{if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)};if($secure){$secure.Dispose()}}
}
try{
 $baseline=Read-IncidentPrivate 'compromised-baseline'
 $stage='PLAN';$plan=Read-IncidentPrivate 'crypto-plan-20261019-crypto-rotation-a'
 $stage='PREP';$prep=Read-IncidentPrivate 'performance-recheck-20261020-v4-prep'
 $stage='EVIDENCE';$evidence=@{};foreach($name in $baseline.variables.Keys){if($name.StartsWith('DAILY_SYNC_CAFE24_') -and $name -notmatch 'CLIENT_SECRET|KEY|TOKEN'){$evidence[$name]=$baseline.variables[$name]}}
 $scope=Get-Content -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/independent/shared-scope-v1.json' -Raw -Encoding UTF8|ConvertFrom-Json -AsHashtable -DateKind String
 if($scope.results.cafe.existingCallbackSameClientId -cne $true -or $scope.results.cafe.existingCallbackSecretEqualsExposed -cne $true){throw 'PRIOR_SCOPE'}
 $stage='LOCAL_DPAPI_SOURCE';$localSourceGuard=$false;$localSecret=$null;$localCredentialKey=$null
 try{Assert-Phase08PrivatePath -Path 'C:/Users/seong/AppData/Local/MetaAdsCafe24Isolated/client-secret.dpapi';Assert-Phase08PrivatePath -Path 'C:/Users/seong/AppData/Local/MetaAdsCafe24Isolated/credential-key.dpapi';$localSourceGuard=$true}catch{}
 if($localSourceGuard){$localSecret=Read-LocalCafeDpapiText 'client-secret.dpapi';$localCredentialKey=Read-LocalCafeDpapiText 'credential-key.dpapi'}
 $wire=@{checkpointKey=$baseline.variables.DAILY_SYNC_CHECKPOINT_KEY_B64;checkpoints=$plan.beforeCipherSnapshot.checkpoints;credentials=$plan.beforeCipherSnapshot.credentials;evidence=$evidence;localConfig=@{historicalCallbackSameClientId=$true;historicalCallbackSameClientSecret=$true;latestPreparedRuntimeHasCafeClientSecret=$prep.after.Contains('DAILY_SYNC_CAFE24_CLIENT_SECRET');latestPreparedRuntimeHasAccessTokenVariable=$prep.after.Contains('DAILY_SYNC_CAFE24_ACCESS_TOKEN');storedPairReencryptedNotReissued=$true;scopeMetadataIsHistoricalNotFreshProviderIntrospection=$true}}
 $wire.localConfig.localPhase06ProtectedSourceGuardPassed=$localSourceGuard
 $wire.localConfig.localPhase06ProtectedSourceRead=$localSourceGuard
 $wire.localConfig.localPhase06ClientSecretEqualsExposed=$(if($localSourceGuard){$localSecret -ceq $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET}else{$null})
 $wire.localConfig.localPhase06CredentialKeyEqualsExposedPhase08V1=$(if($localSourceGuard){$localCredentialKey -ceq $baseline.variables.DAILY_SYNC_CREDENTIAL_KEY_V1}else{$null})
 $wire.localConfig.callbackCurrentTokenPairComparisonAvailable=$false
 $localSecret=$null;$localCredentialKey=$null
 $stage='CHILD_START';$start=[Diagnostics.ProcessStartInfo]::new('node');$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 foreach($arg in @('--import','tsx',"$PSScriptRoot/phase10-cafe-resume-offline-20261020.mjs")){$start.ArgumentList.Add($arg)}
 $start.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json';$child=[Diagnostics.Process]::new();$child.StartInfo=$start;[void]$child.Start();$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write(($wire|ConvertTo-Json -Depth 45 -Compress));$child.StandardInput.Close()
 if(-not $child.WaitForExit(60000)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
 $stage='CHILD_EXIT';$out=$stdout.GetAwaiter().GetResult();$ignored=$stderr.GetAwaiter().GetResult();if($child.ExitCode -ne 0){try{$diagnostic=$out|ConvertFrom-Json -AsHashtable -Depth 5;if($diagnostic.kind -ceq 'CAFE_OFFLINE_RESUME_INVESTIGATION_FAILED' -and $diagnostic.stage -cin @('INPUT','FROZEN_IMPORT','ACTUAL_CHUNK_REPLAY')){$stage=$diagnostic.stage}}catch{};throw 'CHILD_REJECTED'}
 $safe=$out|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
 if($safe.kind -cne 'CAFE_OFFLINE_RESUME_INVESTIGATION' -or $safe.rawValuesReturned -ne 0 -or $safe.providerRequests -ne 0 -or $safe.replay.metadataOldNewEqual -ne 269 -or $safe.replay.itemOldNewEqual -ne 60 -or $safe.replay.currentChunkStoredPass -ne 60 -or $safe.replay.frozenChunkStoredPass -ne 60){throw 'SAFE_OUTPUT'}
 foreach($secretName in @('DAILY_SYNC_CAFE24_CLIENT_SECRET','DAILY_SYNC_CREDENTIAL_KEY_V1','DAILY_SYNC_CHECKPOINT_KEY_B64')){if($out.Contains([string]$baseline.variables[$secretName],[StringComparison]::Ordinal)){throw 'LITERAL_OUTPUT'}}
 $folder="C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-resume-20261020-$EvidenceVersion";[void][IO.Directory]::CreateDirectory($folder);$stream=[IO.File]::Open("$folder/result.json",[IO.FileMode]::CreateNew)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($safe|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $safe|ConvertTo-Json -Depth 20 -Compress
}catch{@{kind='CAFE_OFFLINE_RESUME_INVESTIGATION_FAILED';stage=$stage;rawErrorSuppressed=$true;providerRequests=0;databaseWrites=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
finally{$baseline=$null;$plan=$null;$prep=$null;$scope=$null;$wire=$null;$out=$null;$ignored=$null;$localSecret=$null;$localCredentialKey=$null;if($child){$child.Dispose()}}
