param([Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$ExpectedDeploymentId,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSourceSha,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedReleaseId,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedRuntimeFingerprint,
 [Parameter(Mandatory)][string]$ReleaseEvidencePath,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ReleaseEvidenceSha256,
 [Parameter(Mandatory)][string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
. "$PSScriptRoot/operator-session.ps1"
$script:IncidentAuthOrigin='https://phase08-daily-data-sync-production.up.railway.app'
$script:IncidentAuthChecks=[Collections.Generic.List[object]]::new()
$script:IncidentAuthLastHttp=$null
$script:IncidentAuthModulePath=Join-Path $PSScriptRoot 'incident-auth-verify.mjs'
function Invoke-IncidentAuthVectors($Value){
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance'
 foreach($a in @('node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json',$script:IncidentAuthModulePath)){$psi.ArgumentList.Add($a)}
 $psi.Environment.Clear();foreach($k in @('PATH','SystemRoot','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($k)){$psi.Environment[$k]=[Environment]::GetEnvironmentVariable($k)}}
 $p=[Diagnostics.Process]::new();$p.StartInfo=$psi;$wire=$null;$raw=$null
 try{$null=$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();$wire=$Value|ConvertTo-Json -Depth 12 -Compress;$p.StandardInput.Write($wire);$p.StandardInput.Close();if(-not $p.WaitForExit(30000)){$p.Kill($true);throw 'VECTORS_TIMEOUT'};$raw=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($p.ExitCode -ne 0 -or $raw.Length -gt 262144){throw 'VECTORS_REJECTED'};return ($raw|ConvertFrom-Json -AsHashtable -Depth 12 -DateKind String)}finally{$wire=$null;$raw=$null;$Value=$null;$p.Dispose()}
}
function Get-IncidentAuthCookie($Session,[string]$Name){$cookies=@($Session.Cookies.GetCookies([Uri]$script:IncidentAuthOrigin)|Where-Object {$_.Name -ceq $Name});if($cookies.Count -ne 1){throw 'COOKIE_SHAPE'};return $cookies[0].Value}
function Copy-IncidentAuthSession($Original,[string]$ReplaceName,[string]$ReplaceValue){
 $copy=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
 foreach($c in @($Original.Cookies.GetCookies([Uri]$script:IncidentAuthOrigin))){$value=if($c.Name -ceq $ReplaceName){$ReplaceValue}else{$c.Value};$cookie=[Net.Cookie]::new($c.Name,$value,'/',([Uri]$script:IncidentAuthOrigin).Host);$cookie.Secure=$c.Secure;$cookie.HttpOnly=$c.HttpOnly;$copy.Cookies.Add($cookie)}
 return $copy
}
function Invoke-IncidentAuthHttp([string]$Name,[string]$Method,[string]$Path,$Session,$Body,[hashtable]$ExtraHeaders,[int]$Expected){
 if(($Method -ceq 'GET' -and $Path -cnotin @('/auth/me','/health/ready')) -or ($Method -ceq 'POST' -and $Path -cnotin @('/auth/login','/auth/logout','/auth/refresh','/reports/export')) -or $Method -cnotin @('GET','POST')){throw 'HTTP_ROUTE_REJECTED'}
 if($Path -ceq '/reports/export' -and ($Body -isnot [Collections.IDictionary] -or $Body.Count -ne 0)){throw 'NONEMPTY_REPORT_BODY_REJECTED'}
 $headers=@{Origin=$script:IncidentAuthOrigin};foreach($k in $ExtraHeaders.Keys){if($k -cnotin @('X-CSRF-Token','x-internal-probe-token')){throw 'HTTP_HEADER_REJECTED'};$headers[$k]=$ExtraHeaders[$k]}
 $request=@{Uri=($script:IncidentAuthOrigin+'/backend-api'+$Path);Method=$Method;Headers=$headers;WebSession=$Session;MaximumRedirection=0;TimeoutSec=45;SkipHttpErrorCheck=$true};if($Method -ceq 'POST'){$request.ContentType='application/json';$request.Body=$Body|ConvertTo-Json -Compress}
 try{try{$r=Invoke-WebRequest @request}finally{$script:IncidentAuthLastHttp=[DateTimeOffset]::UtcNow.ToString('o')};if([Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 262144){throw 'HTTP_BODY_LIMIT'}
  $script:IncidentAuthChecks.Add(@{name=$Name;method=$Method;path=$Path;httpStatus=[int]$r.StatusCode;expected=$Expected;pass=([int]$r.StatusCode -eq $Expected)})
  if([int]$r.StatusCode -ne $Expected){throw 'HTTP_STATUS_REJECTED'};return $r
 }catch{throw 'INCIDENT_AUTH_HTTP_REJECTED'}finally{$headers.Clear();$request=$null;$Body=$null}
}
function Assert-IncidentAuthIdentity($Variables,$Instance,$Changes){
 if($Instance.serviceId -cne $script:IncidentScope.s -or $Instance.environmentId -cne $script:IncidentScope.e -or $Instance.latestDeployment.id -cne $ExpectedDeploymentId -or $Instance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $Variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $ExpectedSourceSha -or $Variables.RELEASE_GIT_SHA -cne $ExpectedReleaseId -or $Variables.AUTH_PROVIDER -cne 'supabase' -or $Variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $Variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false'){throw 'DEPLOYMENT_IDENTITY_REJECTED'}
 foreach($k in @('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN','DATABASE_URL')){if($Variables[$k] -cne $Changes[$k]){throw 'FRESH_CONFIG_NOT_ACTIVE'}}
 foreach($k in @('AUTH_SESSION_HANDLE_PREVIOUS_SECRET','AUTH_CSRF_PREVIOUS_SECRET','DAILY_SYNC_MACHINE_TOKEN_PREVIOUS')){if($Variables.ContainsKey($k) -and -not [string]::IsNullOrWhiteSpace($Variables[$k])){throw 'OLD_FALLBACK_CONFIGURED'}}
}
function Save-IncidentAuthReceipt($Value,[string]$Path){$f=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 12));$f.Write($bytes)}finally{$f.Dispose()}}
$stage='EVIDENCE';$passed=$false;$session=$null;$operator=$null;$old=$null;$fresh=$null;$vectors=$null;$loginAttempted=$false;$loginVerified=$false;$sessionMayRemain=$false;$logoutAttempted=$false;$logoutVerified=$false;$localProof=$null;$destination=$null;$destinationValidated=$false;$identityVerified=$false
try{
 $destination=[IO.Path]::GetFullPath($EvidencePath);$base=[IO.Path]::GetFullPath($script:IncidentEvidence)+[IO.Path]::DirectorySeparatorChar
 if(-not $destination.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'EVIDENCE_DESTINATION'}
 $destinationValidated=$true
 $release=Get-Item -LiteralPath $ReleaseEvidencePath;if($release.Length -gt 262144 -or ($release.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $release.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ReleaseEvidenceSha256){throw 'RELEASE_EVIDENCE_HASH'}
 $binding=[IO.File]::ReadAllText($release.FullName)|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
 if($binding.scope.p -cne $script:IncidentScope.p -or $binding.scope.e -cne $script:IncidentScope.e -or $binding.scope.s -cne $script:IncidentScope.s -or $binding.deploymentId -cne $ExpectedDeploymentId -or $binding.sourceSha -cne $ExpectedSourceSha -or $binding.releaseId -cne $ExpectedReleaseId -or $binding.runtimeConfigFingerprint -cne $ExpectedRuntimeFingerprint){throw 'RELEASE_EVIDENCE_BINDING'}
 $stage='PROTECTED_INPUT';$old=Read-IncidentPrivate 'compromised-baseline';$fresh=Read-IncidentPrivate 'fresh-core-v2';$operator=Read-Phase08Operator
 foreach($k in @('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN','DATABASE_URL')){if([string]::IsNullOrWhiteSpace($fresh.changes[$k]) -or $fresh.changes[$k] -ceq $old.variables[$k]){throw 'SECRET_NOT_CHANGED'}}
 $stage='LIVE_IDENTITY';$live=Get-IncidentState;Assert-IncidentAuthIdentity $live.variables $live.serviceInstance $fresh.changes;$identityVerified=$true;$live=$null
 Save-IncidentAuthReceipt @{kind='INCIDENT_AUTH_VERIFY_BEGUN';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;retryLogin=$false} ($destination+'.begun.json')
 $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
 $stage='PROBE_OLD';$null=Invoke-IncidentAuthHttp 'old_probe' GET '/health/ready' $session $null @{'x-internal-probe-token'=$old.variables.INTERNAL_PROBE_TOKEN} 403
 $stage='PROBE_NEW';$r=Invoke-IncidentAuthHttp 'new_probe' GET '/health/ready' $session $null @{'x-internal-probe-token'=$fresh.changes.INTERNAL_PROBE_TOKEN} 200;$ready=$r.Content|ConvertFrom-Json
 if($ready.status -cne 'ready' -or $ready.releaseId -cne $ExpectedReleaseId -or $ready.runtimeConfigFingerprint -cne $ExpectedRuntimeFingerprint){throw 'READINESS_IDENTITY'};$r=$null;$ready=$null
 $stage='LOGIN';$loginAttempted=$true;$sessionMayRemain=$true;$r=Invoke-IncidentAuthHttp 'operator_login' POST '/auth/login' $session @{email=$operator.email;password=$operator.password} @{} 200;Assert-Phase08LoginResponse $r $session $operator $script:IncidentAuthOrigin;$loginVerified=$true;$r=$null
 $stage='FRESH_ME';$r=Invoke-IncidentAuthHttp 'fresh_session_me' GET '/auth/me' $session $null @{} 200;$me=$r.Content|ConvertFrom-Json;if($me.user.id -cne $operator.appId -or $me.user.role -cne 'SUPER_ADMIN'){throw 'PRINCIPAL_REJECTED'};$me=$null;$r=$null
 $stage='LOCAL_COOKIE_SERVICE';$projectionOld=@{};$projectionNew=@{};foreach($k in @('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET')){$projectionOld[$k]=$old.variables[$k];$projectionNew[$k]=$fresh.changes[$k]}
 $vectors=Invoke-IncidentAuthVectors @{operation='vectors';old=$projectionOld;current=$projectionNew;freshSessionHandle=(Get-IncidentAuthCookie $session '__Host-phase08-meta_session');appId=$operator.appId};$projectionOld=$null;$projectionNew=$null;$localProof=@{proof=$vectors.proof;source=$vectors.source}
 # GET /auth/me authenticates the access JWT, not the handle. Refresh is the
 # actual handle-MAC boundary; compare it with the same valid refresh/session.
 $stage='OLD_SESSION_MAC';$currentCsrf=Get-IncidentAuthCookie $session '__Host-phase08-meta_csrf';$variant=Copy-IncidentAuthSession $session '__Host-phase08-meta_session' $vectors.oldSessionHandle;$r=Invoke-IncidentAuthHttp 'old_session_mac_same_valid_refresh_session' POST '/auth/refresh' $variant @{} @{'X-CSRF-Token'=$currentCsrf} 401;if(($r.Content|ConvertFrom-Json).code -cne 'SESSION_INVALID'){throw 'OLD_HANDLE_BOUNDARY_NOT_PROVEN'};$variant=$null;$r=$null
 $stage='NEW_SESSION_MAC';$null=Invoke-IncidentAuthHttp 'new_session_mac_refresh_valid' POST '/auth/refresh' $session @{} @{'X-CSRF-Token'=$currentCsrf} 200;$currentCsrf=$null
 $null=Invoke-IncidentAuthHttp 'fresh_session_still_valid' GET '/auth/me' $session $null @{} 200
 $stage='OLD_CSRF_MAC';$variant=Copy-IncidentAuthSession $session '__Host-phase08-meta_csrf' $vectors.oldCsrf;$r=Invoke-IncidentAuthHttp 'old_csrf_mac_current_time_matched_cookie_header' POST '/reports/export' $variant @{} @{'X-CSRF-Token'=$vectors.oldCsrf} 403;if(($r.Content|ConvertFrom-Json).code -cne 'CSRF_INVALID'){throw 'OLD_CSRF_BOUNDARY_NOT_PROVEN'};$variant=$null;$r=$null
 $stage='NEW_CSRF_MAC';$variant=Copy-IncidentAuthSession $session '__Host-phase08-meta_csrf' $vectors.newCsrf;$null=Invoke-IncidentAuthHttp 'new_csrf_empty_report_body_validation' POST '/reports/export' $variant @{} @{'X-CSRF-Token'=$vectors.newCsrf} 400;$variant=$null
 $stage='FINAL_IDENTITY';$live=Get-IncidentState;Assert-IncidentAuthIdentity $live.variables $live.serviceInstance $fresh.changes;$live=$null;$passed=$true
}catch{$script:IncidentAuthChecks.Add(@{name='control';stage=$stage;pass=$false;rawErrorSuppressed=$true})}
finally{
 if($sessionMayRemain -and $null -ne $session){
  try{$stage='LOGOUT';$replay=Copy-IncidentAuthSession $session '' '';$csrf=Get-IncidentAuthCookie $session '__Host-phase08-meta_csrf';$logoutAttempted=$true;$null=Invoke-IncidentAuthHttp 'logout' POST '/auth/logout' $session @{} @{'X-CSRF-Token'=$csrf} 204;$null=Invoke-IncidentAuthHttp 'revoked_fresh_cookie_replay' GET '/auth/me' $replay $null @{} 401;$logoutVerified=$true;$sessionMayRemain=$false;$replay=$null;$csrf=$null}catch{$passed=$false;$script:IncidentAuthChecks.Add(@{name='cleanup';stage=$stage;pass=$false;rawErrorSuppressed=$true})}
 }
 $result=@{kind='INCIDENT_AUTH_ACTUAL_VERIFY';status=$(if($passed -and $logoutVerified){'PASS'}else{'FAIL'});observedAt=[DateTimeOffset]::UtcNow.ToString('o');lastAppHttpAt=$script:IncidentAuthLastHttp;deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;releaseId=$ExpectedReleaseId;runtimeConfigFingerprint=$ExpectedRuntimeFingerprint;releaseEvidenceSha256=$ReleaseEvidenceSha256;checks=@($script:IncidentAuthChecks.ToArray());actualCookieServicePureProof=$localProof;sessionMacRemoteBoundary='POST /auth/refresh: old401 SESSION_INVALID versus new200';meUsesAccessJwtNotHandleMac=$true;loginAttempted=$loginAttempted;loginVerified=$loginVerified;logoutAttempted=$logoutAttempted;logoutVerified=$logoutVerified;sessionMayRemain=$sessionMayRemain;expectedSecurityWrites=@('auth-session','auth-audit','security-rate-limit');businessWrites=0;collectionRequests=0;mailRequests=0;machineRemotePositiveVerified=$false;runtimeIdentityVerified=$identityVerified;machineFeatureHeldFalse=$(if($identityVerified){$true}else{$null});authzRemoteRoleMutationTested=$false;oldKeyFallbackConfigured=$(if($identityVerified){$false}else{$null});rawSecretsReturned=0;rawErrorSuppressed=$true}
 if($destinationValidated -and -not(Test-Path -LiteralPath $destination)){try{Save-IncidentAuthReceipt $result $destination}catch{$passed=$false}}
 $session=$null;$operator=$null;$old=$null;$fresh=$null;$vectors=$null;$variant=$null;$r=$null
}
@{kind=$result.kind;status=$result.status;checks=$script:IncidentAuthChecks.Count;sessionMayRemain=$sessionMayRemain;lastAppHttpAt=$script:IncidentAuthLastHttp;evidence=$destination}|ConvertTo-Json -Compress
if($result.status -cne 'PASS' -or -not $passed){exit 1}
