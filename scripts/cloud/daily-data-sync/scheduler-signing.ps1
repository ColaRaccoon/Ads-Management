# Definitions only. Never print private material or raw child diagnostics.
. "$PSScriptRoot/protected-context.ps1"
function Invoke-Phase08SchedulerCrypto($InputValue) {
 $child=$null;$raw=$null;$json=$null
 try {
  $json=$InputValue|ConvertTo-Json -Depth 25 -Compress
  if([Text.Encoding]::UTF8.GetByteCount($json) -gt 16384){throw 'input'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe')
  $psi.ArgumentList.Add((Join-Path $PSScriptRoot 'scheduler-evidence-crypto.mjs'))
  $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.Environment.Clear()
  $psi.Environment['SystemRoot']=$env:SystemRoot;$psi.Environment['PHASE08_PROTECTED_PARENT']='SCHEDULER_SIGNING_V1'
  $psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $utf8=[Text.UTF8Encoding]::new($false,$true)
  $psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
  $child=[Diagnostics.Process]::Start($psi)
  $outTask=$child.StandardOutput.ReadToEndAsync();$errTask=$child.StandardError.ReadToEndAsync()
  $write=$child.StandardInput.WriteAsync($json)
  if(-not $write.Wait(5000)){$child.Kill($true);throw 'write'}
  $child.StandardInput.Close();$json=$null
  if(-not $child.WaitForExit(10000)){$child.Kill($true);throw 'timeout'}
  $raw=$outTask.GetAwaiter().GetResult();$discard=$errTask.GetAwaiter().GetResult();$discard=$null
  if($child.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($raw) -gt 32768){throw 'child'}
  return ($raw|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25)
 } catch {throw 'PHASE08_SCHEDULER_CRYPTO_UNAVAILABLE'}
 finally {if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$raw=$null;$json=$null;$InputValue=$null}
}
function Get-Phase08SchedulerSigningPath {
 return 'C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime\scheduler-signing-key.dpapi'
}
function New-Phase08SchedulerSigningKey {
 $path=Get-Phase08SchedulerSigningPath;$root=[IO.Path]::GetDirectoryName($path)
 Assert-Phase08PrivatePath -Path $root -Directory
 if(Test-Path -LiteralPath $path){throw 'PHASE08_SCHEDULER_KEY_EXISTS_INSPECT'}
 $material=$null;$plain=$null;$encrypted=$null;$all=$null;$temporary=$null;$file=$null
 try {
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $material=Invoke-Phase08SchedulerCrypto @{action='generate'}
  if($material.version -ne 1 -or $material.publicKeyB64 -isnot [string] -or $material.publicKeyB64.Length -ne 60 -or
     $material.privateKeyB64 -isnot [string] -or $material.privateKeyB64.Length -ne 64){throw 'material'}
  $plain=[Text.Encoding]::UTF8.GetBytes(($material|ConvertTo-Json -Compress))
  $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/SchedulerSigning/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-SCHEDULER-SIGNING-1');$all=[byte[]]::new($magic.Length+$encrypted.Length)
  [Array]::Copy($magic,0,$all,0,$magic.Length);[Array]::Copy($encrypted,0,$all,$magic.Length,$encrypted.Length)
  $temporary=Join-Path $root ('scheduler-key-'+[Guid]::NewGuid()+'.dpapi.tmp')
  $file=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $file.Write($all,0,$all.Length);$file.Dispose();$file=$null
  Set-Phase08NewPrivateAcl -Path $temporary;Assert-Phase08PrivatePath -Path $temporary
  if(Test-Path -LiteralPath $path){throw 'no-overwrite'}
  [IO.File]::Move($temporary,$path,$false);$temporary=$null
  Assert-Phase08PrivatePath -Path $path
  $roundtrip=Read-Phase08SchedulerSigningKey
  if($roundtrip.publicKeyB64 -cne $material.publicKeyB64 -or $roundtrip.privateKeyB64 -cne $material.privateKeyB64){throw 'roundtrip'}
  return @{state='PHASE08_SCHEDULER_SIGNING_KEY_PROTECTED';publicKeyB64=$material.publicKeyB64;protectedFile=$path;privateValuesReturned=0;remoteWrites=0}
 } catch {throw 'PHASE08_SCHEDULER_KEY_PREPARATION_FAILED'}
 finally {
  if($file){$file.Dispose()}
  if($temporary -and [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($temporary)) -ceq $root -and (Test-Path -LiteralPath $temporary)){Remove-Item -LiteralPath $temporary -Force}
  foreach($bytes in @($plain,$encrypted,$all)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$material=$null;$roundtrip=$null
 }
}
function Read-Phase08SchedulerSigningKey {
 $path=Get-Phase08SchedulerSigningPath
 Assert-Phase08PrivatePath -Path ([IO.Path]::GetDirectoryName($path)) -Directory
 Assert-Phase08PrivatePath -Path $path
 $all=$null;$encrypted=$null;$plain=$null
 try {
  Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
  $all=[IO.File]::ReadAllBytes($path)
  if($all.Length -lt 32 -or $all.Length -gt 4096){throw 'size'}
  $magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-SCHEDULER-SIGNING-1')
  for($i=0;$i -lt $magic.Length;$i++){if($all[$i] -ne $magic[$i]){throw 'magic'}}
  $encrypted=$all[$magic.Length..($all.Length-1)]
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/SchedulerSigning/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $value=[Text.UTF8Encoding]::new($false,$true).GetString($plain)|ConvertFrom-Json -AsHashtable -DateKind String
  if($value.Count -ne 3 -or $value.version -ne 1 -or $value.publicKeyB64 -isnot [string] -or $value.publicKeyB64.Length -ne 60 -or
     $value.privateKeyB64 -isnot [string] -or $value.privateKeyB64.Length -ne 64){throw 'shape'}
  return $value
 } catch {throw 'PHASE08_SCHEDULER_KEY_UNAVAILABLE'}
 finally {foreach($bytes in @($all,$encrypted,$plain)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$value=$null}
}
function Sign-Phase08SchedulerEvidence($Payload) {
 $material=$null
 try {$material=Read-Phase08SchedulerSigningKey;return (Invoke-Phase08SchedulerCrypto @{action='sign';material=$material;payload=$Payload})}
 finally {$material=$null;$Payload=$null}
}
