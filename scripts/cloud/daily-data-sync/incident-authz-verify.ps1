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
function Import-IncidentAuthzDefinitions {
 $t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'incident-auth-verify.ps1'),[ref]$t,[ref]$e);if($e.Count){throw 'AUTH_HELPER_PARSE'}
 foreach($name in @('Invoke-IncidentAuthVectors','Get-IncidentAuthCookie','Copy-IncidentAuthSession','Invoke-IncidentAuthHttp','Assert-IncidentAuthIdentity','Save-IncidentAuthReceipt')){
  $fn=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});if($fn.Count -ne 1){throw 'AUTH_HELPER_FUNCTION'}
  $parameters=($fn[0].Parameters|ForEach-Object {$_.Extent.Text}) -join ',';$body=$fn[0].Body.Extent.Text.Substring(1,$fn[0].Body.Extent.Text.Length-2)
  Set-Item -LiteralPath ('function:script:'+$name) -Value ([scriptblock]::Create("param($parameters)`n"+$body))
 }
}
function Read-IncidentAuthzCounter($Operator){
 if($Operator.appId -cnotmatch '^[a-f0-9-]{36}$' -or $Operator.authId -cnotmatch '^[a-f0-9-]{36}$'){throw 'OPERATOR_UUID'}
 $sql=@"
BEGIN READ ONLY;SET LOCAL statement_timeout='15s';
SELECT id::text AS id,auth_user_id::text AS auth_id,is_active,role::text AS role,authz_version
FROM phase08_meta_ads.app_users WHERE id='$($Operator.appId)'::uuid;
COMMIT;
"@
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1 -or $rows[0].id -cne $Operator.appId -or $rows[0].auth_id -cne $Operator.authId -or $rows[0].is_active -cne $true -or $rows[0].role -cne 'SUPER_ADMIN' -or $rows[0].authz_version -lt 1 -or $rows[0].authz_version -gt 2147483647){throw 'OPERATOR_COUNTER_IDENTITY'}
 return [int]$rows[0].authz_version
}
$script:IncidentAuthOrigin='https://phase08-daily-data-sync-production.up.railway.app';$script:IncidentAuthChecks=[Collections.Generic.List[object]]::new();$script:IncidentAuthLastHttp=$null;$script:IncidentAuthModulePath=Join-Path $PSScriptRoot 'incident-authz-verify.mjs'
$stage='EVIDENCE';$passed=$false;$destination=$null;$destinationValid=$false;$session=$null;$operator=$null;$fresh=$null;$old=$null;$proof=$null;$loginAttempted=$false;$loginVerified=$false;$responsesMatch=$false;$sessionMayRemain=$false;$logoutAttempted=$false;$logoutVerified=$false;$counterRead=$false
try{
 Import-IncidentAuthzDefinitions
 $destination=[IO.Path]::GetFullPath($EvidencePath);$base=[IO.Path]::GetFullPath($script:IncidentEvidence)+[IO.Path]::DirectorySeparatorChar
 if(-not $destination.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $destination) -or -not(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'EVIDENCE_DESTINATION'};$destinationValid=$true
 $file=Get-Item -LiteralPath $ReleaseEvidencePath;if($file.Length -gt 262144 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ReleaseEvidenceSha256){throw 'RELEASE_EVIDENCE_HASH'}
 $binding=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
 if($binding.scope.p -cne $script:IncidentScope.p -or $binding.scope.e -cne $script:IncidentScope.e -or $binding.scope.s -cne $script:IncidentScope.s -or $binding.deploymentId -cne $ExpectedDeploymentId -or $binding.sourceSha -cne $ExpectedSourceSha -or $binding.releaseId -cne $ExpectedReleaseId -or $binding.runtimeConfigFingerprint -cne $ExpectedRuntimeFingerprint){throw 'RELEASE_EVIDENCE_BINDING'}
 $stage='PROTECTED_INPUT';$fresh=Read-IncidentPrivate 'fresh-core-v2';$old=Read-IncidentPrivate 'compromised-baseline';$operator=Read-Phase08Operator
 if($fresh.changes.AUTH_AUTHORIZATION_VERSION_SECRET -ceq $old.variables.AUTH_AUTHORIZATION_VERSION_SECRET){throw 'AUTHZ_KEY_NOT_CHANGED'}
 $stage='LIVE_IDENTITY';$live=Get-IncidentState;Assert-IncidentAuthIdentity $live.variables $live.serviceInstance $fresh.changes;$live=$null
 Save-IncidentAuthReceipt @{kind='INCIDENT_AUTHZ_VERIFY_BEGUN';at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;retryLogin=$false} ($destination+'.begun.json')
 $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
 $stage='NEW_PROBE';$r=Invoke-IncidentAuthHttp 'authz_ready' GET '/health/ready' $session $null @{'x-internal-probe-token'=$fresh.changes.INTERNAL_PROBE_TOKEN} 200;$ready=$r.Content|ConvertFrom-Json;if($ready.releaseId -cne $ExpectedReleaseId -or $ready.runtimeConfigFingerprint -cne $ExpectedRuntimeFingerprint){throw 'READINESS_BINDING'};$r=$null;$ready=$null
 $stage='LOGIN';$loginAttempted=$true;$sessionMayRemain=$true;$r=Invoke-IncidentAuthHttp 'authz_operator_login' POST '/auth/login' $session @{email=$operator.email;password=$operator.password} @{} 200;Assert-Phase08LoginResponse $r $session $operator $script:IncidentAuthOrigin;$loginAuthorizationVersion=($r.Content|ConvertFrom-Json).authorizationVersion;$loginVerified=$true;$r=$null
 $stage='ME';$r=Invoke-IncidentAuthHttp 'authz_operator_me' GET '/auth/me' $session $null @{} 200;$me=$r.Content|ConvertFrom-Json
 if($me.user.id -cne $operator.appId -or $me.user.role -cne 'SUPER_ADMIN' -or $me.authorizationVersion -cne $loginAuthorizationVersion){throw 'AUTHZ_RESPONSE_BINDING'}
 $responsesMatch=$true;$serverAuthorizationVersion=$me.authorizationVersion;$me=$null;$r=$null;$loginAuthorizationVersion=$null
 $stage='EXACT_OPERATOR_READ_ONLY_COUNTER';$counter=Read-IncidentAuthzCounter $operator;$counterRead=$true
 $stage='ACTUAL_COOKIE_SERVICE_MAC_COMPARISON';$proof=Invoke-IncidentAuthVectors @{operation='verify-authz';oldSecret=$old.variables.AUTH_AUTHORIZATION_VERSION_SECRET;newSecret=$fresh.changes.AUTH_AUTHORIZATION_VERSION_SECRET;appId=$operator.appId;authzVersion=$counter;serverAuthorizationVersion=$serverAuthorizationVersion};$serverAuthorizationVersion=$null;$counter=$null
 if($proof.pass -cne $true -or $proof.newMatchesServer -cne $true -or $proof.oldMatchesServer -cne $false){throw 'AUTHZ_ACTIVATION_NOT_PROVEN'}
 $stage='FINAL_IDENTITY';$live=Get-IncidentState;Assert-IncidentAuthIdentity $live.variables $live.serviceInstance $fresh.changes;$live=$null;$passed=$true
}catch{$script:IncidentAuthChecks.Add(@{name='control';stage=$stage;pass=$false;rawErrorSuppressed=$true})}
finally{
 if($sessionMayRemain -and $null -ne $session){try{$stage='LOGOUT';$replay=Copy-IncidentAuthSession $session '' '';$csrf=Get-IncidentAuthCookie $session '__Host-phase08-meta_csrf';$logoutAttempted=$true;$null=Invoke-IncidentAuthHttp 'authz_logout' POST '/auth/logout' $session @{} @{'X-CSRF-Token'=$csrf} 204;$null=Invoke-IncidentAuthHttp 'authz_revoked_cookie_replay' GET '/auth/me' $replay $null @{} 401;$logoutVerified=$true;$sessionMayRemain=$false}catch{$passed=$false;$script:IncidentAuthChecks.Add(@{name='cleanup';stage=$stage;pass=$false;rawErrorSuppressed=$true})}}
 $result=@{kind='INCIDENT_AUTHZ_ACTIVATION_ACTUAL_VERIFY';status=$(if($passed -and $logoutVerified){'PASS'}else{'FAIL'});observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;releaseId=$ExpectedReleaseId;runtimeConfigFingerprint=$ExpectedRuntimeFingerprint;releaseEvidenceSha256=$ReleaseEvidenceSha256;checks=@($script:IncidentAuthChecks.ToArray());actualCookieServiceComparison=$proof;exactOperatorCounterReadOnly=$counterRead;loginAndMeVersionEqual=$responsesMatch;loginAttempted=$loginAttempted;loginVerified=$loginVerified;logoutAttempted=$logoutAttempted;logoutVerified=$logoutVerified;sessionMayRemain=$sessionMayRemain;lastAppHttpAt=$script:IncidentAuthLastHttp;roleWrites=0;authzCounterWrites=0;businessWrites=0;providerCollectionRequests=0;mailRequests=0;expectedSecurityWrites=@('auth-session','auth-audit','security-rate-limit');macValuesReturned=0;rawSecretsReturned=0;rawErrorSuppressed=$true}
 if($destinationValid -and -not(Test-Path -LiteralPath $destination)){try{Save-IncidentAuthReceipt $result $destination}catch{$passed=$false}}
 $session=$null;$operator=$null;$old=$null;$fresh=$null;$serverAuthorizationVersion=$null;$loginAuthorizationVersion=$null;$counter=$null;$r=$null;$me=$null;$replay=$null;$csrf=$null
}
@{kind=$result.kind;status=$result.status;sessionMayRemain=$sessionMayRemain;checks=$script:IncidentAuthChecks.Count;lastAppHttpAt=$script:IncidentAuthLastHttp;evidence=$destination}|ConvertTo-Json -Compress
if($result.status -cne 'PASS' -or -not $passed){exit 1}
