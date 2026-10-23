# Dot-source definitions only. No credential, network, filesystem or output occurs on load.
function Get-Phase08SupabaseCredential {
  try {
    if (-not ('Phase08CredentialRead' -as [type])) {
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
    }
    foreach ($target in @('Supabase CLI:supabase','Supabase CLI:access-token')) {
      $candidate=[Phase08CredentialRead]::Get($target)
      if ($candidate -and $candidate.StartsWith('go-keyring-base64:')) {
        $candidate=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($candidate.Substring(18)))
      }
      if ($candidate -cmatch '^sbp_(oauth_)?[a-f0-9]{40}$') { return $candidate }
      $candidate=$null
    }
    throw 'unavailable'
  } catch { throw 'PHASE08_PROTECTED_TOKEN_UNAVAILABLE' }
  finally { $candidate=$null }
}

function Invoke-Phase08Management {
  param([Parameter(Mandatory)][ValidateSet('Query','ReadOnlyQuery','Health','Pooler')][string]$Action,
    [string]$Query,[ValidateRange(1,95)][int]$TimeoutSeconds=60)
  $token=$null; $headers=$null; $response=$null; $body=$null
  try {
    $token=Get-Phase08SupabaseCredential
    $headers=@{Authorization=('Bearer '+$token)}
    $base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
    $request=@{Headers=$headers;MaximumRedirection=0;TimeoutSec=$TimeoutSeconds;SkipHttpErrorCheck=$true;ErrorAction='Stop'}
    switch ($Action) {
      'Query' { $path='/database/query';$method='Post' }
      'ReadOnlyQuery' { $path='/database/query/read-only';$method='Post' }
      'Health' { $path='/health?services=db,auth,rest,storage';$method='Get' }
      'Pooler' { $path='/config/database/pooler';$method='Get' }
    }
    if ($method -eq 'Post') {
      if (-not $Query -or [Text.Encoding]::UTF8.GetByteCount($Query) -gt 1048576) { throw 'query' }
      $body=@{query=$Query}|ConvertTo-Json -Compress
      $request.Body=$body;$request.ContentType='application/json'
    } elseif ($Query) { throw 'unexpected query' }
    $response=Invoke-WebRequest @request -Uri ($base+$path) -Method $method
    if ([int]$response.StatusCode -notin @(200,201) -or [Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 2097152) { throw 'response' }
    # Result is returned only to the protected caller. Never print/serialize it for diagnostics.
    return ($response.Content|ConvertFrom-Json -DateKind String -Depth 30)
  } catch { throw ('PHASE08_MANAGEMENT_'+$Action.ToUpperInvariant()+'_FAILED') }
  finally { if ($headers) {$headers.Clear()};$headers=$null;$token=$null;$body=$null;$response=$null;$Query=$null }
}

function Assert-Phase08PrivatePath {
  param([Parameter(Mandatory)][string]$Path,[switch]$Directory)
  $item=Get-Item -LiteralPath $Path -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory.IsPresent) { throw 'PHASE08_PROTECTED_PATH_REJECTED' }
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed=@($user,'S-1-5-18');$acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected -or $acl.Owner -notin @([Security.Principal.WindowsIdentity]::GetCurrent().Name,$user,'NT AUTHORITY\SYSTEM','S-1-5-18')) { throw 'PHASE08_PROTECTED_ACL_REJECTED' }
  $found=[Collections.Generic.HashSet[string]]::new()
  foreach ($rule in $acl.Access) {
    $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -notin $allowed -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'PHASE08_PROTECTED_ACL_REJECTED' }
    [void]$found.Add($sid)
  }
  foreach ($sid in $allowed) { if (-not $found.Contains($sid)) { throw 'PHASE08_PROTECTED_ACL_REJECTED' } }
}
function Set-Phase08NewPrivateAcl {
  param([Parameter(Mandatory)][string]$Path,[switch]$Directory)
  $item=Get-Item -LiteralPath $Path -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory.IsPresent) { throw 'PHASE08_PROTECTED_PATH_REJECTED' }
  $acl=Get-Acl -LiteralPath $Path;$acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.SetOwner($user)
  foreach ($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    if ($Directory) {
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    } else { $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow) }
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-Phase08PrivatePath -Path $Path -Directory:$Directory
}
function Get-Phase08ProtectedPaths {
  $root='C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime'
  if ([Environment]::GetFolderPath('LocalApplicationData') -cne 'C:\Users\seong\AppData\Local') { throw 'PHASE08_PROTECTED_OWNER_REJECTED' }
  $local=Get-Item -LiteralPath 'C:\Users\seong\AppData\Local' -ErrorAction Stop
  if (($local.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PHASE08_PROTECTED_PATH_REJECTED' }
  return @{Root=$root;File=(Join-Path $root 'runtime-json.dpapi')}
}
function Write-Phase08ProtectedJson {
  param([Parameter(Mandatory)][object]$Value)
  $plain=$null;$encrypted=$null;$all=$null;$temp=$null
  try {
    $paths=Get-Phase08ProtectedPaths
    if (Test-Path -LiteralPath $paths.Root) { Assert-Phase08PrivatePath -Path $paths.Root -Directory }
    else { [void][IO.Directory]::CreateDirectory($paths.Root);Set-Phase08NewPrivateAcl -Path $paths.Root -Directory }
    if (Test-Path -LiteralPath $paths.File) { throw 'existing' }
    $json=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';context=$Value}|ConvertTo-Json -Depth 30 -Compress
    $plain=[Text.Encoding]::UTF8.GetBytes($json);$json=$null
    if ($plain.Length -gt 1048576) { throw 'size' }
    $entropy=[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/v1')
    $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-DPAPI-1');$all=[byte[]]::new($magic.Length+$encrypted.Length)
    [Array]::Copy($magic,0,$all,0,$magic.Length);[Array]::Copy($encrypted,0,$all,$magic.Length,$encrypted.Length)
    $temp=Join-Path $paths.Root ('.'+[Guid]::NewGuid().ToString('N')+'.dpapi')
    $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($all,0,$all.Length);$stream.Flush($true) } finally { $stream.Dispose() }
    Set-Phase08NewPrivateAcl -Path $temp
    [IO.File]::Move($temp,$paths.File);$temp=$null
    Assert-Phase08PrivatePath -Path $paths.File
  } catch { throw 'PHASE08_PROTECTED_WRITE_FAILED' }
  finally { foreach ($bytes in @($plain,$encrypted,$all)) { if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) } };if ($temp -and [IO.File]::Exists($temp)) {[IO.File]::Delete($temp)};$Value=$null }
}
function Create-Phase08ProtectedJson {
  param([Parameter(Mandatory)][object]$Value)
  Write-Phase08ProtectedJson -Value $Value
}
function Read-Phase08ProtectedJson {
  $all=$null;$encrypted=$null;$plain=$null
  try {
    $paths=Get-Phase08ProtectedPaths;Assert-Phase08PrivatePath -Path $paths.Root -Directory;Assert-Phase08PrivatePath -Path $paths.File
    $info=Get-Item -LiteralPath $paths.File
    if ($info.Length -lt 32 -or $info.Length -gt 1056768) { throw 'size' }
    $all=[IO.File]::ReadAllBytes($paths.File);$magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-DPAPI-1')
    for ($i=0;$i -lt $magic.Length;$i++) { if ($all[$i] -ne $magic[$i]) { throw 'magic' } }
    $encrypted=$all[$magic.Length..($all.Length-1)]
    $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($plain.Length -gt 1048576) { throw 'size' }
    $result=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -Depth 30
    if ($result.version -ne 1 -or $result.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $null -eq $result.context) { throw 'binding' }
    return $result.context
  } catch { throw 'PHASE08_PROTECTED_READ_FAILED' }
  finally { foreach ($bytes in @($all,$encrypted,$plain)) { if ($bytes) {[Array]::Clear($bytes,0,$bytes.Length)} } }
}
