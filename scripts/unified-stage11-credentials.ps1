param([ValidateSet('Provision','Run','SetRailwayRuntime')][string]$Action='Run',[string]$ScriptPath,[string[]]$ScriptArguments=@())
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$privateRoot=Join-Path $env:LOCALAPPDATA 'UnifiedPerformanceStage11Credentials'
$privateFile=Join-Path $privateRoot 'roles.dpapi'
function Assert-PrivatePath([string]$Path){
  $item=Get-Item -LiteralPath $Path
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'PRIVATE_PATH_REJECTED'}
  $acl=Get-Acl -LiteralPath $Path
  $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
  if(-not $acl.AreAccessRulesProtected){throw 'PRIVATE_ACL_REQUIRED'}
  foreach($rule in $acl.Access){if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'PRIVATE_ACL_REJECTED'}}
}
function New-PrivateDirectory {
  if(Test-Path -LiteralPath $privateRoot){Assert-PrivatePath $privateRoot;return}
  [void][IO.Directory]::CreateDirectory($privateRoot)
  $acl=Get-Acl -LiteralPath $privateRoot;$acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($rule)}
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($user)
  foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
  Set-Acl -LiteralPath $privateRoot -AclObject $acl;Assert-PrivatePath $privateRoot
}
$secrets=$null;$plain=$null;$headers=$null;$token=$null
try {
  if($Action -eq 'Provision') {
    New-PrivateDirectory
    if(Test-Path -LiteralPath $privateFile){throw 'EXISTING_ROLE_CREDENTIALS_REQUIRE_REVIEW'}
    $secrets=@{projectRef='iygjmosbelbosfxidqxv';reportRole='meta_ads_unified_report';workerRole='meta_ads_unified_worker';reportPassword=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32));workerPassword=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))}
    $plain=$secrets|ConvertTo-Json -Compress
    $plain|ConvertTo-SecureString -AsPlainText -Force|ConvertFrom-SecureString|Set-Content -LiteralPath $privateFile
    # Protect this file independently of inherited directory permissions.
    $acl=Get-Acl -LiteralPath $privateFile;$acl.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $privateFile -AclObject $acl;Assert-PrivatePath $privateFile
    $sql="BEGIN; ALTER ROLE meta_ads_unified_report LOGIN PASSWORD '$($secrets.reportPassword)' CONNECTION LIMIT 3; ALTER ROLE meta_ads_unified_worker LOGIN PASSWORD '$($secrets.workerPassword)' CONNECTION LIMIT 2; COMMIT;"
    $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
    $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -Body (@{query=$sql}|ConvertTo-Json -Compress) -ContentType application/json -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
    # Never persist API error text: the statement contains generated passwords.
    if([int]$reply.StatusCode -notin @(200,201)){throw 'ROLE_LOGIN_PROVISION_FAILED_CHECK_SAVED_PRIVATE_CREDENTIALS'}
    @{stage=11;operation='RESTRICTED_ROLE_LOGIN_PROVISION';status='PASS';observedAt=[DateTime]::UtcNow.ToString('o');credentialStorage='CurrentUser DPAPI; ACL current user and SYSTEM only';roles=@($secrets.reportRole,$secrets.workerRole)}|ConvertTo-Json -Depth 5|Set-Content docs/product-performance/research/11-role-login-result.json
    Write-Output 'RESTRICTED_ROLE_LOGINS_PROVISIONED'
  } else {
    Assert-PrivatePath $privateRoot;Assert-PrivatePath $privateFile
    $secure=(Get-Content -LiteralPath $privateFile -Raw).Trim()|ConvertTo-SecureString
    $plain=[System.Net.NetworkCredential]::new('',$secure).Password
    $secrets=$plain|ConvertFrom-Json -AsHashtable
    $env:UNIFIED_STAGE11_SECRETS_JSON=$plain
    if($Action -eq 'Run') {
      if(-not $ScriptPath){throw 'SCRIPT_PATH_REQUIRED'}
      & npx.cmd --yes @railway/cli@5.71.0 run --project 6fe72710-1fc8-445a-a77f-da2da8fee200 --service b0835b08-7799-4c1c-8bcd-90746b9d4248 --environment 01ab3d5a-1036-45b0-aa9c-47179339c9be --no-local -- node --import tsx scripts/unified-stage11-runtime.mjs $ScriptPath @ScriptArguments
    } else {
      & npx.cmd --yes @railway/cli@5.71.0 run --project 6fe72710-1fc8-445a-a77f-da2da8fee200 --service b0835b08-7799-4c1c-8bcd-90746b9d4248 --environment 01ab3d5a-1036-45b0-aa9c-47179339c9be --no-local -- node scripts/unified-stage11-runtime.mjs --set-railway-runtime
    }
    if($LASTEXITCODE -ne 0){throw 'STAGE11_RESTRICTED_RUNTIME_COMMAND_FAILED'}
  }
} finally {Remove-Item Env:UNIFIED_STAGE11_SECRETS_JSON -ErrorAction SilentlyContinue;if($headers){$headers.Clear()};$token=$null;$headers=$null;$secrets=$null;$plain=$null;$sql=$null;$reply=$null}
