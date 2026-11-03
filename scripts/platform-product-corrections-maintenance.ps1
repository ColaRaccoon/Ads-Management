param([Parameter(Mandatory)][ValidateSet('preflight','trial','apply','replay','verify')][string]$Action,[ValidateRange(1,2000)][int]$Limit=1000)
$ErrorActionPreference='Stop'
$privateRoot=Join-Path $env:LOCALAPPDATA 'UnifiedPerformanceStage11Credentials'
$privateFile=Join-Path $privateRoot 'roles.dpapi'
foreach($protectedPath in @($privateRoot,$privateFile)) {
  $item=Get-Item -LiteralPath $protectedPath
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw 'PROTECTED_PATH_REJECTED'}
  $acl=Get-Acl -LiteralPath $protectedPath
  if(-not $acl.AreAccessRulesProtected){throw 'PROTECTED_ACL_REQUIRED'}
  $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18')
  foreach($rule in $acl.Access){if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'PROTECTED_ACL_REJECTED'}}
}
$secure=$null;$plain=$null;$secrets=$null
try {
  $secure=(Get-Content -LiteralPath $privateFile -Raw).Trim()|ConvertTo-SecureString
  $plain=[System.Net.NetworkCredential]::new('',$secure).Password
  $secrets=$plain|ConvertFrom-Json -AsHashtable
  if($secrets.projectRef -cne 'iygjmosbelbosfxidqxv' -or $secrets.reportRole -cne 'meta_ads_unified_report' -or $secrets.workerRole -cne 'meta_ads_unified_worker'){throw 'TARGET_MISMATCH'}
  $env:MAPPING_REPORT_PASSWORD=$secrets.reportPassword
  $env:MAPPING_WORKER_PASSWORD=$secrets.workerPassword
  node --env-file=apps/api/.env scripts/platform-product-corrections-maintenance.mjs "--action=$Action" '--plan-sha=67676d1a8f311f6ef64a97557bc1e2bee05b51a759e17de09eebc08053d11bca' "--limit=$Limit"
  if($LASTEXITCODE -ne 0){throw 'MAPPING_MAINTENANCE_FAILED'}
} finally {
  Remove-Item Env:MAPPING_REPORT_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:MAPPING_WORKER_PASSWORD -ErrorAction SilentlyContinue
  $secure=$null;$plain=$null;$secrets=$null
}
