param([ValidateSet('Parse','Pure','RunNative')][string]$Mode='Parse',[string]$ExpectedControllerSha256,[string]$ExpectedToolClosureSha256,[string]$ExpectedApiSha256,[string]$ExpectedMigrationSha256)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$script:EpochEvalRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-epoch-eval-20261020-v1'
$script:EpochPrivateRoot='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime'
function Invoke-EpochProcess([string[]]$Arguments,[string]$InputText='',[int]$Timeout=60000,[bool]$Native=$false){
 $proc=$null;$text=$null;$discard=$null
 try{
  $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');foreach($arg in $Arguments){$psi.ArgumentList.Add($arg)};$psi.WorkingDirectory=(Resolve-Path "$PSScriptRoot/../../..").Path;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
  $psi.Environment.Clear();foreach($name in @('SystemRoot','PATH','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$psi.Environment[$name]=[Environment]::GetEnvironmentVariable($name)}};$psi.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json';if($Native){$psi.Environment['CAFE_EPOCH_NATIVE_PARENT']='20261020-ROOT'}
  $encoding=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$encoding;$psi.StandardOutputEncoding=$encoding;$psi.StandardErrorEncoding=$encoding
  $proc=[Diagnostics.Process]::Start($psi);$out=$proc.StandardOutput.ReadToEndAsync();$err=$proc.StandardError.ReadToEndAsync();$proc.StandardInput.Write($InputText);$proc.StandardInput.Close();$InputText=$null
  if(-not $proc.WaitForExit($Timeout)){throw 'EPOCH_CHILD_TIMEOUT'};$text=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult();$discard=$null;if([Text.Encoding]::UTF8.GetByteCount($text) -gt 1048576){throw 'PUBLIC_BOUND'};return @{exitCode=$proc.ExitCode;text=$text}
 }finally{if($proc){if(-not $proc.HasExited){$proc.Kill($true)};$proc.Dispose()};$text=$null;$discard=$null;$InputText=$null}
}
function Get-EpochMetadata{
 $code=@'
import {sourcePins,digest} from './scripts/cloud/daily-data-sync/phase10-cafe-epoch-eval-native-20261020.mjs';
import {toolPins} from './scripts/cloud/daily-data-sync/phase10-cafe-epoch-eval-20261020.mjs';
import {Prisma} from '@prisma/client';import {readFileSync} from 'node:fs';
const models=Prisma.dmmf.datamodel.models;for(const n of ['Cafe24ObservedEpochOrderRevision','Cafe24ObservedEpochDayCheckpoint'])if(!models.find(v=>v.name===n)?.fields.some(v=>v.name==='keyIdentityCommitment'))throw Error();
console.log(JSON.stringify({apiSha256:sourcePins().sha256,toolClosureSha256:digest(JSON.stringify(toolPins())),toolPins:toolPins(),migrationSha256:digest(readFileSync('apps/api/prisma/migrations/20261020160000_cafe24_observation_epochs/migration.sql')),generatedEpochModels:2}));
'@
 $r=Invoke-EpochProcess @('--import','tsx','--input-type=module','-e',$code);if($r.exitCode -ne 0){throw 'METADATA_OR_GENERATED_SCHEMA'};return ($r.text|ConvertFrom-Json -AsHashtable -Depth 20)
}
function Assert-EpochNativePins($Metadata,[string]$Controller,[string]$Tool,[string]$Api,[string]$Migration){
 foreach($value in @($Controller,$Tool,$Api,$Migration)){if($value -cnotmatch '^[a-f0-9]{64}$'){throw 'EXPECTED_PIN_REQUIRED'}}
 if((Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-20261020.ps1')).Hash.ToLowerInvariant() -cne $Controller -or $Metadata.toolClosureSha256 -cne $Tool -or $Metadata.apiSha256 -cne $Api -or $Metadata.migrationSha256 -cne $Migration){throw 'EXPECTED_PIN_MISMATCH'}
}
function Assert-EpochRoot([string]$Root){if($Root -cnotmatch '^C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-epoch-local-[a-f0-9-]{36}$'){throw 'PRIVATE_ROOT_SCOPE'}}
function New-EpochPrivate([string]$Root){
 Assert-EpochRoot $Root;if(Test-Path -LiteralPath $Root){throw 'PRIVATE_EXISTS'};[void][IO.Directory]::CreateDirectory($Root);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};Set-Acl -LiteralPath $Root -AclObject $acl;Assert-EpochPrivateAcl $Root
}
function Assert-EpochPrivateAcl([string]$Path){$item=Get-Item -LiteralPath $Path -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PRIVATE_REPARSE'};$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $Path;foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($user,'S-1-5-18')){throw 'PRIVATE_ACL'}}}
function Assert-EpochPostmaster($Lines,[string]$Root){Assert-EpochRoot $Root;if($Lines.Count -lt 6 -or $Lines[1].Replace('\','/') -cne ($Root+'/pg-data') -or $Lines[3] -cne '55436' -or $Lines[5] -cne '127.0.0.1'){throw 'OWNED_PG_IDENTITY'}}
function Stop-EpochOwnedPg([string]$Root){
 Assert-EpochRoot $Root;$pidPath=Join-Path $Root 'pg-data/postmaster.pid';if(-not (Test-Path -LiteralPath $pidPath)){return};Assert-EpochPrivateAcl $Root;Assert-EpochPostmaster (Get-Content -LiteralPath $pidPath) $Root
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');foreach($arg in @('-D',($Root+'/pg-data'),'-m','fast','-w','stop')){$psi.ArgumentList.Add($arg)};$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $p=[Diagnostics.Process]::Start($psi);try{$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();if(-not $p.WaitForExit(30000)){$p.Kill($true);throw 'OWNED_STOP_TIMEOUT'};$null=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($p.ExitCode -ne 0){throw 'OWNED_STOP_FAILED'}}finally{$p.Dispose()}
}
function Get-EpochPrivacy([string]$Root){
 Assert-EpochRoot $Root;$proof=@();foreach($leaf in @('','/pg-data','/postgres.log','/pg-data/pg_hba.conf')){$p=$Root+$leaf;Assert-EpochPrivateAcl $p;$proof+=@{path=$p;otherAllowedPrincipals=0}}
 $hba=@(Get-Content -LiteralPath ($Root+'/pg-data/pg_hba.conf')|Where-Object {$_ -notmatch '^\s*(#|$)'});if($hba.Count -lt 1 -or @($hba|Where-Object {$_ -notmatch '\s+scram-sha-256\s*$'}).Count -gt 0 -or (Test-Path -LiteralPath ($Root+'/epoch-owner-password.txt'))){throw 'AUTH_OR_TEMP_RESIDUAL'}
 return @{kind='CAFE_EPOCH_NATIVE_PRIVATE_PROOF';privateRoot=$Root;aclEvidence=$proof;allHbaScramSha256=$true;temporarySyntheticPasswordFilesCreated=1;temporaryPasswordRemaining=0;syntheticNativeDataRetained=$true;liveCustomerInputUsed=$false;rawValuesReturned=0}
}
function Write-EpochPublic($Value,[string]$Path){$f=[IO.File]::Open($Path,[IO.FileMode]::CreateNew);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 30));$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}}
function Invoke-EpochAction([string]$Action,[string]$Controller,[string]$Tool,[string]$Api,[string]$Migration){
 $stage='PARSE';$private=$null;$public=$null
 try{
  if($Action -cnotin @('Parse','Pure','RunNative')){throw 'MODE'}
  $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-20261020.ps1'),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'PS_PARSE'}
  foreach($name in @('phase10-cafe-epoch-eval-20261020.mjs','phase10-cafe-epoch-eval-native-20261020.mjs','phase10-cafe-epoch-eval-fixtures-20261020.mjs')){$r=Invoke-EpochProcess @('--check',(Join-Path $PSScriptRoot $name));if($r.exitCode -ne 0){throw 'NODE_PARSE'}}
  $metadata=Get-EpochMetadata
  if($Action -ceq 'Parse'){return @{kind='CAFE_EPOCH_PARSE_METADATA';status='PASS';metadata=$metadata;controllerSha256=(Get-FileHash -Algorithm SHA256 (Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-20261020.ps1')).Hash.ToLowerInvariant();nativeStarts=0;providerRequests=0}}
  if($Action -ceq 'Pure'){$stage='PURE';$r=Invoke-EpochProcess @('--import','tsx','--test',(Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-20261020.test.mjs'),(Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-fixtures-20261020.test.mjs')) '' 60000;[void][IO.Directory]::CreateDirectory($script:EpochEvalRoot);$path=$script:EpochEvalRoot+'/pure-'+[Guid]::NewGuid().ToString()+'.json';Write-EpochPublic @{kind='OFFLINE_PURE_OUTPUT';exitCode=$r.exitCode;output=$r.text;metadata=$metadata;nativeStarts=0;providerRequests=0} $path;return @{kind='CAFE_EPOCH_PURE';status=$(if($r.exitCode -eq 0){'PASS'}else{'FAIL'});evidencePath=$path;metadata=$metadata;nativeStarts=0;providerRequests=0}}
  $stage='EXPECTED_SOURCE_PIN';Assert-EpochNativePins $metadata $Controller $Tool $Api $Migration
  $id=[Guid]::NewGuid().ToString();$private=$script:EpochPrivateRoot+'/cafe-epoch-local-'+$id;$public=$script:EpochEvalRoot+'/attempt-'+$id
  $stage='PRIVATE_ROOT';New-EpochPrivate $private;[void][IO.Directory]::CreateDirectory($public);Write-EpochPublic @{kind='CAFE_EPOCH_ROOT_CONTROLLED_NATIVE_ATTEMPT';metadata=$metadata;controllerSha256=$Controller;nativeOnly=$true;providerRequests=0} ($public+'/attempt.json')
  $wire=@{mode='RunNative';privateRoot=$private;publicRoot=$public;expectedToolClosureSha256=$Tool;expectedApiSha256=$Api;expectedMigrationSha256=$Migration}|ConvertTo-Json -Depth 10 -Compress
  $stage='NATIVE';try{$r=Invoke-EpochProcess @('--import','tsx',(Join-Path $PSScriptRoot 'phase10-cafe-epoch-eval-20261020.mjs')) $wire 600000 $true}finally{Stop-EpochOwnedPg $private}
  $safe=$r.text|ConvertFrom-Json -AsHashtable -Depth 10;if($r.exitCode -ne 0 -or $safe.status -cne 'PASS' -or $safe.cases -lt 1 -or $safe.postgresStopExit -ne 0){throw 'NATIVE_FAILED'}
  $stage='PRIVATE_PROOF';Write-EpochPublic (Get-EpochPrivacy $private) ($public+'/privacy-proof.json');return @{kind='CAFE_EPOCH_NATIVE_HANDOFF';status='PASS';cases=$safe.cases;publicRoot=$public;privateRoot=$private;postgresStopExit=0;providerRequests=0;remoteRequests=0;rawValuesReturned=0}
 }catch{return @{kind='CAFE_EPOCH_SAFE_FAILURE';status='FAIL';stage=$stage;publicRoot=$public;privateRoot=$private;rawErrorSuppressed=$true;inspectOwnedCleanupBeforeFurtherRun=$true;automaticRetry=$false;providerRequests=0;remoteRequests=0}}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$result=Invoke-EpochAction $Mode $ExpectedControllerSha256 $ExpectedToolClosureSha256 $ExpectedApiSha256 $ExpectedMigrationSha256;$result|ConvertTo-Json -Depth 20 -Compress
if($result.status -cne 'PASS'){exit 1}
