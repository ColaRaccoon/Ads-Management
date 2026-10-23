Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/cafe24-oauth-bridge.ps1"
function Assert-Test($condition){if(-not $condition){throw 'PHASE08_CAFE_BRIDGE_SYNTHETIC_ASSERT'}}
$state='a'*43
$url='https://didadi0729.cafe24api.com/api/v2/oauth/authorize?response_type=code&client_id=tVV6DZtPOFRlpPk1ex7ISA&state='+$state+'&redirect_uri='+[Uri]::EscapeDataString('https://phase08-daily-data-sync-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback')+'&scope=mall.read_order'
Assert-Phase08CafeAuthorizeUrl $url
$cases=1
$bytes=$null;$roundtrip=$null
foreach($bad in @($url.Replace('didadi0729.cafe24api.com','foreign.example'),$url.Replace('tVV6DZtPOFRlpPk1ex7ISA','wrong'),$url.Replace('mall.read_order','mall.write_order'),$url.Replace('phase08-daily-data-sync-production.up.railway.app','grand-fascination-staging.up.railway.app'),($url+'&state='+$state),($url+'#fragment'),$url.Replace($state,'short'))) {
  $rejected=$false;try{Assert-Phase08CafeAuthorizeUrl $bad}catch{$rejected=$true};Assert-Test $rejected;$cases++
}
$tempParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$script:testRoot=Join-Path $tempParent ('phase08-cafe-oauth-test-'+[Guid]::NewGuid().ToString())
if(-not $script:testRoot.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $script:testRoot)){throw 'TEST_ROOT_GUARD'}
[void][IO.Directory]::CreateDirectory($script:testRoot)
function Get-Phase08CafeOAuthPaths {return @{root=$script:testRoot;file=(Join-Path $script:testRoot 'cafe24-oauth-attempt.dpapi')}}
try {
  Set-Phase08NewPrivateAcl -Path $script:testRoot -Directory
  $summary=Write-Phase08CafeOAuthUrl $url ([DateTimeOffset]::UtcNow)
  Assert-Test (-not ($summary|ConvertTo-Json).Contains($state) -and -not ($summary|ConvertTo-Json).Contains('authorizeUrl'));$cases++
  $roundtrip=Read-Phase08CafeOAuthUrl;Assert-Test ($roundtrip -ceq $url);$cases++
  $bytes=[IO.File]::ReadAllBytes((Get-Phase08CafeOAuthPaths).file)
  Assert-Test (-not [Text.Encoding]::UTF8.GetString($bytes).Contains($state));$cases++
  $rejected=$false;try{$discard=Write-Phase08CafeOAuthUrl $url ([DateTimeOffset]::UtcNow)}catch{$rejected=$true};Assert-Test $rejected;$cases++
  $stored=(Get-Phase08CafeOAuthPaths).file
  Remove-Item -LiteralPath $stored -Force
  $rejected=$false;try{$discard=Write-Phase08CafeOAuthUrl $url ([DateTimeOffset]::UtcNow.AddMinutes(-6))}catch{$rejected=$true};Assert-Test ($rejected -and -not (Test-Path -LiteralPath $stored));$cases++
  Assert-Test (@(Get-ChildItem -LiteralPath $script:testRoot -Force).Count -eq 0)
  @{state='PHASE08_CAFE24_OAUTH_BRIDGE_SYNTHETIC_PASS';cases=$cases;syntheticDpapiRoundtrip=$true;networkRequests=0;actualCredentialReads=0;backendRequests=0}|ConvertTo-Json
} finally {
  $verified=[IO.Path]::GetFullPath($script:testRoot)
  if(-not $verified.StartsWith($tempParent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($verified) -cnotmatch '^phase08-cafe-oauth-test-[a-f0-9-]{36}$'){throw 'TEST_CLEANUP_GUARD'}
  Remove-Item -LiteralPath $verified -Recurse -Force
  $roundtrip=$null;$url=$null;$state=$null;if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
}
