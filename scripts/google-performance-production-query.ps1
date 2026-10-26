param([Parameter(Mandatory)][string]$SqlPath,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,[Parameter(Mandatory)][string]$ReceiptPath)
# Fixed production destination; secrets stay in memory. SQL is reviewed and hash-bound.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/cloud/daily-data-sync/protected-context.ps1"
$headers=$null;$response=$null
try {
  if ((Get-FileHash -LiteralPath $SqlPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) {throw 'SQL_HASH'}
  if (Test-Path -LiteralPath $ReceiptPath) {throw 'RECEIPT_EXISTS'}
  $sql=[IO.File]::ReadAllText((Resolve-Path -LiteralPath $SqlPath))
  if ($sql.Length -gt 1048576 -or $sql -notmatch '(?m)^BEGIN(?: READ ONLY)?;') {throw 'SQL_ENVELOPE'}
  $headers=@{Authorization=('Bearer '+(Get-Phase08SupabaseCredential))}
  $response=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/database/query' -Method Post -Headers $headers -ContentType 'application/json' -Body (@{query=$sql}|ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
  if ([int]$response.StatusCode -notin @(200,201)) {
    # This endpoint returns SQL diagnostics only; never emit request headers or credentials.
    @{status='REJECTED';httpStatus=[int]$response.StatusCode;diagnostic=$response.Content.Substring(0,[Math]::Min(1500,$response.Content.Length))}|ConvertTo-Json -Compress
    exit 1
  }
  $rows=$response.Content|ConvertFrom-Json -Depth 30
  [IO.File]::WriteAllText($ReceiptPath,($rows|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
  @{status='SUCCESS';projectRef='iygjmosbelbosfxidqxv';sqlSha256=$ExpectedSha256;receipt=$ReceiptPath}|ConvertTo-Json -Compress
} finally {if($headers){$headers.Clear()};$response=$null;$sql=$null}
