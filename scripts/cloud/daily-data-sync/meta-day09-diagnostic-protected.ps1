# Definitions only; independent diagnostic capture key, never a runtime key.
. "$PSScriptRoot/protected-context.ps1"
function Get-Phase08MetaDay09DiagnosticDirectory {
 $paths=Get-Phase08ProtectedPaths;Assert-Phase08PrivatePath -Path $paths.Root -Directory
 return (Join-Path $paths.Root 'meta-diagnostic-20261015-day09')
}
function Read-Phase08MetaDay09DiagnosticKey {
 $plain=$null;$cipher=$null
 try {
  $dir=Get-Phase08MetaDay09DiagnosticDirectory;Assert-Phase08PrivatePath -Path $dir -Directory
  $path=Join-Path $dir 'capture-key.dpapi';Assert-Phase08PrivatePath -Path $path
  if((Get-Item -LiteralPath $path).Length -gt 8192){throw 'size'}
  $cipher=[IO.File]::ReadAllBytes($path)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::ASCII.GetBytes('Phase08MetaDiagnostic/20261015/day09/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $value=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json
  if($value.version -ne 1 -or $value.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $value.day -cne '2026-10-09' -or $value.keyB64 -cnotmatch '^[A-Za-z0-9+/]{43}=$'){throw 'binding'}
  return $value.keyB64
 }finally{foreach($bytes in @($plain,$cipher)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$value=$null}
}
function New-Phase08MetaDay09DiagnosticKey {
 $random=$null;$plain=$null;$cipher=$null;$encoded=$null
 try {
  $dir=Get-Phase08MetaDay09DiagnosticDirectory
  if(Test-Path -LiteralPath $dir){throw 'existing-directory'}
  $null=[IO.Directory]::CreateDirectory($dir);Set-Phase08NewPrivateAcl -Path $dir -Directory
  $random=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($random);$encoded=[Convert]::ToBase64String($random)
  $json=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';day='2026-10-09';keyB64=$encoded}|ConvertTo-Json -Compress
  $plain=[Text.Encoding]::UTF8.GetBytes($json);$json=$null
  $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('Phase08MetaDiagnostic/20261015/day09/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $path=Join-Path $dir 'capture-key.dpapi';$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($cipher,0,$cipher.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  Set-Phase08NewPrivateAcl -Path $path
  $verified=Read-Phase08MetaDay09DiagnosticKey;if($verified -cne $encoded){throw 'roundtrip'};$verified=$null
  return @{state='PHASE08_META_DIAGNOSTIC_KEY_PREPARED';independentKey=$true;dpapiRoundtrip=$true;plainFiles=0;runtimeChanges=0}
 }finally{foreach($bytes in @($random,$plain,$cipher)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$encoded=$null}
}
