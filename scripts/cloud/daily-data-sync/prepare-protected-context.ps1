# Creates only a new, no-overwrite CurrentUser DPAPI context. No remote writes.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
. 'C:/Users/seong/Desktop/workspace/Meta-Ads-Performance-security-rbac/보안단계별적용/증거/0908-staging-db-roles/phase2-secret-lib.ps1'
function Read-Phase08MetaToken([string]$Name) {
  if($Name -notin @('mcp-access-token.dpapi','inspector-token.dpapi')){throw 'PHASE08_INPUT_REJECTED'}
  $path=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsMetaIsolated' $Name
  Assert-R2ANotReparsePoint $path;Assert-R2AUserSystemOnlyAcl $path
  $all=$null;$encrypted=$null;$plain=$null
  try {
    $info=Get-Item -LiteralPath $path
    if($info.PSIsContainer -or $info.Length -lt 32 -or $info.Length -gt 16384){throw 'size'}
    $all=[IO.File]::ReadAllBytes($path);$magic=[Text.Encoding]::ASCII.GetBytes('META-DPAPI-1')
    for($i=0;$i -lt $magic.Length;$i++){if($all[$i] -ne $magic[$i]){throw 'magic'}}
    $encrypted=$all[$magic.Length..($all.Length-1)]
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[Text.Encoding]::ASCII.GetBytes('MetaAdsMetaIsolated/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    if($plain.Length -lt 40 -or $plain.Length -gt 4096){throw 'size'}
    foreach($value in $plain){if($value -lt 33 -or $value -gt 126){throw 'token'}}
    return [Text.Encoding]::ASCII.GetString($plain)
  } finally {foreach($bytes in @($all,$encrypted,$plain)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}}
}
$phase08Stage='INPUT_IDENTITY';$phase08Input=$null;$phase08Json=$null;$phase08Raw=$null;$phase08Child=$null;$phase08Material=$null
try {
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $phase08Paths=Get-Phase08ProtectedPaths
  if(Test-Path -LiteralPath $phase08Paths.File){throw 'existing'}
  $phase08OldRoot=Join-Path $env:APPDATA 'MetaAdsSecurity/staging-app-runtime'
  $phase08OldPath=Join-Path $phase08OldRoot 'railway-runtime.dpapi'
  $phase08KeyPath=Join-Path $phase08OldRoot 'signing-key.dpapi'
  foreach($path in @($phase08OldPath,$phase08KeyPath)){Assert-R2ANotReparsePoint $path;Assert-R2AUserSystemOnlyAcl $path}
  $phase08Old=(Unprotect-R2APlaintextSecret ([IO.File]::ReadAllText($phase08OldPath)))|ConvertFrom-Json -AsHashtable
  if($phase08Old.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $phase08Old.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co'){throw 'identity'}
  $phase08MinimalOld=@{SUPABASE_DATABASE_PROJECT_REF=$phase08Old.SUPABASE_DATABASE_PROJECT_REF;SUPABASE_URL=$phase08Old.SUPABASE_URL;SUPABASE_PUBLISHABLE_KEY=$phase08Old.SUPABASE_PUBLISHABLE_KEY;SUPABASE_SECRET_KEY=$phase08Old.SUPABASE_SECRET_KEY}
  $phase08Old=$null
  $phase08Key=(Unprotect-R2APlaintextSecret ([IO.File]::ReadAllText($phase08KeyPath)))|ConvertFrom-Json -AsHashtable
  $phase08Jwks=Invoke-RestMethod -Uri 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1/.well-known/jwks.json' -MaximumRedirection 0 -TimeoutSec 15
  $phase08Public=@($phase08Jwks.keys|Where-Object kid -eq $phase08Key.kid)
  if($phase08Public.Count -ne 1){throw 'key'}
  foreach($name in @('kty','crv','x','y')){if($phase08Public[0].$name -cne $phase08Key[$name]){throw 'key'}}
  $phase08AdcPath=Join-Path $env:APPDATA 'gcloud/application_default_credentials.json'
  Assert-R2ANotReparsePoint $phase08AdcPath
  if((Get-Item -LiteralPath $phase08AdcPath).Length -gt 65536){throw 'size'}
  $phase08Adc=Get-Content -Raw -LiteralPath $phase08AdcPath|ConvertFrom-Json -AsHashtable
  $phase08Metadata=@{}
  foreach($name in @('mcp-field-context-result.json','mcp-reporting-tools.json')){
    $path=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsMetaIsolated' $name
    Assert-R2ANotReparsePoint $path;Assert-R2AUserSystemOnlyAcl $path
    if((Get-Item -LiteralPath $path).Length -gt 1048576){throw 'size'}
    $phase08Metadata[$name]=Get-Content -Raw -LiteralPath $path|ConvertFrom-Json -AsHashtable
  }
  $phase08Input=@{oldRuntime=$phase08MinimalOld;jwk=$phase08Key;googleAdc=$phase08Adc;catalog=$phase08Metadata['mcp-field-context-result.json'];reporting=$phase08Metadata['mcp-reporting-tools.json'];
    sourceContentSha256='3ff3ed9fa235714d31f92a3ed93a9759131f6263313da91f33a8c1d87084073a';metaToken=(Read-Phase08MetaToken 'mcp-access-token.dpapi');inspectorToken=(Read-Phase08MetaToken 'inspector-token.dpapi')}
  $phase08Stage='MATERIAL_PREPARE'
  $phase08Psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe')
  $phase08Psi.ArgumentList.Add('--import');$phase08Psi.ArgumentList.Add('tsx');$phase08Psi.ArgumentList.Add("$PSScriptRoot/create-protected-material.mjs")
  $phase08Psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$phase08Psi.Environment['TSX_TSCONFIG_PATH']=Join-Path $phase08Psi.WorkingDirectory 'apps/api/tsconfig.json'
  $phase08Psi.UseShellExecute=$false;$phase08Psi.CreateNoWindow=$true
  $phase08Psi.RedirectStandardInput=$true;$phase08Psi.RedirectStandardOutput=$true;$phase08Psi.RedirectStandardError=$true
  $phase08Child=[Diagnostics.Process]::Start($phase08Psi)
  $phase08OutTask=$phase08Child.StandardOutput.ReadToEndAsync();$phase08ErrTask=$phase08Child.StandardError.ReadToEndAsync()
  $phase08Json=$phase08Input|ConvertTo-Json -Depth 35 -Compress
  $phase08Child.StandardInput.Write($phase08Json);$phase08Child.StandardInput.Close();$phase08Json=$null;$phase08Input=$null
  if(-not $phase08Child.WaitForExit(60000)){$phase08Child.Kill($true);throw 'timeout'}
  $phase08Raw=$phase08OutTask.GetAwaiter().GetResult();$phase08Discard=$phase08ErrTask.GetAwaiter().GetResult();$phase08Discard=$null
  if($phase08Child.ExitCode -ne 0 -or $phase08Raw.Length -gt 1048576){throw 'child'}
  $phase08Material=$phase08Raw|ConvertFrom-Json -AsHashtable -Depth 35;$phase08Raw=$null
  $phase08Stage='DPAPI_WRITE'
  Create-Phase08ProtectedJson -Value $phase08Material
  $phase08RoundTrip=Read-Phase08ProtectedJson
  if($phase08RoundTrip.runtimePassword -cne $phase08Material.runtimePassword -or $phase08RoundTrip.serviceId -cne $phase08Material.serviceId){throw 'roundtrip'}
  [ordered]@{state='PHASE08_PROTECTED_CONTEXT_PREPARED';path=$phase08Paths.File;origin=$phase08Material.origin;sourceContentSha256=$phase08Material.env.PHASE08_SOURCE_CONTENT_SHA256;storageExpiresAt=$phase08Material.storageExpiresAt;featureEnabled=$false;scheduleEnabled=$false;providerRequests=0;remoteWrites=0}|ConvertTo-Json
} catch {[ordered]@{state='PHASE08_PROTECTED_PREPARATION_FAILED';stage=$phase08Stage;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally {
  $phase08Input=$null;$phase08Json=$null;$phase08Raw=$null;$phase08Material=$null;$phase08RoundTrip=$null;$phase08Key=$null;$phase08Adc=$null;$phase08MinimalOld=$null;$phase08Metadata=$null
  if($phase08Child){if(-not $phase08Child.HasExited){$phase08Child.Kill($true)};$phase08Child.Dispose()}
}
