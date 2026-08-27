#Requires -Version 7.2
[CmdletBinding()]
param(
  [ValidateSet('Plan','Install','Remove','Verify')][string]$Action='Plan',
  [ValidateSet('PreOpen','Live')][string]$Phase='PreOpen',
  [string]$CaCertificatePath,[string]$ExpectedCaCertificateSha256,[string]$ExpectedThumbprint,
  [string]$ServerCertificatePath,[string]$ExpectedServerCertificateSha256,
  [string]$Hostname,[string]$ExpectedReleaseId,[string]$ClientId,[string]$ClientIpv4Address,[string]$EvidenceOutputPath,
  [ValidateSet('Install','Remove','VerifyEvidence')][string]$PlannedAction,[string]$ApprovedPlanSha256,[string]$ApprovalNonce,[string]$ApprovalIssuedAt,[string]$ApprovalExpiresAt,[string]$ApprovalInstanceId,[string]$ApprovalLedgerPath,[switch]$Approved
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'approval-plan.ps1')
function IsPrivateIpv4([string]$Address){try{$parts=$Address.Split('.')|ForEach-Object{[int]$_};return ($parts.Count-eq4-and($parts|Where-Object{$_-lt0-or$_-gt255}).Count-eq0-and($parts[0]-eq10-or($parts[0]-eq172-and$parts[1]-ge16-and$parts[1]-le31)-or($parts[0]-eq192-and$parts[1]-eq168)))}catch{return $false}}
function Assert-ExactClientAddress{
  if(-not(IsPrivateIpv4 $ClientIpv4Address)){throw 'CLIENT_IPV4_ADDRESS_NOT_PRIVATE'}
  $addresses=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop|Where-Object{[string]$_.IPAddress-ceq$ClientIpv4Address-and[string]$_.AddressState-ceq'Preferred'-and-not[bool]$_.SkipAsSource})
  if($addresses.Count-ne1){throw 'CLIENT_IPV4_ADDRESS_NOT_PRESENT_ON_ENABLED_INTERFACE'}
  $interfaces=@(Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex ([int]$addresses[0].InterfaceIndex) -ErrorAction Stop|Where-Object{[string]$_.ConnectionState-ceq'Connected'-and[string]$_.InterfaceAlias-notmatch'(?i)loopback'})
  if($interfaces.Count-ne1){throw 'CLIENT_IPV4_INTERFACE_NOT_ENABLED'}
  return "$ClientIpv4Address/32"
}
function New-ClientTrustApprovalPlan([string]$IntendedAction){
  if($IntendedAction-notin@('Install','Remove','VerifyEvidence')){throw 'PLANNED_ACTION_REQUIRED'}
  if($ExpectedThumbprint-notmatch'^[A-Fa-f0-9]{40}$'-or$ClientId-notmatch'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'-or-not(IsPrivateIpv4 $ClientIpv4Address)){throw 'CLIENT_TRUST_PLAN_IDENTITY_INVALID'}
  $parameters=[ordered]@{caThumbprint=$ExpectedThumbprint.ToUpperInvariant();trustStore='Cert:\LocalMachine\Root';clientId=$ClientId;clientIpv4Cidr="$ClientIpv4Address/32"}
  if($IntendedAction-eq'Install'){$parameters.caCertificatePath=Get-ApprovalPath $CaCertificatePath 'CLIENT_TRUST_PLAN_CA_PATH_REQUIRED';$parameters.caCertificateSha256=Get-ApprovalHash $ExpectedCaCertificateSha256 'CLIENT_TRUST_PLAN_CA_HASH_REQUIRED'}
  if($IntendedAction-eq'VerifyEvidence'){
    if($Hostname-notmatch'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'-or($Phase-eq'Live'-and$ExpectedReleaseId-notmatch'^[a-z0-9][a-z0-9._-]{0,62}$')){throw 'CLIENT_TRUST_PLAN_IDENTITY_INVALID'}
    $parameters=[ordered]@{caThumbprint=$ExpectedThumbprint.ToUpperInvariant();trustStore='Cert:\LocalMachine\Root';phase=$Phase;hostname=$Hostname;expectedReleaseId=if($Phase-eq'Live'){$ExpectedReleaseId}else{$null};clientId=$ClientId;clientIpv4Cidr="$ClientIpv4Address/32";serverCertificatePath=(Get-ApprovalPath $ServerCertificatePath 'CLIENT_TRUST_PLAN_SERVER_CERTIFICATE_PATH_REQUIRED');serverCertificateSha256=(Get-ApprovalHash $ExpectedServerCertificateSha256 'CLIENT_TRUST_PLAN_SERVER_CERTIFICATE_HASH_REQUIRED');evidenceOutputPath=(Get-ApprovalPath $EvidenceOutputPath 'CLIENT_TRUST_PLAN_EVIDENCE_PATH_REQUIRED')}
  }
  $target=if($IntendedAction-eq'Install'){"Install exact CA $($parameters.caThumbprint) into client $ClientId at $ClientIpv4Address/32 LocalMachine Root store"}elseif($IntendedAction-eq'Remove'){"Remove exact CA $($parameters.caThumbprint) from client $ClientId at $ClientIpv4Address/32 LocalMachine Root store"}else{"Write exact $Phase client trust evidence for client $ClientId at $ClientIpv4Address/32 and $Hostname"}
  $impact=if($IntendedAction-eq'Install'){'Adds one public CA certificate without a private key to this client trust store'}elseif($IntendedAction-eq'Remove'){'Removes only the exact CA thumbprint from this client trust store'}else{'Verifies the exact offline/live certificate identity and writes non-secret client evidence; it does not change trust'}
  $rollback=if($IntendedAction-eq'Install'){"Remove exact thumbprint $($parameters.caThumbprint) using a separately approved Remove plan"}elseif($IntendedAction-eq'Remove'){'Reinstall only from the pinned public CA certificate using a new approved Install plan'}else{'Delete only the exact evidence output file'}
  return New-ApprovalPlan $PSCommandPath $IntendedAction $parameters $target $impact $rollback
}
if($Action-eq'Plan'){
  New-ClientTrustApprovalPlan $PlannedAction|ConvertTo-Json -Depth 12;exit 0
}
$clientTrustMutation=if($Action-in@('Install','Remove')){$Action}elseif($Action-eq'Verify'-and$EvidenceOutputPath){'VerifyEvidence'}else{$null}
$approvedClientTrustPlan=$null
if($clientTrustMutation){$approvedClientTrustPlan=New-ClientTrustApprovalPlan $clientTrustMutation;Assert-ApprovedPlan $approvedClientTrustPlan ([bool]$Approved) $ApprovedPlanSha256}
if($ExpectedThumbprint-notmatch'^[A-Fa-f0-9]{40}$'){throw 'EXPECTED_THUMBPRINT_REQUIRED'}
$expectedThumb=$ExpectedThumbprint.ToUpperInvariant();$storePath="Cert:\LocalMachine\Root\$expectedThumb";$verifiedClientCidr=$null;if($Action-in@('Install','Remove','Verify')){$verifiedClientCidr=Assert-ExactClientAddress}
if($Action-eq'Verify'){
  if($Hostname-notmatch'^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$'-or$ClientId-notmatch'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'-or-not(IsPrivateIpv4 $ClientIpv4Address)){throw 'CLIENT_EVIDENCE_ARGUMENTS_REQUIRED'}
  if(-not(Test-Path -LiteralPath $ServerCertificatePath -PathType Leaf)-or$ExpectedServerCertificateSha256-notmatch'^[A-Fa-f0-9]{64}$'){throw 'SERVER_CERTIFICATE_EVIDENCE_REQUIRED'}
  $ca=Get-Item -LiteralPath $storePath -ErrorAction SilentlyContinue
  $basic=$ca.Extensions|Where-Object{$_.Oid.Value-eq'2.5.29.19'};$keyUsage=$ca.Extensions|Where-Object{$_.Oid.Value-eq'2.5.29.15'}
  $caValid=$ca-and$ca.Thumbprint-ieq$expectedThumb-and-not$ca.HasPrivateKey-and$ca.NotAfter-gt(Get-Date).AddDays(30)-and$basic.CertificateAuthority-and($keyUsage.KeyUsages-band[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign)
  $serverHash=(Get-FileHash -LiteralPath $ServerCertificatePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if($serverHash-cne$ExpectedServerCertificateSha256.ToLowerInvariant()){throw 'SERVER_CERTIFICATE_HASH_MISMATCH'}
  $server=[Security.Cryptography.X509Certificates.X509Certificate2]::new($ServerCertificatePath)
  try{
    $hostnameVerified=$server.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::DnsName,$false)-ieq$Hostname
    $chain=New-Object Security.Cryptography.X509Certificates.X509Chain
    try{$chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck;$chain.ChainPolicy.VerificationFlags=[Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag;$chainVerified=$chain.Build($server);$rootThumb=if($chain.ChainElements.Count){$chain.ChainElements[$chain.ChainElements.Count-1].Certificate.Thumbprint}else{$null}}finally{$chain.Dispose()}
    $offlineVerified=$caValid-and$chainVerified-and$rootThumb-ieq$expectedThumb-and$hostnameVerified-and-not$server.HasPrivateKey-and$server.NotAfter-gt(Get-Date).AddDays(7)
    $httpsVerified=$false
    if($Phase-eq'Live'-and$offlineVerified-and$ExpectedReleaseId){
      try{$request=[Net.HttpWebRequest]::Create("https://$Hostname/backend-api/health/live");$request.Proxy=$null;$request.Timeout=5000;$response=$request.GetResponse();try{$reader=New-Object IO.StreamReader($response.GetResponseStream());$value=$reader.ReadToEnd()|ConvertFrom-Json;$remoteThumb=$response.ServicePoint.Certificate.GetCertHashString();$httpsVerified=[int]$response.StatusCode-eq200-and$value.status-eq'live'-and$value.releaseId-eq$ExpectedReleaseId-and$remoteThumb-ieq$server.Thumbprint}finally{$response.Dispose()}}catch{$httpsVerified=$false}
    }
    $pass=$offlineVerified-and($Phase-eq'PreOpen'-or$httpsVerified)
    if($pass-and$EvidenceOutputPath){
      $sha=[Security.Cryptography.SHA256]::Create();try{$clientHash=-join@($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ClientId))|ForEach-Object{$_.ToString('x2')})}finally{$sha.Dispose()}
      $record=[ordered]@{version=3;result='PASS';phase=$Phase.ToUpperInvariant();hostname=$Hostname;caThumbprint=$expectedThumb;serverCertificateSha256=$serverHash;clientIdHash=$clientHash;clientIpv4Address=$ClientIpv4Address;clientIpv4Cidr=$verifiedClientCidr;clientAddressOwnershipVerified=$true;verificationPlanSha256=[string]$approvedClientTrustPlan.planSha256;trustStoreVerified=$true;certificateChainVerified=$true;hostnameVerified=$true;httpsVerified=$httpsVerified;releaseId=if($Phase-eq'Live'){$ExpectedReleaseId}else{$null};completedAt=(Get-Date).ToUniversalTime().ToString('o')}
      [IO.File]::WriteAllText($EvidenceOutputPath,($record|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
    }
    [pscustomobject]@{Result=if($pass){'PASS'}else{'FAIL'};Phase=$Phase;CaTrusted=$caValid;CertificateChainVerified=$chainVerified;HostnameVerified=$hostnameVerified;HttpsTrustAndReleaseVerified=$httpsVerified}|ConvertTo-Json
    if(-not$pass){exit 1};exit 0
  }finally{$server.Dispose()}
}
if($Action-eq'Install'){
  if(-not(Test-Path -LiteralPath $CaCertificatePath -PathType Leaf)){throw 'CA_CERTIFICATE_NOT_FOUND'}
  if($ExpectedCaCertificateSha256-notmatch'^[A-Fa-f0-9]{64}$'-or(Get-FileHash -LiteralPath $CaCertificatePath -Algorithm SHA256).Hash-ine$ExpectedCaCertificateSha256){throw 'CA_CERTIFICATE_HASH_MISMATCH'}
  $certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new($CaCertificatePath)
  if($certificate.Thumbprint-ine$expectedThumb){throw 'CA_THUMBPRINT_MISMATCH'}
  $basic=$certificate.Extensions|Where-Object{$_.Oid.Value-eq'2.5.29.19'};$keyUsage=$certificate.Extensions|Where-Object{$_.Oid.Value-eq'2.5.29.15'}
  if(-not$basic.CertificateAuthority-or-not($keyUsage.KeyUsages-band[Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign)-or$certificate.HasPrivateKey){throw 'CA_CERTIFICATE_CONSTRAINTS_INVALID'}
  $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine');try{$store.Open('ReadWrite');$store.Add($certificate)}finally{$store.Dispose();$certificate.Dispose()}
  $installed=@(Get-ChildItem Cert:\LocalMachine\Root|Where-Object{$_.Thumbprint-ieq$expectedThumb});if($installed.Count-ne1-or$installed[0].HasPrivateKey){throw 'CA_TRUST_INSTALL_VERIFY_FAILED'}
  [pscustomobject]@{Result='INSTALLED';Scope='Exact CA only';LanOpened=$false}|ConvertTo-Json;exit 0
}
$present=@(Get-ChildItem Cert:\LocalMachine\Root|Where-Object{$_.Thumbprint-ieq$expectedThumb});if($present.Count-gt1){throw 'CA_TRUST_STORE_DUPLICATE'}
if($present.Count-eq1){$basic=@($present[0].Extensions|Where-Object{$_.Oid.Value-eq'2.5.29.19'});if($basic.Count-ne1-or-not$basic[0].CertificateAuthority-or$present[0].HasPrivateKey){throw 'CA_TRUST_REMOVE_TARGET_INVALID'};Remove-Item -LiteralPath $storePath -ErrorAction Stop}
if(@(Get-ChildItem Cert:\LocalMachine\Root|Where-Object{$_.Thumbprint-ieq$expectedThumb}).Count-ne0){throw 'CA_TRUST_REMOVE_VERIFY_FAILED'}
[pscustomobject]@{Result=if($present.Count-eq0){'REMOVED_ABSENT'}else{'REMOVED'};Scope='Exact CA only';VerifiedAbsent=$true}|ConvertTo-Json
