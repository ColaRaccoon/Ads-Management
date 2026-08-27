#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply','Rollback','Verify')][string]$Action='Plan',
  [string]$Hostname,
  [string]$CertificateRoot,
  [string]$NodePath,
  [string]$ExpectedNodeSha256,
  [string]$VerifierScriptPath,
  [string]$ExpectedVerifierScriptSha256,
  [string]$FileSystemEvidencePath,
  [string]$ExpectedFileSystemEvidenceSha256,
  [string]$ExpectedFilesystemDescriptorDigest,
  [string]$OfflineCaPfxPath,
  [string]$OfflineCaPasswordEscrowPath,
  [ValidateSet('Apply','Rollback')][string]$PlannedAction,[string]$ApprovedPlanSha256,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
if($PSVersionTable.PSVersion.Major-lt7){throw 'POWERSHELL_7_REQUIRED_FOR_PKCS8_EXPORT'}
function Assert-NoReparseAncestors([string]$Path){$cursor=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force;while($cursor){if($cursor.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'CERTIFICATE_PATH_REPARSE_REJECTED'};$cursor=$cursor.Parent}}
function Assert-SafeExistingRoot([string]$Value){
  if(-not[IO.Path]::IsPathFullyQualified($Value)){throw 'CERTIFICATE_ROOT_MUST_BE_ABSOLUTE'}
  $root=[IO.Path]::GetFullPath($Value).TrimEnd('\');if($root-eq[IO.Path]::GetPathRoot($root)-or-not(Test-Path -LiteralPath $root -PathType Container)){throw 'CERTIFICATE_ROOT_INVALID'}
  Assert-NoReparseAncestors $root
  return$root
}
function Write-Pem([string]$Label,[byte[]]$Bytes,[string]$Path){$body=[Convert]::ToBase64String($Bytes,[Base64FormattingOptions]::InsertLineBreaks);[IO.File]::WriteAllText($Path,"-----BEGIN $Label-----`r`n$body`r`n-----END $Label-----`r`n",[Text.Encoding]::ASCII)}
function Under([string]$Path,[string[]]$Roots){$full=[IO.Path]::GetFullPath($Path);return@($Roots|Where-Object{$root=[IO.Path]::GetFullPath([string]$_).TrimEnd('\');$full-ieq$root-or$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)}).Count-gt0}
function Hash([string]$Path){return(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Assert-Pinned([string]$Path,[string]$Expected,[string]$Code){if(-not(Test-Path -LiteralPath $Path -PathType Leaf)-or$Expected-notmatch'^[A-Fa-f0-9]{64}$'-or(Hash $Path)-cne$Expected.ToLowerInvariant()){throw$Code};Assert-NoReparseAncestors $Path}
function Assert-AdminOnlyRoot([string]$Path){$root=Split-Path -Parent ([IO.Path]::GetFullPath($Path));if(-not(Test-Path -LiteralPath $root -PathType Container)-or(Get-Volume -FilePath $root).FileSystem-ne'NTFS'){throw 'OFFLINE_CA_ROOT_INVALID'};Assert-NoReparseAncestors $root;$acl=Get-Acl -LiteralPath $root;if(-not$acl.AreAccessRulesProtected-or$acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value-notin@('S-1-5-18','S-1-5-32-544')){throw 'OFFLINE_CA_ROOT_ACL_INVALID'};foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($sid-notin@('S-1-5-18','S-1-5-32-544')-or$rule.AccessControlType-ne'Allow'-or$rule.FileSystemRights-ne[Security.AccessControl.FileSystemRights]::FullControl){throw 'OFFLINE_CA_ROOT_ACL_INVALID'}}}
function Protect-AdminOnlyFile([string]$Path){$security=New-Object Security.AccessControl.FileSecurity;$admin=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$security.SetOwner($admin);$security.SetAccessRuleProtection($true,$false);foreach($sid in @('S-1-5-18','S-1-5-32-544')){$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$security.AddAccessRule($rule)|Out-Null};Set-Acl -LiteralPath $Path -AclObject $security}
function Cleanup-Generated([string]$Root){$targets=@('internal-ca.cer','server.cer','server.pem','server-key.pem','certificate-manifest.json'|ForEach-Object{Join-Path $Root $_})+@($OfflineCaPfxPath,$OfflineCaPasswordEscrowPath);foreach($target in $targets){if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Force -ErrorAction Stop}};if(@($targets|Where-Object{Test-Path -LiteralPath $_}).Count-ne0){throw'CERTIFICATE_PARTIAL_CLEANUP_FAILED'}}
function New-InternalCaApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Apply','Rollback')){throw'PLANNED_ACTION_REQUIRED'}
  if($Hostname-notmatch'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'){throw'CA_PLAN_HOSTNAME_REQUIRED'}
  $parameters=[ordered]@{hostname=$Hostname;certificateRoot=(Get-ApprovalPath $CertificateRoot 'CA_PLAN_CERTIFICATE_ROOT_REQUIRED');offlineCaPfxPath=(Get-ApprovalPath $OfflineCaPfxPath 'CA_PLAN_PFX_PATH_REQUIRED');offlineCaPasswordEscrowPath=(Get-ApprovalPath $OfflineCaPasswordEscrowPath 'CA_PLAN_ESCROW_PATH_REQUIRED');nodePath=(Get-ApprovalPath $NodePath 'CA_PLAN_NODE_PATH_REQUIRED');nodeSha256=(Get-ApprovalHash $ExpectedNodeSha256 'CA_PLAN_NODE_HASH_REQUIRED');verifierScriptPath=(Get-ApprovalPath $VerifierScriptPath 'CA_PLAN_VERIFIER_PATH_REQUIRED');verifierScriptSha256=(Get-ApprovalHash $ExpectedVerifierScriptSha256 'CA_PLAN_VERIFIER_HASH_REQUIRED');filesystemEvidencePath=(Get-ApprovalPath $FileSystemEvidencePath 'CA_PLAN_FILESYSTEM_EVIDENCE_PATH_REQUIRED');filesystemEvidenceSha256=(Get-ApprovalHash $ExpectedFileSystemEvidenceSha256 'CA_PLAN_FILESYSTEM_EVIDENCE_HASH_REQUIRED');filesystemDescriptorDigest=(Get-ApprovalHash $ExpectedFilesystemDescriptorDigest 'CA_PLAN_FILESYSTEM_DESCRIPTOR_REQUIRED')}
  $target="Exact internal CA/server certificate artifacts for hostname $Hostname under $($parameters.certificateRoot), with offline CA escrow at $($parameters.offlineCaPfxPath)"
  $impact=if($IntendedAction-eq'Apply'){'Creates one internal CA and exact-host server certificate, exports the encrypted CA key to the admin-only path, and removes transient online private keys'}else{'Removes only the exact generated certificate and offline escrow artifacts; client trust is not changed'}
  $rollback=if($IntendedAction-eq'Apply'){'Before client trust installation, remove only the exact generated artifacts using a separately approved Rollback plan'}else{'Generate a replacement only through a new approved Apply plan; removed private material is not recoverable from this action'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}
if($Action-eq'Plan'){
  New-InternalCaApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0
}
$caMutation=if($Action-in@('Apply','Rollback')){$Action}else{$null};if($caMutation){Assert-ApprovedPlan (New-InternalCaApprovalPlan $caMutation) ([bool]$Approved) $ApprovedPlanSha256}
$root=Assert-SafeExistingRoot $CertificateRoot;$manifestPath=Join-Path $root 'certificate-manifest.json'
Assert-Pinned $FileSystemEvidencePath $ExpectedFileSystemEvidenceSha256 'FILESYSTEM_EVIDENCE_HASH_MISMATCH';$fs=Get-Content -Raw -LiteralPath $FileSystemEvidencePath|ConvertFrom-Json
if($fs.result-ne'PASS'-or$fs.descriptorDigest-cne$ExpectedFilesystemDescriptorDigest-or$ExpectedFilesystemDescriptorDigest-notmatch'^[0-9a-f]{64}$'-or-not(Under $root $fs.classRoots.EDGE_READ)-or-not(Under $OfflineCaPfxPath $fs.classRoots.ADMIN_ONLY)-or-not(Under $OfflineCaPasswordEscrowPath $fs.classRoots.ADMIN_ONLY)){throw 'CERTIFICATE_ROOT_ACL_EVIDENCE_REJECTED'}
Assert-AdminOnlyRoot $OfflineCaPfxPath
Assert-AdminOnlyRoot $OfflineCaPasswordEscrowPath
if($Action-eq'Apply'){
  if($Hostname-notmatch'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'){throw 'HOSTNAME_REQUIRED'}
  $names=@('internal-ca.cer','server.cer','server.pem','server-key.pem','certificate-manifest.json');if(($names|Where-Object{Test-Path -LiteralPath(Join-Path $root $_)})-or(Test-Path -LiteralPath $OfflineCaPfxPath)-or(Test-Path -LiteralPath $OfflineCaPasswordEscrowPath)){throw 'CERTIFICATE_TARGET_NOT_EMPTY'}
  $ca=$null;$server=$null;$completed=$false;$passwordBytes=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes);$passwordText=[Convert]::ToBase64String($passwordBytes).TrimEnd('=').Replace('+','-').Replace('/','_');[Array]::Clear($passwordBytes,0,$passwordBytes.Length);$offlineCaExportPassword=ConvertTo-SecureString $passwordText -AsPlainText -Force
  try{
    $ca=New-SelfSignedCertificate -Type Custom -Subject 'CN=Meta Ads Performance Internal CA' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign,DigitalSignature -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0','2.5.29.15={critical}{text}keyCertSign,cRLSign')
    $server=New-SelfSignedCertificate -Type Custom -Subject "CN=$Hostname" -DnsName $Hostname -Signer $ca -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(397) -TextExtension @('2.5.29.19={critical}{text}ca=0','2.5.29.37={critical}{text}1.3.6.1.5.5.7.3.1')
    Export-Certificate -Cert $ca -FilePath(Join-Path $root 'internal-ca.cer') -Type CERT|Out-Null
    Export-Certificate -Cert $server -FilePath(Join-Path $root 'server.cer') -Type CERT|Out-Null
    Export-PfxCertificate -Cert $ca -FilePath $OfflineCaPfxPath -Password $offlineCaExportPassword -CryptoAlgorithmOption AES256_SHA256|Out-Null
    [IO.File]::WriteAllText($OfflineCaPasswordEscrowPath,$passwordText,(New-Object Text.UTF8Encoding($false)))
    Protect-AdminOnlyFile $OfflineCaPfxPath;Protect-AdminOnlyFile $OfflineCaPasswordEscrowPath
    Write-Pem 'CERTIFICATE' ($server.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)) (Join-Path $root 'server.pem')
    $rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($server);try{Write-Pem 'PRIVATE KEY' ($rsa.ExportPkcs8PrivateKey()) (Join-Path $root 'server-key.pem')}finally{$rsa.Dispose()}
    $manifest=[ordered]@{version=3;hostname=$Hostname;caThumbprint=$ca.Thumbprint;serverThumbprint=$server.Thumbprint;caPrivateKeyRetainedOffline=$true;caNotBefore=$ca.NotBefore.ToUniversalTime().ToString('o');caNotAfter=$ca.NotAfter.ToUniversalTime().ToString('o');serverNotBefore=$server.NotBefore.ToUniversalTime().ToString('o');serverNotAfter=$server.NotAfter.ToUniversalTime().ToString('o');renewAfter=$server.NotAfter.ToUniversalTime().AddDays(-60).ToString('o');createdAt=(Get-Date).ToUniversalTime().ToString('o');files=@{ca=(Get-FileHash -LiteralPath(Join-Path $root 'internal-ca.cer') -Algorithm SHA256).Hash.ToLowerInvariant();certificate=(Get-FileHash -LiteralPath(Join-Path $root 'server.pem') -Algorithm SHA256).Hash.ToLowerInvariant();privateKey=(Get-FileHash -LiteralPath(Join-Path $root 'server-key.pem') -Algorithm SHA256).Hash.ToLowerInvariant();offlineCaPfx=(Get-FileHash -LiteralPath $OfflineCaPfxPath -Algorithm SHA256).Hash.ToLowerInvariant()}}
    [IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
    $completed=$true
  }finally{
    $passwordText=$null;$offlineCaExportPassword=$null;$createdThumbprints=@(@($server,$ca)|Where-Object{$_}|ForEach-Object{$_.Thumbprint});$cleanupFailure=$null
    try{foreach($thumbprint in $createdThumbprints){Remove-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction Stop};$remaining=@(Get-ChildItem Cert:\CurrentUser\My|Where-Object{$_.Thumbprint-in$createdThumbprints});if($remaining.Count-ne0){throw'ONLINE_PRIVATE_KEY_CLEANUP_FAILED'}}catch{$cleanupFailure=$_}
    if(-not$completed){try{Cleanup-Generated $root}catch{if(-not$cleanupFailure){$cleanupFailure=$_}}}
    if($cleanupFailure){throw$cleanupFailure}
  }
  [pscustomobject]@{Result='CREATED';CaPrivateKeyRetainedOffline=$true;RenewBefore=$manifest.renewAfter;ClientTrustInstalled=$false;LanOpened=$false}|ConvertTo-Json;exit 0
}
if($Action-eq'Rollback'){Cleanup-Generated $root;[pscustomobject]@{Result='ROLLED_BACK';ClientTrustRemoved=$false;Scope='Exact generated and partial certificate artifacts'}|ConvertTo-Json;exit 0}
if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw 'CERTIFICATE_MANIFEST_NOT_FOUND'};$manifest=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json
if($Action-eq'Verify'){
  foreach($file in @($NodePath,$VerifierScriptPath,$OfflineCaPfxPath,$OfflineCaPasswordEscrowPath,(Join-Path $root 'internal-ca.cer'),(Join-Path $root 'server.pem'),(Join-Path $root 'server-key.pem'))){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw 'CERTIFICATE_VERIFY_FILE_MISSING'};Assert-NoReparseAncestors $file}
  Assert-Pinned $NodePath $ExpectedNodeSha256 'NODE_HASH_MISMATCH';Assert-Pinned $VerifierScriptPath $ExpectedVerifierScriptSha256 'TLS_VERIFIER_HASH_MISMATCH';if(-not(Under $NodePath $fs.classRoots.SHARED_RUNTIME)-or-not(Under $VerifierScriptPath $fs.classRoots.SHARED_RUNTIME)){throw'CERTIFICATE_VERIFIER_OUTSIDE_SHARED_RUNTIME'}
  if((Get-FileHash -LiteralPath(Join-Path $root 'internal-ca.cer') -Algorithm SHA256).Hash.ToLowerInvariant()-cne$manifest.files.ca-or(Get-FileHash -LiteralPath(Join-Path $root 'server.pem') -Algorithm SHA256).Hash.ToLowerInvariant()-cne$manifest.files.certificate-or(Get-FileHash -LiteralPath(Join-Path $root 'server-key.pem') -Algorithm SHA256).Hash.ToLowerInvariant()-cne$manifest.files.privateKey){throw 'CERTIFICATE_FILE_HASH_MISMATCH'}
  $result=&$NodePath $VerifierScriptPath (Join-Path $root 'internal-ca.cer') (Join-Path $root 'server.pem') (Join-Path $root 'server-key.pem') $manifest.hostname;if($LASTEXITCODE-ne0){throw 'CERTIFICATE_CRYPTOGRAPHIC_VERIFY_FAILED'}
  $verified=$result|ConvertFrom-Json;if($verified.result-ne'PASS'){throw 'CERTIFICATE_CRYPTOGRAPHIC_VERIFY_FAILED'}
  $passwordText=[IO.File]::ReadAllText($OfflineCaPasswordEscrowPath,[Text.Encoding]::UTF8);if($passwordText-notmatch'^[A-Za-z0-9_-]{43}$'){throw'OFFLINE_CA_ESCROW_PASSWORD_INVALID'};$caPublic=New-Object Security.Cryptography.X509Certificates.X509Certificate2((Join-Path $root 'internal-ca.cer'));$collection=New-Object Security.Cryptography.X509Certificates.X509Certificate2Collection
  try{$collection.Import($OfflineCaPfxPath,$passwordText,[Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet);$privateCa=@($collection|Where-Object{$_.HasPrivateKey-and$_.Thumbprint-ieq$caPublic.Thumbprint});if($privateCa.Count-ne1){throw'OFFLINE_CA_PFX_DECRYPT_OR_KEY_MATCH_FAILED'}}finally{foreach($certificate in $collection){$certificate.Dispose()};$caPublic.Dispose();$passwordText=$null}
  if((Get-FileHash -LiteralPath $OfflineCaPfxPath -Algorithm SHA256).Hash.ToLowerInvariant()-cne$manifest.files.offlineCaPfx-or[datetime]$manifest.renewAfter-le(Get-Date).ToUniversalTime()){throw 'OFFLINE_CA_ESCROW_OR_RENEWAL_INVALID'}
  [pscustomobject]@{Result='PASS';CaPrivateKeyRetainedOffline=$true;HostnameMatched=$true;PrivateKeyMatched=$true;RenewalWindowValid=$true;ClientTrustInstalled=$false}|ConvertTo-Json;exit 0
}
throw'CERTIFICATE_ACTION_INVALID'
