# Definitions only: importing this helper performs no credential reads or network calls.
. "$PSScriptRoot/protected-context.ps1"
$phase08OperatorPath='C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime\operator-context.dpapi'
function Read-Phase08Operator {
  Assert-Phase08PrivatePath -Path $phase08OperatorPath
  $all=$null;$plain=$null;$encrypted=$null
  try {
    $all=[IO.File]::ReadAllBytes($phase08OperatorPath)
    if($all.Length -lt 32 -or $all.Length -gt 16384){throw 'size'}
    $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-OPERATOR-1')
    for($i=0;$i -lt $magic.Length;$i++){if($all[$i] -ne $magic[$i]){throw 'magic'}}
    $encrypted=$all[$magic.Length..($all.Length-1)]
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/operator/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $item=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json
    if($item.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $item.schema -cne 'phase08_meta_ads' -or
      $item.authId -cnotmatch '^[a-f0-9-]{36}$' -or $item.appId -cnotmatch '^[a-f0-9-]{36}$' -or
      $item.email -cne ('phase08-eval-'+$item.authId+'@example.invalid') -or $item.password.Length -ne 44){throw 'identity'}
    return $item
  } finally {foreach($bytes in @($all,$plain,$encrypted)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}}
}
function Assert-Phase08LoginResponse($response,$session,$operator,$origin) {
  if([int]$response.StatusCode -ne 200 -or [string]$response.Headers['Cache-Control'] -notmatch '(?i)(^|[,\s])no-store([,\s]|$)'){throw 'login-response'}
  $payload=$response.Content|ConvertFrom-Json
  # AuthService.toResponse returns the app principal under user, never provider tokens.
  $rootKeys=@($payload.PSObject.Properties.Name)
  if($rootKeys.Count -ne 3 -or @($rootKeys|Where-Object {$_ -cnotin @('user','permissions','authorizationVersion')}).Count -ne 0){throw 'login-body-shape'}
  $user=$payload.user
  $userKeys=@($user.PSObject.Properties.Name)
  if($userKeys.Count -ne 6 -or @($userKeys|Where-Object {$_ -cnotin @('id','email','name','role','isActive','inviteStatus')}).Count -ne 0 -or
    $user.id -cne $operator.appId -or $user.email -cne $operator.email -or $user.role -cne 'SUPER_ADMIN' -or
    $user.isActive -isnot [bool] -or $user.isActive -ne $true -or $user.inviteStatus -cne 'ACTIVE' -or
    $payload.permissions -isnot [Array] -or $payload.permissions -cnotcontains 'settings.manage' -or
    @($payload.permissions|Where-Object {$_ -isnot [string]}).Count -ne 0 -or
    $payload.authorizationVersion -isnot [string] -or $payload.authorizationVersion.Length -lt 32 -or
    $response.Content.Contains($operator.password)){throw 'login-identity'}
  $names=@('__Host-phase08-meta_access','__Host-phase08-meta_refresh','__Host-phase08-meta_session','__Host-phase08-meta_csrf')
  $cookies=@($session.Cookies.GetCookies([Uri]$origin))
  $setCookies=@($response.Headers['Set-Cookie'])
  if($session.Cookies.Count -ne 4 -or $cookies.Count -ne 4 -or $setCookies.Count -ne 4){throw 'login-cookie-count'}
  foreach($name in $names) {
    $matching=@($cookies|Where-Object {$_.Name -ceq $name})
    $raw=@($setCookies|Where-Object {$_ -cmatch ('^'+[regex]::Escape($name)+'=')})
    if($matching.Count -ne 1 -or $raw.Count -ne 1){throw 'login-cookie-name'}
    $cookie=$matching[0];$header=[string]$raw[0];$auth=$name -cne '__Host-phase08-meta_csrf'
    if(-not $cookie.Secure -or $cookie.Path -cne '/' -or $cookie.HttpOnly -ne $auth -or
      [string]::IsNullOrWhiteSpace($cookie.Value) -or $response.Content.Contains($cookie.Value) -or
      $header -notmatch '(?i);\s*Secure(?:;|$)' -or $header -notmatch '(?i);\s*Path=/(?:;|$)' -or
      $header -match '(?i);\s*Domain=' -or (($header -match '(?i);\s*HttpOnly(?:;|$)') -ne $auth)){throw 'login-cookie-security'}
  }
}
