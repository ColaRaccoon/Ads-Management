param([Parameter(Mandatory)][ValidateSet('install','configure','resume','enable')][string]$Mode,[Parameter(Mandatory)][string]$EvidencePath,[Parameter(Mandatory)][string]$ConfigurationPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='PUBLIC_PINS';$context=$null;$sql=$null;$submitted=$false;$verified=$false
try {
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 $item=Get-Item -LiteralPath $EvidencePath -ErrorAction Stop
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536){throw 'evidence-file'}
 $envelope=[IO.File]::ReadAllText($item.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25
 $proof=Invoke-Phase08SchedulerNode @{action='validate';envelope=$envelope}
 if($proof.state -cne 'PHASE08_SIGNED_EVIDENCE_VERIFIED'){throw 'proof'}
 $definition=Read-Phase08SchedulerDefinitions $ConfigurationPath
 $stage='PROTECTED_CONTEXT';$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='LIVE_RECHECK';$graph=Get-Phase08SchedulerGraphState $context $pins;$ready=Get-Phase08SchedulerReady $context $pins
 $db=Get-Phase08SchedulerDatabase $pins $definition.ranges;Get-Phase08SchedulerRuntimeProof $context
 if(($graph.appSchedules|ConvertTo-Json -Depth 15 -Compress) -cne ($proof.payload.appSchedules|ConvertTo-Json -Depth 15 -Compress) -or $graph.scheduleEnabled -ne $proof.payload.scheduleEnabled){throw 'proof-runtime-changed'}
 $before=Get-Phase08SchedulerSnapshot
 $stage='BUILD';$batch=Invoke-Phase08SchedulerNode @{action='build';mode=$Mode;definitions=$(if($Mode -ceq 'install'){@()}else{@($definition.definitions)});envelope=$envelope}
 if($batch.state -cne 'PHASE08_BATCH_PREPARED' -or $batch.sql -isnot [string] -or $batch.sql.Length -gt 1048576){throw 'batch'}
 $sql=$batch.sql;$stage='SINGLE_BATCH';$submitted=$true
 $discard=Invoke-Phase08Management -Action Query -Query $sql;$discard=$null;$sql=$null;$batch=$null
 $stage='READBACK';$after=Get-Phase08SchedulerSnapshot;$dbAfter=Get-Phase08SchedulerDatabase $pins $definition.ranges
 $check=Invoke-Phase08SchedulerNode @{action='snapshot';mode=$Mode;definitions=@($definition.definitions);before=$before;after=$after}
 if($check.state -cne 'PHASE08_BATCH_READBACK_VERIFIED'){throw 'readback'}
 $verified=$true
 @{state='PHASE08_SCHEDULER_BATCH_VERIFIED';mode=$Mode;sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;singleBatch=$true;retryPerformed=$false;providerRequests=0;privateValuesReturned=0}|ConvertTo-Json -Compress
} catch {@{state='PHASE08_SCHEDULER_BATCH_FAILED';mode=$Mode;stage=$stage;outcomeUncertain=($submitted -and -not $verified);inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally {$context=$null;$sql=$null;$envelope=$null;$batch=$null;$discard=$null;$graph=$null;$db=$null;$dbAfter=$null;$proof=$null;$before=$null;$after=$null}
