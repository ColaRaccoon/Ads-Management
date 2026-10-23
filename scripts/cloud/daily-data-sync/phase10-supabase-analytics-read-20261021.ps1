param([ValidateSet('Parse','Execute')][string]$Mode='Parse')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

function Assert-AnalyticsUrl([string]$Url) {
 $allowed=@('https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr','https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/analytics/endpoints/usage.api-counts?interval=1day','https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/analytics/endpoints/usage.api-requests-count')
 if($Url -cnotin $allowed){throw 'GET_SCOPE'}
}
function Write-AnalyticsNew($Value,[string]$Path) {
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 15))
 $f=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
}
function Convert-AnalyticsCount($Value) {
 if($null -eq $Value -or $Value -is [string] -or $Value -is [bool]){throw 'COUNT_TYPE'}
 if($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64] -and $Value -isnot [double] -and $Value -isnot [decimal] -and $Value -isnot [single]){throw 'COUNT_TYPE'}
 $n=[double]$Value
 if(-not [double]::IsFinite($n) -or $n -lt 0 -or $n -gt 9007199254740991 -or [Math]::Truncate($n) -ne $n){throw 'COUNT_BOUND'}
 return [Numerics.BigInteger]::new([decimal]$Value)
}
function Convert-AnalyticsProjection([hashtable]$Body,[ValidateSet('SERVICE_COUNTS_1DAY','REQUEST_COUNT_UNSPECIFIED_WINDOW')][string]$Kind) {
 if($Body.ContainsKey('error') -and $null -ne $Body.error -and $Body.error -cne ''){throw 'API_ERROR_PRESENT'}
 if(-not $Body.ContainsKey('result') -or $Body.result -isnot [array] -or $Body.result.Count -gt 10000){throw 'RESULT_SHAPE'}
 $totals=@{};$first=$null;$last=$null
 $fields=if($Kind -ceq 'SERVICE_COUNTS_1DAY'){@('total_auth_requests','total_realtime_requests','total_rest_requests','total_storage_requests')}else{@('count')}
 foreach($field in $fields){$totals[$field]=[Numerics.BigInteger]::Zero}
 foreach($row in $Body.result){
  if($row -isnot [hashtable]){throw 'ROW_SHAPE'}
  foreach($field in $fields){if(-not $row.ContainsKey($field)){throw 'COUNT_MISSING'};$totals[$field]+=(Convert-AnalyticsCount $row[$field])}
  if($Kind -ceq 'SERVICE_COUNTS_1DAY'){
   if(-not $row.ContainsKey('timestamp') -or $row.timestamp -isnot [string] -or $row.timestamp -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?Z?$'){throw 'TIMESTAMP_SHAPE'}
   $stamp=[DateTimeOffset]::MinValue
   if(-not [DateTimeOffset]::TryParse($row.timestamp,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$stamp)){throw 'TIMESTAMP_VALUE'}
   $stamp=$stamp.ToUniversalTime();if($null -eq $first -or $stamp -lt $first){$first=$stamp};if($null -eq $last -or $stamp -gt $last){$last=$stamp}
  }
 }
 $safeTotals=@{};foreach($field in $fields){$safeTotals[$field]=$totals[$field].ToString([Globalization.CultureInfo]::InvariantCulture)}
 return @{kind=$Kind;rowCount=$Body.result.Count;aggregateCounts=$safeTotals;responseTimestampMinUtc=$(if($null -ne $first){$first.ToString('o')}else{$null});responseTimestampMaxUtc=$(if($null -ne $last){$last.ToString('o')}else{$null});requestedInterval=$(if($Kind -ceq 'SERVICE_COUNTS_1DAY'){'1day'}else{$null});actualBillingPeriod=$null;organizationMonthlyUsage=$false;remainingQuota=$null;emptyResponseIsZeroUsageProof=$false}
}
function Read-AnalyticsGet([Net.Http.HttpClient]$Client,[string]$Url) {
 Assert-AnalyticsUrl $Url
 $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,$Url);$response=$null;$stream=$null;$buffer=$null;$memory=$null
 try{
  $response=$Client.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  $status=[int]$response.StatusCode
  if($status -ne 200){return @{status=$status;body=$null}}
  if($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -gt 2097152){throw 'RESPONSE_BOUND'}
  $stream=$response.Content.ReadAsStream();$memory=[IO.MemoryStream]::new();$buffer=[byte[]]::new(16384)
  $deadline=[DateTime]::UtcNow.AddSeconds(25)
  while($true){
   $remaining=$deadline-[DateTime]::UtcNow;if($remaining.TotalMilliseconds -le 0){throw 'RESPONSE_TIMEOUT'}
   $cts=[Threading.CancellationTokenSource]::new($remaining)
   try{$n=$stream.ReadAsync($buffer,0,$buffer.Length,$cts.Token).GetAwaiter().GetResult()}finally{$cts.Dispose()}
   if($n -eq 0){break};if($memory.Length+$n -gt 2097152){throw 'RESPONSE_BOUND'};$memory.Write($buffer,0,$n)
  }
  $json=[Text.UTF8Encoding]::new($false,$true).GetString($memory.ToArray())
  $body=$json|ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String
  if($body -isnot [hashtable]){throw 'RESPONSE_SHAPE'}
  return @{status=$status;body=$body}
 }finally{if($null -ne $buffer){[Array]::Clear($buffer)};if($null -ne $stream){$stream.Dispose()};if($null -ne $memory){$memory.Dispose()};if($null -ne $response){$response.Dispose()};$request.Dispose();$json=$null;$body=$null}
}
function Invoke-AnalyticsRead {
 $out='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/consumer-readonly-1343/quota-analytics-result.json'
 $stage='OUTPUT_GUARD';$token=$null;$client=$null;$handler=$null;$reply=$null
 $result=[ordered]@{kind='PHASE10_SUPABASE_PROJECT_ANALYTICS_PARTIAL_READ';at=[DateTimeOffset]::UtcNow.ToString('o');status='NOT_COMPLETED';projectIdentityExact=$false;authenticatedGetAttempts=0;analytics=@();actualOrganizationMonthlyUsage=$null;actualBillingPeriod=$null;actualRemainingQuota=$null;organizationQuotaVerified=$false;settingsChanges=0;credentialsChanged=0;tokenRefresh=0;newLogin=0;sql=0;appHttp=0;rawReturned=0;fixedGuard=$null}
 try{
  if(Test-Path -LiteralPath $out){throw 'OUTPUT_EXISTS'}
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out))
  $stage='CONTEXT_PIN';$context=Join-Path $PSScriptRoot 'protected-context.ps1'
  if((Get-FileHash -LiteralPath $context -Algorithm SHA256).Hash.ToLowerInvariant() -cne '24898c074bf32d7af0ad79b1c7c7a41ef0bb9a01509b8d2fb2abb5da4bc0fc84'){throw 'CONTEXT_PIN'}
  . $context
  $stage='EXISTING_CREDENTIAL';$token=Get-Phase08SupabaseCredential
  $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
  $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(25);$client.DefaultRequestHeaders.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$token)
  $stage='PROJECT_IDENTITY';$result.authenticatedGetAttempts++;$reply=Read-AnalyticsGet $client 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
  if($reply.status -ne 200 -or $reply.body.id -cne 'ehnfrrmbkvlsbpvqcvkr'){throw 'PROJECT_IDENTITY'};$result.projectIdentityExact=$true;$reply=$null
  foreach($entry in @(@{kind='SERVICE_COUNTS_1DAY';url='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/analytics/endpoints/usage.api-counts?interval=1day'},@{kind='REQUEST_COUNT_UNSPECIFIED_WINDOW';url='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/analytics/endpoints/usage.api-requests-count'})){
   $stage=$entry.kind;$result.authenticatedGetAttempts++;$reply=Read-AnalyticsGet $client $entry.url
   $safe=@{kind=$entry.kind;httpStatus=$reply.status;projection=$null;projectionAccepted=$false}
   if($reply.status -eq 200){try{$safe.projection=Convert-AnalyticsProjection $reply.body $entry.kind;$safe.projectionAccepted=$true}catch{$safe.fixedGuard='ANALYTICS_PROJECTION_REJECTED'}}
   $result.analytics+=@($safe);$reply=$null
  }
  $result.status='PARTIAL_PROJECT_ANALYTICS_READ_COMPLETED_OR_ACCESS_STATUS_RECORDED'
 }catch{
  $result.status='SAFE_FAILURE';$result.fixedGuard=$stage
  if($stage -ceq 'OUTPUT_GUARD'){return @{status='SAFE_FAILURE';fixedGuard=$stage;rawReturned=0}}
 }finally{$token=$null;$reply=$null;if($null -ne $client){$client.DefaultRequestHeaders.Authorization=$null;$client.Dispose()};if($null -ne $handler){$handler.Dispose()}}
 Write-AnalyticsNew $result $out
 return @{status=$result.status;output=$out;authenticatedGetAttempts=$result.authenticatedGetAttempts;organizationQuotaVerified=$false;rawReturned=0}
}
if($MyInvocation.InvocationName -ne '.'){
 if($Mode -ceq 'Parse'){@{status='PARSE_ONLY';authenticatedGetAttempts=0;rawReturned=0}|ConvertTo-Json -Compress}
 else{Invoke-AnalyticsRead|ConvertTo-Json -Compress}
}
