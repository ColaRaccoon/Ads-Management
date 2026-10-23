$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-epoch-live-local-v2-20261021.ps1" -Mode Execute
$cases=0
function Check($Value,[string]$Name){if(-not $Value){throw ('LIVE_TEST_'+$Name)};$script:cases++}
Check ($Mode -ceq 'Execute') 'MODE_RESTORE'
$pins=Get-CafeEpochLivePins;Check ($pins.Count -eq 3 -and @($pins.Values|Where-Object {$_ -cnotmatch '^[a-f0-9]{64}$'}).Count -eq 0) 'SOURCE_PINS'
function Invoke-Phase08Management{throw 'OFFLINE_FORBIDDEN'}
$script:Receipts=@{};$script:Private=@{};$script:Consumed=$false;$script:Held=$true;$script:CleanupFail=$false;$script:Mutations=0
function Write-CafeEpochLivePublic($Value,[string]$Name){if($script:Receipts.ContainsKey($Name)){throw 'CREATE_NEW'};$script:Receipts[$Name]=$Value}
function Get-IncidentState{return @{variables=[ordered]@{DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES='["N00","C47","N20","N30","N40","C40","C48","E00","R00","R30","R40"]';DAILY_SYNC_CREDENTIAL_KEY_V2='SYNTHETIC_ONLY'}}}
function Get-IncidentSnapshot{return @{table_digests=@();synthetic=$true}}
function Assert-CafeRecoveryHold($Snapshot,$State){if(-not $script:Held){throw 'NOT_HELD'}}
function Assert-CafeRecoveryDeploymentStopped{}
function Get-CafeRecoveryCipherSnapshot{return @{synthetic=$true}}
function Get-CafeRecoveryTablesHash($Value){return 'a'*64}
function Get-CafeRecoveryControlsHash($Value){return 'b'*64}
function Write-IncidentPrivate($Value,[string]$Name){if($script:Private.ContainsKey($Name)){throw 'CREATE_NEW'};$script:Private[$Name]=$Value}
function Read-IncidentPrivate([string]$Name){return $script:Private[$Name]}
function Test-Path{param([string]$LiteralPath)if($LiteralPath.EndsWith('attempt.json')){return $script:Consumed};return $false}
function New-CafeEpochLivePrivate([string]$Root){}
function Complete-CafeEpochLivePrivacy([string]$Root){if($script:CleanupFail){throw 'CLEANUP'};return @{ownedPostmasterAbsent=$true;passwordFileAbsent=$true;privateTreeUserSystemOnly=$true}}
function New-CafeEpochLiveProcess{
 $plan=@{kind='CAFE08_PROTECTED_LIVE_EPOCH_PLAN';operationKey=$script:CafeEpochLiveOperation;eligibleSecretRollback=$false;baselineApprovalSha256=('c'*64);access='SYNTHETIC_ACCESS_PRIVATE';sourcePins=Get-CafeEpochLivePins;apiSha256=('d'*64);safeSummary=@{providerRequests=0};startBefore=[DateTimeOffset]::UtcNow.AddMinutes(15).ToString('o');accessExpiresAt=[DateTimeOffset]::UtcNow.AddHours(2).ToString('o')}
 $payload=[Text.Encoding]::UTF8.GetBytes('{"synthetic":true}');$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($payload)).ToLowerInvariant();$frames=[Collections.Generic.Queue[string]]::new()
 foreach($day in @('2026-10-16','2026-10-17')){$frames.Enqueue((@{kind='PRIVATE_NORMALIZED';day=$day;normalizedPayloadBase64=[Convert]::ToBase64String($payload);normalizedPayloadSha256=$hash;normalizedPayloadBytes=$payload.Length}|ConvertTo-Json -Compress));$frames.Enqueue((@{kind='DAY_PUBLIC';day=$day;proof=@{status='PASS';day=$day}}|ConvertTo-Json -Compress))};$frames.Enqueue((@{kind='RESULT';result=@{status='PASS';providerRequests=12;postgresStopExit=0}}|ConvertTo-Json -Compress))
 $stdin=[pscustomobject]@{};$stdin|Add-Member ScriptMethod WriteLine {param($Line)};$stdin|Add-Member ScriptMethod Close {}
 $stdout=[pscustomobject]@{frames=$frames;prepared=(@{kind='PRIVATE_PREPARED';plan=$plan}|ConvertTo-Json -Depth 20 -Compress)};$stdout|Add-Member ScriptMethod ReadToEndAsync {return [Threading.Tasks.Task]::FromResult([string]$this.prepared)};$stdout|Add-Member ScriptMethod ReadLineAsync {return [Threading.Tasks.Task]::FromResult([string]$this.frames.Dequeue())}
 $stderr=[pscustomobject]@{};$stderr|Add-Member ScriptMethod ReadToEndAsync {return [Threading.Tasks.Task]::FromResult([string]'')}
 $child=[pscustomobject]@{StandardInput=$stdin;StandardOutput=$stdout;StandardError=$stderr;ExitCode=0;HasExited=$true};$child|Add-Member ScriptMethod WaitForExit {param($ms)return $true};$child|Add-Member ScriptMethod Dispose {};$child|Add-Member ScriptMethod Kill {param($Tree)};return $child
}
try{
 $r=Invoke-CafeEpochLiveAction Parse;Check ($r.status -ceq 'PASS' -and $r.providerRequests -eq 0) 'PARSE_OFFLINE'
 $r=Invoke-CafeEpochLiveAction Prepare;Check ($r.status -ceq 'PASS' -and $script:Private.Count -eq 1) 'PREPARE_RO_DPAPI_STUB'
 $r=Invoke-CafeEpochLiveAction Execute;Check ($r.status -ceq 'PASS' -and $r.days -eq 2 -and $r.providerRequests -eq 12) 'EXECUTE_TWO_DAY_STUB'
 Check ($script:Receipts.ContainsKey('preservation-final')) 'FINALLY_PRESERVATION'
 Check ($script:Private.Count -eq 3 -and $script:Private.Values.eligibleSecretRollback -notcontains $true) 'NORMALIZED_PRIVATE_ONLY'
 Check ($script:Receipts['result'].privacy.privateTreeUserSystemOnly -eq $true) 'PRIVACY_BEFORE_PASS'
 $script:Consumed=$true;$r=Invoke-CafeEpochLiveAction Execute;Check ($r.status -ceq 'FAIL' -and $r.stage -ceq 'START') 'SINGLE_ATTEMPT'
 $script:Consumed=$false;$script:Held=$false;$r=Invoke-CafeEpochLiveAction Execute;Check ($r.status -ceq 'FAIL' -and $r.stage -ceq 'FRESH_REMOTE_HOLD') 'HOLD_REJECT'
 $script:Held=$true;$script:CleanupFail=$true;$script:Receipts=@{};$r=Invoke-CafeEpochLiveAction Execute;Check ($r.status -ceq 'FAIL' -and -not $script:Receipts.ContainsKey('result') -and $script:Receipts['privacy-final'].status -ceq 'FAIL') 'CLEANUP_PREVENTS_PASS'
 $source=Get-Content -LiteralPath "$PSScriptRoot/phase10-cafe-epoch-live-local-v2-20261021.ps1" -Raw
 Check ($source.Contains('CreateNew') -and $source.Contains('Environment.Clear()') -and $source.Contains('StandardInput.WriteLine')) 'PRIVATE_STDIN_CREATE_NEW'
 Check (-not $source.Contains('Get-Phase08Sha256Bytes') -and $source.Contains('HashData($payload)')) 'EXACT_PRIVATE_SHA'
 Check ($source.Contains('DateKind String') -and $source.Contains('S-1-5-18')) 'DATES_AND_ACL'
 [ordered]@{kind='CAFE_EPOCH_LIVE_CONTROL_SYNTHETIC_PASS';cases=$cases;providerRequests=0;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{[ordered]@{kind='CAFE_EPOCH_LIVE_CONTROL_SYNTHETIC_FAIL';cases=$cases;safeReason=$(if($_.Exception.Message -cmatch '^LIVE_TEST_[A-Z0-9_]+$'){$_.Exception.Message}else{'OFFLINE_TEST_REJECTED'});providerRequests=0;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
