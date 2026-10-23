param([switch]$RunNative,[string]$ExpectedControllerSha256,[string]$ExpectedModuleSha256,[string]$ExpectedFullResultSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$script:CafeLocalEvidence='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-live-input-local-20261020-v1'
$script:CafeLocalFull='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-full-read2-20261020-v1'
$script:CafeLocalPrivate='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime'
$script:CafeLocalClosure='07a2a332703b4027f891e168e9544caab22daa7b5b61526598de1de7023dc509'
function Assert-CafeLocalPrivateAcl([string]$Path){
 $item=Get-Item -LiteralPath $Path -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PRIVATE_REPARSE'}
 $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $acl=Get-Acl -LiteralPath $Path;if(-not $acl.AreAccessRulesProtected){throw 'PRIVATE_INHERITANCE'}
 foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($user,'S-1-5-18')){throw 'PRIVATE_ACL'}}
}
function New-CafeLocalPrivateRoot([string]$Path){
 if(Test-Path -LiteralPath $Path){throw 'PRIVATE_ROOT_EXISTS'};[void][IO.Directory]::CreateDirectory($Path);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};Set-Acl -LiteralPath $Path -AclObject $acl;Assert-CafeLocalPrivateAcl $Path
}
function Read-CafeLocalPrivate([string]$Name){
 if($Name -cnotmatch '^cafe08-normalized-day-20261020-cafe08-full-read-b-2026-10-(16|17)$'){throw 'PRIVATE_REF_SCOPE'}
 $directory=Join-Path $script:CafeLocalPrivate 'incident-20261019';$path=Join-Path $directory ($Name+'.dpapi');Assert-CafeLocalPrivateAcl $directory;Assert-CafeLocalPrivateAcl $path
 $sealed=$null;$plain=$null
 try{$info=Get-Item -LiteralPath $path;if($info.Length -lt 32 -or $info.Length -gt 4194304){throw 'PRIVATE_BOUND'};$sealed=[IO.File]::ReadAllBytes($path);$plain=[Security.Cryptography.ProtectedData]::Unprotect($sealed,[Text.Encoding]::ASCII.GetBytes('MetaAdsIncident20261019/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);return ([Text.UTF8Encoding]::new($false,$true).GetString($plain)|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String)}finally{if($sealed){[Array]::Clear($sealed)};if($plain){[Array]::Clear($plain)}}
}
function Read-CafeLocalPublic([string]$Name){
 if($Name -cnotmatch '^(result|prepared|day-2026-10-(16|17)|preserved-2026-10-(16|17))$'){throw 'PUBLIC_REF_SCOPE'}
 $path=Join-Path $script:CafeLocalFull ($Name+'.json');$info=Get-Item -LiteralPath $path;if($info.Length -gt 1048576){throw 'PUBLIC_BOUND'};return (Get-Content -LiteralPath $path -Raw|ConvertFrom-Json -AsHashtable -Depth 40 -DateKind String)
}
function ConvertTo-CafeLocalCanonical($Value){
 if($Value -is [Collections.IDictionary]){$result=[ordered]@{};foreach($key in @($Value.Keys|Sort-Object)){$result[$key]=ConvertTo-CafeLocalCanonical $Value[$key]};return $result}
 if($Value -is [Collections.IList]){$items=@();foreach($item in $Value){$items+=,(ConvertTo-CafeLocalCanonical $item)};return ,$items};return $Value
}
function Get-CafeLocalCanonicalJson($Value){return (ConvertTo-CafeLocalCanonical $Value|ConvertTo-Json -Depth 40 -Compress)}
function Get-CafeLocalInput([string]$ExpectedFullSha){
 if($ExpectedFullSha -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 (Join-Path $script:CafeLocalFull 'result.json')).Hash.ToLowerInvariant() -cne $ExpectedFullSha){throw 'FULL_RESULT_PIN'}
 $result=Read-CafeLocalPublic result;$prepared=Read-CafeLocalPublic prepared
 if($result.kind -cne 'CAFE08_FULL_READ_RESULT' -or $result.status -cne 'TWO_COMPLETED_DAYS_CURRENT_READ_PASS' -or $result.dayResults.Count -ne 2 -or $result.whole68Unchanged -cne $true -or $result.holdsAndEnvironmentUnchanged -cne $true){throw 'FULL_TWO_DAY_PROOF'}
 if($prepared.sourcePins.candidateV5AppSourceFileCount -ne 285 -or $prepared.sourcePins.candidateV5AppSourceClosureSha256 -cne $script:CafeLocalClosure){throw 'SOURCE_CLOSURE'}
 foreach($name in $prepared.sourcePins.Keys){if($name -cmatch '^phase10-[a-z0-9.-]+\.(ps1|mjs)$' -and (Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot $name)).Hash.ToLowerInvariant() -cne $prepared.sourcePins[$name]){throw 'FULL_SOURCE_PIN'}}
 $days=@();foreach($day in @('2026-10-16','2026-10-17')){
  $proof=Read-CafeLocalPublic ('day-'+$day)
  if($proof.kind -cne 'CAFE08_FULL_CURRENT_DAY_READ' -or $proof.status -cne 'COMPLETE_CURRENT_TWO_PASS_READ' -or $proof.day -cne $day -or $proof.completeTwoPass -cne $true -or $proof.privatePayloadSealedAndReadbackVerified -cne $true -or $proof.eligibleSecretRollback -cne $false -or $proof.privateNormalizedReference -cne ('cafe08-normalized-day-20261020-cafe08-full-read-b-'+$day) -or $proof.lineCount -ne $proof.uniqueLineCount){throw 'DAY_PROOF'}
  $matching=@($result.dayResults|Where-Object {$_.day -ceq $day});if($matching.Count -ne 1 -or (Get-CafeLocalCanonicalJson $matching[0]) -cne (Get-CafeLocalCanonicalJson $proof)){throw 'DAY_FULL_RESULT_BINDING'}
  $preserved=Read-CafeLocalPublic ('preserved-'+$day);if($preserved.kind -cne 'CAFE08_FULL_DAY_PRESERVATION' -or $preserved.day -cne $day -or $preserved.whole68Unchanged -cne $true -or $preserved.holdsAndEnvironmentUnchanged -cne $true){throw 'DAY_PRESERVATION_PROOF'}
  $envelope=Read-CafeLocalPrivate $proof.privateNormalizedReference
  $days+=@{envelope=$envelope;proof=@{day=$day;completeTwoPass=$proof.completeTwoPass;normalizedPayloadSha256=$proof.normalizedPayloadSha256;normalizedPayloadBytes=$proof.normalizedPayloadBytes;orderCount=$proof.orderCount;lineCount=$proof.lineCount;pageCount=$proof.pageCount;fetchedAt=$proof.fetchedAt;sourcePins=$prepared.sourcePins}}
 }
 return @{kind='CAFE08_LOCAL_LIVE_INPUT_V1';sourceClosureSha256=$script:CafeLocalClosure;days=$days}
}
function Get-CafeLocalNativePrivacy([string]$Root){
 if($Root -cnotmatch '^C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-live-local-[a-f0-9-]{36}$'){throw 'PRIVATE_ROOT_SCOPE'}
 $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$paths=@($Root,($Root+'/pg-data'),($Root+'/postgres.log'),($Root+'/pg-data/pg_hba.conf'));$evidence=@()
 foreach($path in $paths){$item=Get-Item -LiteralPath $path -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PRIVATE_REPARSE'};$acl=Get-Acl -LiteralPath $path;$others=@($acl.Access|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($user,'S-1-5-18')});if($others.Count -ne 0){throw 'PRIVATE_NATIVE_ACL'};$evidence+=@{path=$path;otherAllowedPrincipals=0}}
 $hba=@(Get-Content -LiteralPath ($Root+'/pg-data/pg_hba.conf')|Where-Object {$_ -notmatch '^\s*(#|$)'});if($hba.Count -lt 1 -or @($hba|Where-Object {$_ -notmatch '\s+scram-sha-256\s*$'}).Count -gt 0 -or (Test-Path -LiteralPath ($Root+'/initdb-owner-password.txt'))){throw 'PRIVATE_NATIVE_AUTH_OR_PASSWORD_RESIDUAL'}
 return @{kind='CAFE08_LOCAL_NATIVE_PRIVATE_RETENTION';privateNativeRoot=$Root;aclEvidence=$evidence;normalizedInputRetention='CURRENTUSER_DPAPI_PLUS_USER_SYSTEM_ACL_NATIVE_PG';plaintextSnapshotJsonCreated=$false;temporaryRandomLocalPasswordFileCreated=1;temporaryPasswordFileRemaining=0;allHbaAuthenticationScramSha256=$true;nativeDataAndLogRetained=$true;rawValuesReturned=0}
}
function Write-CafeLocalPrivacy($Value,[string]$PublicRoot){$stream=[IO.File]::Open(($PublicRoot+'/privacy-proof.json'),[IO.FileMode]::CreateNew);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 10));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}}
function Assert-CafeLocalPostmasterIdentity($Lines,[string]$Root){if($Lines.Count -lt 6 -or $Lines[1].Replace('\','/') -cne ($Root+'/pg-data') -or $Lines[3] -cne '55436' -or $Lines[5] -cne '127.0.0.1'){throw 'OWNED_PG_IDENTITY'}}
function Stop-CafeLocalOwnedNative([string]$Root){
 if($Root -cnotmatch '^C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-live-local-[a-f0-9-]{36}$'){throw 'NATIVE_STOP_SCOPE'}
 $pidFile=Join-Path $Root 'pg-data/postmaster.pid';if(-not (Test-Path -LiteralPath $pidFile)){return}
 Assert-CafeLocalPrivateAcl $Root;$lines=Get-Content -LiteralPath $pidFile
 Assert-CafeLocalPostmasterIdentity $lines $Root
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');foreach($arg in @('-D',($Root+'/pg-data'),'-m','fast','-w','stop')){$psi.ArgumentList.Add($arg)};$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $proc=[Diagnostics.Process]::Start($psi);try{$out=$proc.StandardOutput.ReadToEndAsync();$err=$proc.StandardError.ReadToEndAsync();if(-not $proc.WaitForExit(30000)){$proc.Kill($true);throw 'OWNED_PG_STOP_TIMEOUT'};$null=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($proc.ExitCode -ne 0){throw 'OWNED_PG_STOP_FAILED'}}finally{$proc.Dispose()}
}
function Invoke-CafeLocalChild($InputValue,[string]$PrivateRoot,[string]$PublicRoot){
 $child=$null;$wire=$null;$raw=$null;$discard=$null
 try{
  $wire=@{input=$InputValue;privateRoot=$PrivateRoot;publicRoot=$PublicRoot}|ConvertTo-Json -Depth 45 -Compress;if([Text.Encoding]::UTF8.GetByteCount($wire) -gt 8388608){throw 'WIRE_BOUND'}
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');foreach($arg in @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-live-input-local-20261020.mjs'))){$psi.ArgumentList.Add($arg)};$psi.WorkingDirectory=(Resolve-Path "$PSScriptRoot/../../..").Path;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$psi.Environment['CAFE_LIVE_LOCAL_PARENT']='20261020-ROOT';$psi.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json'
  $encoding=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$encoding;$psi.StandardOutputEncoding=$encoding;$psi.StandardErrorEncoding=$encoding
  $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
  if(-not $child.WaitForExit(300000)){throw 'NATIVE_CHILD_TIMEOUT'};$raw=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null
  if([Text.Encoding]::UTF8.GetByteCount($raw) -gt 32768){throw 'PUBLIC_CHILD_BOUND'};$safe=$raw|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String
  if($child.ExitCode -ne 0 -or $safe.status -cne 'PASS' -or $safe.days.Count -ne 2 -or $safe.postgresStopExit -ne 0 -or $safe.rawValuesReturned -ne 0){throw 'LOCAL_RESULT_FAILED'};return $safe
 }finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};Stop-CafeLocalOwnedNative $PrivateRoot;$wire=$null;$raw=$null;$discard=$null;$InputValue=$null}
}
function Invoke-CafeLocalAction([bool]$Execute,[string]$ControllerSha,[string]$ModuleSha,[string]$FullSha){
 $stage='LOCAL_SOURCE_PIN';$inputValue=$null;$privateRoot=$null;$publicRoot=$null
 try{
  if(-not $Execute -or $ControllerSha -cnotmatch '^[a-f0-9]{64}$' -or $ModuleSha -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'phase10-cafe-live-input-local-20261020.ps1')).Hash.ToLowerInvariant() -cne $ControllerSha -or (Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'phase10-cafe-live-input-local-20261020.mjs')).Hash.ToLowerInvariant() -cne $ModuleSha){throw 'EXPLICIT_LOCAL_EXECUTION_AND_PIN_REQUIRED'}
  $stage='FULL_PROOF_AND_PRIVATE_NORMALIZED_INPUT';$inputValue=Get-CafeLocalInput $FullSha
  $id=[Guid]::NewGuid().ToString();$privateRoot=$script:CafeLocalPrivate+'/cafe-live-local-'+$id;$publicRoot=$script:CafeLocalEvidence+'/attempt-'+$id
  $stage='PRIVATE_NATIVE_ROOT';New-CafeLocalPrivateRoot $privateRoot
  $stage='LOCAL_NATIVE_WRITER';$safe=Invoke-CafeLocalChild $inputValue $privateRoot $publicRoot
  $stage='PRIVATE_RETENTION_ACL_PROOF';$privacy=Get-CafeLocalNativePrivacy $privateRoot;Write-CafeLocalPrivacy $privacy $publicRoot
  return @{kind='CAFE08_LOCAL_LIVE_WRITER_HANDOFF';status='PASS';resultPath=($publicRoot+'/result.json');privacyProofPath=($publicRoot+'/privacy-proof.json');privateNativeDataRetained=$true;privateNativeRoot=$privateRoot;remoteRequests=0;providerRequests=0;rawValuesReturned=0;observationHistoryRebaselineProven=$false}
 }catch{return @{kind='CAFE08_LOCAL_LIVE_WRITER_SAFE_FAILURE';status='FAIL';stage=$stage;privateNativeRoot=$privateRoot;publicRoot=$publicRoot;inspectOwnedNativeCleanupBeforeFurtherRun=$true;rawErrorSuppressed=$true;rawValuesReturned=0;automaticRetry=$false;providerRequests=0;remoteRequests=0}}
 finally{$inputValue=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$public=Invoke-CafeLocalAction ([bool]$RunNative) $ExpectedControllerSha256 $ExpectedModuleSha256 $ExpectedFullResultSha256;$public|ConvertTo-Json -Depth 20 -Compress
if($public.status -cne 'PASS'){exit 1}
