Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. "$PSScriptRoot/observe-manual-meta-v12-r3-warnings.ps1"
$script:n=0;function Check($Value){$script:n++;if(-not $Value){throw 'synthetic-assert'}};function Reject([scriptblock]$Code){$x=$false;try{&$Code|Out-Null}catch{$x=$true};Check $x}
function Fixture{return @{automaticBackfill=$false;items=@(@{scheduleKey='phase08-meta';scheduledFor='2026-10-14T17:02:00.000Z';fromDate='2026-10-08';toDate='2026-10-14';id=$null;status='EXPIRED';warningCode='MISSING_SCHEDULE';missingDates=@('2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14')});history=@(@{scheduleKey='phase08-cafe24';trackingFromDate='2026-10-14';truncatedEarlierWindows=$false;warningCode=$null},@{scheduleKey='phase08-google';trackingFromDate='2026-10-08';truncatedEarlierWindows=$false;warningCode=$null},@{scheduleKey='phase08-meta';trackingFromDate='2026-10-08';truncatedEarlierWindows=$false;warningCode=$null});historyLimits=@{cafe24Occurrences=[long]31;adsOccurrences=[long]5}}}
$v=Fixture;$r=ConvertTo-Phase08ManualMetaV12R3Warnings $v;Check ($r.remainingDateCount -eq 6 -and $r.oldWeeklySucceeded -is [bool] -and -not $r.oldWeeklySucceeded -and $r.providerRequests -eq 0)
$v=Fixture;$v.items[0].missingDates=@('2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-13','2026-10-14');Reject {ConvertTo-Phase08ManualMetaV12R3Warnings $v}
$v=Fixture;$v.items[0].status='FAILED';Reject {ConvertTo-Phase08ManualMetaV12R3Warnings $v}
$v=Fixture;$v.automaticBackfill='false';Reject {ConvertTo-Phase08ManualMetaV12R3Warnings $v}
$v=Fixture;$v.historyLimits.adsOccurrences='5';Reject {ConvertTo-Phase08ManualMetaV12R3Warnings $v}
$v=Fixture;$v.items[0].secret='SYNTHETIC_PRIVATE';Reject {ConvertTo-Phase08ManualMetaV12R3Warnings $v}
@{state='PHASE08_WARNING_PROJECTION_SYNTHETIC_PASS';assertions=$script:n;network=0;providerRequests=0}|ConvertTo-Json -Compress
