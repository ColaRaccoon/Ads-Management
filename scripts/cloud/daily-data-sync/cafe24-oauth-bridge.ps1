# Definitions only. Read-Phase08CafeOAuthUrl returns protected material to an explicit trusted caller.
. "$PSScriptRoot/source-connection-helpers.ps1"
function Get-Phase08CafeOAuthPaths {
  return @{root='C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime';file='C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime\cafe24-oauth-attempt.dpapi'}
}
function Assert-Phase08CafeAuthorizeUrl([string]$url) {
  if($url.Length -gt 8192 -or $url -cnotmatch '^https://didadi0729\.cafe24api\.com/api/v2/oauth/authorize\?'){throw 'authorize-url'}
  $uri=[Uri]$url
  if($uri.Scheme -cne 'https' -or $uri.Authority -cne 'didadi0729.cafe24api.com' -or $uri.AbsolutePath -cne '/api/v2/oauth/authorize' -or $uri.Fragment -or $uri.UserInfo){throw 'authorize-origin'}
  $values=@{};$pieces=@($uri.Query.Substring(1).Split('&'))
  if($pieces.Count -ne 5){throw 'authorize-query-count'}
  foreach($piece in $pieces) {
    $pair=$piece.Split('=',2)
    if($pair.Count -ne 2 -or $pair[0] -cnotin @('response_type','client_id','redirect_uri','scope','state') -or $values.ContainsKey($pair[0])){throw 'authorize-query'}
    $values[$pair[0]]=[Uri]::UnescapeDataString($pair[1])
  }
  if($values.response_type -cne 'code' -or $values.client_id -cne 'tVV6DZtPOFRlpPk1ex7ISA' -or $values.scope -cne 'mall.read_order' -or
    $values.redirect_uri -cne 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback' -or $values.state -cnotmatch '^[A-Za-z0-9_-]{43}$'){throw 'authorize-binding'}
}
function Assert-Phase08CafeOAuthDestination([switch]$Fresh) {
  $paths=Get-Phase08CafeOAuthPaths
  Assert-Phase08PrivatePath -Path $paths.root -Directory
  if([IO.Path]::GetFullPath($paths.file) -cne (Join-Path ([IO.Path]::GetFullPath($paths.root)) 'cafe24-oauth-attempt.dpapi')){throw 'bridge-path'}
  if($Fresh){if(Test-Path -LiteralPath $paths.file){throw 'bridge-no-overwrite'}}else{Assert-Phase08PrivatePath -Path $paths.file}
  return $paths
}
function Write-Phase08CafeOAuthUrl([string]$url,[DateTimeOffset]$startedAt) {
  Assert-Phase08CafeAuthorizeUrl $url
  $paths=Assert-Phase08CafeOAuthDestination -Fresh
  $plain=$null;$encrypted=$null;$all=$null;$temporary=$null;$file=$null
  try {
    $expires=$startedAt.AddSeconds(300)
    if($startedAt -gt [DateTimeOffset]::UtcNow.AddSeconds(5) -or $expires -le [DateTimeOffset]::UtcNow){throw 'bridge-expired'}
    $record=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';schema='phase08_meta_ads';serviceId='4b30daa8-9333-46b7-ad89-cfd64ff5266c';
      connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';origin='https://phase08-daily-data-sync-production.up.railway.app';authorizeUrl=$url;createdAt=$startedAt.ToString('O');expiresAt=$expires.ToString('O')}
    $plain=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress))
    $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/CafeOAuth/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-CAFE-OAUTH-1');$all=[byte[]]::new($magic.Length+$encrypted.Length)
    [Array]::Copy($magic,0,$all,0,$magic.Length);[Array]::Copy($encrypted,0,$all,$magic.Length,$encrypted.Length)
    $temporary=Join-Path $paths.root ('cafe-oauth-'+[Guid]::NewGuid().ToString()+'.dpapi.tmp')
    if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($temporary)) -cne [IO.Path]::GetFullPath($paths.root)){throw 'bridge-temp-path'}
    $file=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $file.Write($all,0,$all.Length);$file.Dispose();$file=$null
    Set-Phase08NewPrivateAcl -Path $temporary;Assert-Phase08PrivatePath -Path $temporary
    $discard=Assert-Phase08CafeOAuthDestination -Fresh
    [IO.File]::Move($temporary,$paths.file,$false);$temporary=$null
    Assert-Phase08PrivatePath -Path $paths.file
    $roundtrip=Read-Phase08CafeOAuthUrl
    if($roundtrip -cne $url){throw 'bridge-roundtrip'};$roundtrip=$null
    return @{state='PHASE08_CAFE24_OAUTH_URL_PROTECTED';protectedFile=$paths.file;expiresAt=$expires.ToString('O');plaintextFiles=0;authorizeProviderRequests=0;backendOAuthAttemptsCreated=1}
  } finally {
    if($file){$file.Dispose()}
    if($temporary -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($temporary)) -ceq [IO.Path]::GetFullPath($paths.root) -and (Test-Path -LiteralPath $temporary)){Remove-Item -LiteralPath $temporary -Force}
    foreach($bytes in @($plain,$encrypted,$all)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$record=$null;$url=$null;$roundtrip=$null
  }
}
function Read-Phase08CafeOAuthUrl {
  $paths=Assert-Phase08CafeOAuthDestination;$all=$null;$encrypted=$null;$plain=$null
  try {
    $all=[IO.File]::ReadAllBytes($paths.file)
    if($all.Length -lt 32 -or $all.Length -gt 16384){throw 'bridge-size'}
    $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-CAFE-OAUTH-1')
    for($i=0;$i -lt $magic.Length;$i++){if($all[$i] -ne $magic[$i]){throw 'bridge-magic'}}
    $encrypted=$all[$magic.Length..($all.Length-1)]
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/CafeOAuth/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $record=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -DateKind String
    if($record.version -ne 1 -or $record.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $record.schema -cne 'phase08_meta_ads' -or
      $record.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $record.connectionId -cne '0c35defe-45fc-4a54-bc79-704df7bca5b1' -or $record.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'bridge-identity'}
    $created=[DateTimeOffset]::ParseExact($record.createdAt,'O',[Globalization.CultureInfo]::InvariantCulture)
    $expires=[DateTimeOffset]::ParseExact($record.expiresAt,'O',[Globalization.CultureInfo]::InvariantCulture)
    if($created -gt [DateTimeOffset]::UtcNow.AddSeconds(5) -or $expires -ne $created.AddSeconds(300) -or $expires -le [DateTimeOffset]::UtcNow){throw 'bridge-expired'}
    Assert-Phase08CafeAuthorizeUrl $record.authorizeUrl
    return [string]$record.authorizeUrl
  } catch {throw 'PHASE08_CAFE24_PROTECTED_URL_UNAVAILABLE'}
  finally {foreach($bytes in @($all,$encrypted,$plain)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$record=$null}
}
