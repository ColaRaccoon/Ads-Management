$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-epoch-eval-v3-20261020.ps1" -Mode RunNative
if($Mode -cne 'RunNative'){throw 'EPOCH_TEST_MODE'}
$script:Native=0;$script:NewRoots=0
function Assert-Test($Value,[string]$Name){if(-not $Value){throw ('EPOCH_TEST_'+$Name)}}
function New-EpochPrivate([string]$Root){$script:NewRoots++;throw 'OFFLINE_NATIVE_FORBIDDEN'}
function Invoke-EpochProcess([string[]]$Arguments,[string]$InputText='',[int]$Timeout=60000,[bool]$Native=$false){if($Native){$script:Native++;throw 'OFFLINE_NATIVE_FORBIDDEN'};return @{exitCode=0;text=''}}
function Get-EpochMetadata{return @{toolClosureSha256=('a'*64);apiSha256=('b'*64);migrationSha256=('c'*64);generatedEpochModels=2}}
$cases=1
try{
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-epoch-local-00000000-0000-4000-8000-000000000001';$pidLines=@('1',($root+'/pg-data'),'1','55436','','127.0.0.1');Assert-EpochPostmaster $pidLines $root;$cases++
 foreach($i in @(1,3,5)){$bad=@($pidLines);$bad[$i]='other';$rejected=$false;try{Assert-EpochPostmaster $bad $root}catch{$rejected=$true};Assert-Test $rejected 'PID_WRONG_DIRECTORY_PORT_LISTENER_REJECT';$cases++}
 $controller=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-v3-20261020.ps1')).Hash.ToLowerInvariant();$meta=Get-EpochMetadata;Assert-EpochNativePins $meta $controller ('a'*64) ('b'*64) ('c'*64);$cases++
 foreach($pins in @(@(('0'*64),('a'*64),('b'*64),('c'*64)),@($controller,('0'*64),('b'*64),('c'*64)),@($controller,('a'*64),('0'*64),('c'*64)),@($controller,('a'*64),('b'*64),('0'*64)))){$rejected=$false;try{Assert-EpochNativePins $meta $pins[0] $pins[1] $pins[2] $pins[3]}catch{$rejected=$true};Assert-Test $rejected 'BAD_EXPECTED_PIN_REJECT';$cases++}
 $r=Invoke-EpochAction Parse '' '' '' '';Assert-Test ($r.status -ceq 'PASS' -and $r.nativeStarts -eq 0 -and $script:Native -eq 0 -and $script:NewRoots -eq 0) 'PARSE_ONLY';$cases++
 $r=Invoke-EpochAction RunNative $controller ('0'*64) ('b'*64) ('c'*64);Assert-Test ($r.status -ceq 'FAIL' -and $r.stage -ceq 'EXPECTED_SOURCE_PIN' -and $script:Native -eq 0 -and $script:NewRoots -eq 0) 'PIN_BLOCKS_BEFORE_ROOT_OR_NATIVE';$cases++
 $r=Invoke-EpochAction other '' '' '' '';Assert-Test ($r.status -ceq 'FAIL' -and $script:Native -eq 0 -and $script:NewRoots -eq 0) 'MODE_FAIL_CLOSED';$cases++
 $source=Get-Content -LiteralPath "$PSScriptRoot/phase10-cafe-epoch-eval-v3-20261020.ps1" -Raw;$dispatch=$source.Substring($source.LastIndexOf('$result=Invoke-EpochAction'))
 function Invoke-EpochAction([string]$Action,[string]$Controller,[string]$Tool,[string]$Api,[string]$Migration){Assert-Test ($Action -ceq 'RunNative') 'DIRECT_DISPATCH';return @{status='PASS'}}
 $null=Invoke-Expression $dispatch;$cases++
 @{kind='CAFE_EPOCH_CONTROLLER_STUB_PASS';cases=$cases;actualNativeStarts=0;actualSql=0;providerRequests=0;dpapiReads=0}|ConvertTo-Json -Compress
}catch{@{kind='CAFE_EPOCH_CONTROLLER_STUB_FAIL';cases=$cases;safeCode=$(if($_.Exception.Message -cmatch '^EPOCH_TEST_[A-Z_]+$'){$_.Exception.Message}else{'OFFLINE_REJECTED'});rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
