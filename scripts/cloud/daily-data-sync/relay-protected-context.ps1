# Definitions only. Password stays in protected memory/DPAPI; no HTTP or output on load.
. "$PSScriptRoot/protected-context.ps1"
function Get-Phase08RelayProtectedPath {
 $paths=Get-Phase08ProtectedPaths
 Assert-Phase08PrivatePath -Path $paths.Root -Directory
 return (Join-Path $paths.Root 'relay-password.dpapi')
}
function Write-Phase08RelayProtectedPassword {
 $plain=$null;$cipher=$null;$random=$null;$password=$null;$temp=$null
 try {
  $path=Get-Phase08RelayProtectedPath
  if(Test-Path -LiteralPath $path){throw 'existing'}
  $random=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($random)
  $password=[Convert]::ToBase64String($random)
  $json=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';password=$password;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress
  $plain=[Text.Encoding]::UTF8.GetBytes($json);$json=$null
  $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08Relay/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $temp=Join-Path (Split-Path $path) ('.relay-'+[Guid]::NewGuid().ToString('N')+'.dpapi')
  $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($cipher,0,$cipher.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  Set-Phase08NewPrivateAcl -Path $temp
  [IO.File]::Move($temp,$path);$temp=$null
  Assert-Phase08PrivatePath -Path $path
  $readback=Read-Phase08RelayProtectedPassword
  if($readback -cne $password){throw 'roundtrip'}
 }catch{throw 'PHASE08_RELAY_DPAPI_CREATE_FAILED_INSPECT_BEFORE_RETRY'}
 finally{
  if($temp -and [IO.File]::Exists($temp)){
   try{
    $ownRoot=Split-Path (Get-Phase08RelayProtectedPath)
    $item=Get-Item -LiteralPath $temp -ErrorAction Stop
    if($item.DirectoryName -ceq $ownRoot -and $item.Name -cmatch '^\.relay-[a-f0-9]{32}\.dpapi$' -and -not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){Remove-Item -LiteralPath $item.FullName -Force -ErrorAction Stop}
   }catch{}
  }
  foreach($bytes in @($random,$plain,$cipher)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$password=$null;$readback=$null;$json=$null
 }
}
function Read-Phase08RelayProtectedPassword {
 $cipher=$null;$plain=$null;$decoded=$null;$data=$null;$json=$null
 try {
  $path=Get-Phase08RelayProtectedPath;Assert-Phase08PrivatePath -Path $path
  $file=Get-Item -LiteralPath $path
  if($file.Length -lt 1 -or $file.Length -gt 16384){throw 'size'}
  $cipher=[IO.File]::ReadAllBytes($path)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08Relay/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  if($plain.Length -gt 8192){throw 'size'}
  $json=[Text.UTF8Encoding]::new($false,$true).GetString($plain)
  $data=$json|ConvertFrom-Json -AsHashtable -DateKind String -Depth 5
  if($data.Count -ne 4 -or $data.version -ne 1 -or $data.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $data.password -isnot [string] -or $data.password -cnotmatch '^[A-Za-z0-9+/]{43}=$' -or $data.createdAt -isnot [string]){throw 'identity'}
  $decoded=[Convert]::FromBase64String($data.password)
  if($decoded.Length -ne 32 -or [Convert]::ToBase64String($decoded) -cne $data.password){throw 'format'}
  return $data.password
 }catch{throw 'PHASE08_RELAY_DPAPI_READ_FAILED'}
 finally{foreach($bytes in @($cipher,$plain,$decoded)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$data=$null;$json=$null}
}
