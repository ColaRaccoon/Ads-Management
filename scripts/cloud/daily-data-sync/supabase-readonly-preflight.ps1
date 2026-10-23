param([ValidateSet('Identity','Services','Pooler')][string]$Mode='Identity')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$phase08Ref='ehnfrrmbkvlsbpvqcvkr'
# Read precisely the Supabase CLI credential targets. Never enumerate or persist secrets.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Phase08CredentialRead {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Credential {
  public UInt32 Flags,Type; public string TargetName,Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public UInt32 BlobSize; public IntPtr Blob; public UInt32 Persist,AttributeCount; public IntPtr Attributes; public string Alias,UserName;
 }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Read(string target,UInt32 type,UInt32 flags,out IntPtr data);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr data);
 public static string Get(string target) {
  IntPtr data; if(!Read(target,1,0,out data)) return null;
  try { var c=Marshal.PtrToStructure<Credential>(data); if(c.BlobSize==0 || c.BlobSize>8192) return null;
   var bytes=new byte[c.BlobSize]; Marshal.Copy(c.Blob,bytes,0,bytes.Length);
   try { var value=Encoding.UTF8.GetString(bytes).TrimEnd('\0'); if(value.Contains("\0")) value=Encoding.Unicode.GetString(bytes).TrimEnd('\0'); return value; }
   finally { Array.Clear(bytes,0,bytes.Length); }
  } finally { CredFree(data); }
 }
}
'@
$phase08Token=$null
$phase08Headers=$null
try {
 foreach($phase08Target in @('Supabase CLI:supabase','Supabase CLI:access-token')) {
  $phase08Candidate=[Phase08CredentialRead]::Get($phase08Target)
  if($phase08Candidate -and $phase08Candidate.StartsWith('go-keyring-base64:')) {
   $phase08Candidate=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($phase08Candidate.Substring(18)))
  }
  if($phase08Candidate -match '^sbp_(oauth_)?[a-f0-9]{40}$') { $phase08Token=$phase08Candidate; break }
  $phase08Candidate=$null
 }
 if(-not $phase08Token) { throw 'PHASE08_PROTECTED_TOKEN_UNAVAILABLE' }
 $phase08Headers=@{Authorization=('Bearer '+$phase08Token)}
 if($Mode -eq 'Identity') {
  $phase08Sql="SELECT current_database() AS database_name,current_user AS database_user,(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='meta_ads_staging') AS staging_schema_count,(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='storage_renewal_ops') AS storage_renewal_schema_count,(SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_stg_backup')) AS staging_role_count"
  $phase08Response=Invoke-WebRequest -Method Post -Uri "https://api.supabase.com/v1/projects/$phase08Ref/database/query/read-only" -Headers $phase08Headers -ContentType 'application/json' -Body (@{query=$phase08Sql}|ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  $phase08Rows=if($phase08Response.StatusCode -eq 201){$phase08Response.Content|ConvertFrom-Json}else{$null}
  [ordered]@{state=if($phase08Rows){'READONLY_IDENTITY_OK'}else{'READONLY_IDENTITY_FAILED'};projectRef=$phase08Ref;httpStatus=[int]$phase08Response.StatusCode;authenticationFailure=($phase08Response.Content -match '28P01|password authentication failed');rows=$phase08Rows}|ConvertTo-Json -Depth 5
 } elseif($Mode -eq 'Services') {
  $phase08Response=Invoke-WebRequest -Uri "https://api.supabase.com/v1/projects/$phase08Ref/health?services=db,auth,rest,storage" -Headers $phase08Headers -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  $phase08Rows=if($phase08Response.StatusCode -eq 200){$phase08Response.Content|ConvertFrom-Json}else{$null}
  $phase08SafeRows=@($phase08Rows | ForEach-Object { [ordered]@{name=$_.name;healthy=$_.healthy;status=$_.status} })
  [ordered]@{state='SERVICES_READ';projectRef=$phase08Ref;httpStatus=[int]$phase08Response.StatusCode;services=$phase08SafeRows}|ConvertTo-Json -Depth 5
 } else {
  $phase08Response=Invoke-WebRequest -Uri "https://api.supabase.com/v1/projects/$phase08Ref/config/database/pooler" -Headers $phase08Headers -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  $phase08Rows=if($phase08Response.StatusCode -eq 200){$phase08Response.Content|ConvertFrom-Json}else{$null}
  $phase08SafeRows=@($phase08Rows | ForEach-Object { [ordered]@{host=$_.db_host;port=$_.db_port;database=$_.db_name;user=$_.db_user} })
  [ordered]@{state='POOLER_METADATA_READ';projectRef=$phase08Ref;httpStatus=[int]$phase08Response.StatusCode;rows=$phase08SafeRows}|ConvertTo-Json -Depth 5
 }
} catch { Write-Output '{"state":"PHASE08_READONLY_PREFLIGHT_FAILED","rawErrorSuppressed":true}'; exit 1 }
finally { $phase08Token=$null; $phase08Headers=$null; $phase08Candidate=$null; $phase08Response=$null }
