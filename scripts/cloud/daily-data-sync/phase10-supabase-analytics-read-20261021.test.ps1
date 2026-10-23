Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-supabase-analytics-read-20261021.ps1"
$passed=0
function Check([scriptblock]$Code){& $Code;$script:passed++}
function Reject([scriptblock]$Code){$caught=$false;try{& $Code|Out-Null}catch{$caught=$true};if(-not $caught){throw 'EXPECTED_REJECTION'};$script:passed++}
$base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
Check {Assert-AnalyticsUrl $base}
Check {Assert-AnalyticsUrl ($base+'/analytics/endpoints/usage.api-counts?interval=1day')}
Check {Assert-AnalyticsUrl ($base+'/analytics/endpoints/usage.api-requests-count')}
foreach($bad in @('http://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr',($base+'?x=1'),($base+'/analytics/endpoints/usage.api-counts?interval=7day'),($base+'/analytics/endpoints/logs'),($base+'/config/auth'),($base+'/analytics/endpoints/usage.api-requests-count#x'),($base.Replace('ehnfrrmbkvlsbpvqcvkr','abcdefghijklmnopqrst')))){Reject {Assert-AnalyticsUrl $bad}}
$row=@{timestamp='2026-10-21T04:00Z';total_auth_requests=2;total_realtime_requests=0;total_rest_requests=3;total_storage_requests=4;ignoredPrivate='DO_NOT_PROJECT'}
Check {$p=Convert-AnalyticsProjection @{result=@($row,$row);error=$null} 'SERVICE_COUNTS_1DAY';if($p.aggregateCounts.total_storage_requests -cne '8' -or $p.remainingQuota -ne $null -or $p.organizationMonthlyUsage -or ($p|ConvertTo-Json -Depth 6) -match 'DO_NOT_PROJECT'){throw 'BAD_PROJECTION'}}
Check {$p=Convert-AnalyticsProjection @{result=@(@{count=9007199254740991L},@{count=1})} 'REQUEST_COUNT_UNSPECIFIED_WINDOW';if($p.aggregateCounts.count -cne '9007199254740992' -or $p.requestedInterval -ne $null){throw 'EXACT_AGGREGATE'}}
Check {$p=Convert-AnalyticsProjection @{result=@()} 'SERVICE_COUNTS_1DAY';if($p.rowCount -ne 0 -or $p.emptyResponseIsZeroUsageProof){throw 'EMPTY_NOT_ZERO_PROOF'}}
foreach($bad in @($null,'3',$true,-1,0.5,[double]::NaN,[double]::PositiveInfinity,9007199254740992L)){Reject {Convert-AnalyticsCount $bad}}
Reject {Convert-AnalyticsProjection @{result=@(@{count=1});error='secret error text'} 'REQUEST_COUNT_UNSPECIFIED_WINDOW'}
Reject {Convert-AnalyticsProjection @{result=@{count=1}} 'REQUEST_COUNT_UNSPECIFIED_WINDOW'}
Reject {Convert-AnalyticsProjection @{result=@(@{})} 'REQUEST_COUNT_UNSPECIFIED_WINDOW'}
Reject {$badRow=$row.Clone();$badRow.timestamp='private identifier';Convert-AnalyticsProjection @{result=@($badRow)} 'SERVICE_COUNTS_1DAY'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('quota-pure-'+[guid]::NewGuid().ToString()+'.json')
Check {Write-AnalyticsNew @{safe=$true} $temp}
Reject {Write-AnalyticsNew @{safe=$false} $temp}
# Keep the harmless single proof file; no recursive cleanup or actual network/credential read.
@{kind='PHASE10_ANALYTICS_OFFLINE_TESTS';passed=$passed;failed=0;networkRequests=0;credentialReads=0;temporaryPublicProof=$temp}|ConvertTo-Json -Compress
