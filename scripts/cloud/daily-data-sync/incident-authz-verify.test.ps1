Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'incident-authz-verify.ps1'),[ref]$t,[ref]$e);if($e.Count){throw 'TEST_PARSE'}
foreach($fn in @($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]})){Invoke-Expression $fn.Extent.Text}
# Test the real AST importer without running the original auth helper's main.
$importer=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Import-IncidentAuthzDefinitions'})[0]
$text=$importer.Extent.Text.Replace("(Join-Path `$PSScriptRoot 'incident-auth-verify.ps1')",("'"+(Join-Path $PSScriptRoot 'incident-auth-verify.ps1').Replace("'","''")+"'"));Invoke-Expression $text
$operator=@{appId='11111111-1111-4111-8111-111111111111';authId='22222222-2222-4222-8222-222222222222'};$script:Observed=$null;$script:MockVersion=3;$script:MockIdentity=$true
function Invoke-Phase08Management {param($Action,$Query);$script:Observed=@{action=$Action;query=$Query};return [pscustomobject]@{id=$(if($script:MockIdentity){$operator.appId}else{'other'});auth_id=$operator.authId;is_active=$true;role='SUPER_ADMIN';authz_version=$script:MockVersion}}
$passed=0
try{
 Import-IncidentAuthzDefinitions;if(-not(Get-Command Invoke-IncidentAuthVectors -ErrorAction SilentlyContinue)){throw 'AST_IMPORT'};$passed++
 $n=Read-IncidentAuthzCounter $operator;if($n -ne 3 -or $script:Observed.action -cne 'Query' -or -not $script:Observed.query.StartsWith('BEGIN READ ONLY;') -or $script:Observed.query -notmatch "WHERE id='11111111-1111-4111-8111-111111111111'::uuid"){throw 'EXACT_OPERATOR_RO'};$passed++
 $script:MockIdentity=$false;$caught=$false;try{$null=Read-IncidentAuthzCounter $operator}catch{$caught=$true};if(-not $caught){throw 'OTHER_ID_ACCEPTED'};$passed++
 $script:MockIdentity=$true;$script:MockVersion=0;$caught=$false;try{$null=Read-IncidentAuthzCounter $operator}catch{$caught=$true};if(-not $caught){throw 'BAD_VERSION_ACCEPTED'};$passed++
 $script:IncidentAuthModulePath=Join-Path $PSScriptRoot 'incident-authz-verify.mjs';$new='SYNTHETIC_NEW_'+('a'*48);$old='SYNTHETIC_OLD_'+('b'*48);$h=[Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($new));try{$server=[Convert]::ToBase64String($h.ComputeHash([Text.Encoding]::UTF8.GetBytes(('authz'+[char]0+$operator.appId+':3')))).TrimEnd('=').Replace('+','-').Replace('/','_')}finally{$h.Dispose()};$r=Invoke-IncidentAuthVectors @{operation='verify-authz';appId=$operator.appId;authzVersion=3;newSecret=$new;oldSecret=$old;serverAuthorizationVersion=$server};if($r.pass -cne $true -or $r.newMatchesServer -cne $true -or $r.oldMatchesServer -cne $false -or ($r|ConvertTo-Json -Depth 8).Contains($server)){throw 'REAL_OFFLINE_CHILD'};$r=$null;$server=$null;$new=$null;$old=$null;$passed++
 @{kind='INCIDENT_AUTHZ_LOCAL_PS_TEST';passed=$passed;parseErrors=0;remoteRequests=0;protectedSecretReads=0;rawErrorSuppressed=$true}|ConvertTo-Json
}catch{@{kind='INCIDENT_AUTHZ_LOCAL_PS_TEST';status='FAIL';passed=$passed;remoteRequests=0;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
