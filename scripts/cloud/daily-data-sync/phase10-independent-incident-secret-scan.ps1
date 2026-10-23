param([ValidatePattern('^[a-z0-9-]+$')][string]$Label='local-secret-scan-v1')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$requestedScanLabel=$Label
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
$Label=$requestedScanLabel
function Test-IndependentIncidentSecretText([string]$Text,$Literals){
 $literalCount=0;foreach($secret in $Literals){if($secret -is [string] -and $secret.Length -ge 8 -and $Text.Contains($secret,[StringComparison]::Ordinal)){$literalCount++}}
 $patterns=@(
  'sb_secret_[A-Za-z0-9_-]{20,128}',
  'eyJ[A-Za-z0-9_-]{17,1024}\.eyJ[A-Za-z0-9_-]{17,8192}\.[A-Za-z0-9_-]{20,1024}',
  '-----BEGIN (?:(?:RSA|EC|OPENSSH) )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/\r\n]{32,16384}={0,2}[\r\n]+-----END',
  '(?is)"kty"\s*:\s*"(?:EC|RSA)".{0,2048}?"d"\s*:\s*"[A-Za-z0-9_-]{30,2048}"',
  'postgres(?:ql)?://[A-Za-z0-9_.%+-]{1,128}:[A-Za-z0-9_%+./=-]{32,512}@'
 )
 $patternCount=0;foreach($pattern in $patterns){$patternCount += [regex]::Matches($Text,$pattern).Count}
 return @{literalMatchCount=$literalCount;patternMatchCount=$patternCount}
}
function Get-IndependentIncidentAclCounts($Paths){
 $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$otherFiles=0;$inheritedFiles=0;$adminFiles=0;$beyondAdminFiles=0;$broadReaderFiles=0;$count=0
 foreach($path in $Paths){$count++;$acl=Get-Acl -LiteralPath $path;$other=$false;$inherited=$false;$admin=$false;$beyondAdmin=$false;$broadReader=$false
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){$sid=$rule.IdentityReference.Value;if($sid -cnotin @($user,'S-1-5-18')){$other=$true};if($sid -ceq 'S-1-5-32-544'){$admin=$true};if($sid -cnotin @($user,'S-1-5-18','S-1-5-32-544')){$beyondAdmin=$true};if($sid -cin @('S-1-1-0','S-1-5-11','S-1-5-32-545')){$broadReader=$true};if($rule.IsInherited){$inherited=$true}}
  };if($other){$otherFiles++};if($inherited){$inheritedFiles++};if($admin){$adminFiles++};if($beyondAdmin){$beyondAdminFiles++};if($broadReader){$broadReaderFiles++}
 };return @{pathsChecked=$count;pathsWithOtherAllowedPrincipals=$otherFiles;pathsWithInheritedAllowRules=$inheritedFiles;pathsAllowingAdministrators=$adminFiles;pathsAllowingBeyondCurrentUserSystemAdministrators=$beyondAdminFiles;pathsAllowingEveryoneAuthenticatedUsersOrBuiltinUsers=$broadReaderFiles;currentUserAndSystemOnly=($otherFiles -eq 0)}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$stage='PROTECTED_MEMORY';$literals=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);$baseline=$null;$fresh=$null;$crypto=$null;$storage=$null;$capsule=$null;$mcp=$null;$inspector=$null;$ikm=$null;$derived=$null
try{
 $baseline=Read-IncidentPrivate 'compromised-baseline';$fresh=Read-IncidentPrivate 'fresh-core-v2';$crypto=Read-IncidentPrivate 'crypto-keys-20261019-crypto-rotation-a'
 $names=@('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN','DATABASE_URL','DAILY_SYNC_CREDENTIAL_KEY_V1','DAILY_SYNC_CHECKPOINT_KEY_B64','SUPABASE_SECRET_KEY','SUPABASE_STORAGE_ACCESS_TOKEN','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET')
 foreach($name in $names){if(-not $baseline.variables.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($baseline.variables[$name])){throw 'BASELINE_LITERAL_SET'};[void]$literals.Add([string]$baseline.variables[$name])}
 foreach($value in $fresh.changes.Values){[void]$literals.Add([string]$value)}
 foreach($url in @($baseline.variables.DATABASE_URL,$fresh.changes.DATABASE_URL)){$part=([Uri]$url).UserInfo.Split(':',2)[1];[void]$literals.Add($part);[void]$literals.Add([Uri]::UnescapeDataString($part))}
 foreach($value in $crypto.Values){[void]$literals.Add([string]$value)}
 $savedLabel=$Label;. "$PSScriptRoot/incident-storage-rotation.ps1";$Label=$savedLabel;$storage=Read-IncidentStorageMaterial;[void]$literals.Add([string]$storage.oldToken);[void]$literals.Add([string]$storage.newToken)
 $capsule=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($baseline.variables.PHASE08_GOOGLE_ADC_JSON_B64))|ConvertFrom-Json -AsHashtable -Depth 20
 if($capsule.type -cne 'impersonated_service_account' -or $capsule.source_credentials.type -cne 'authorized_user'){throw 'ADC_CLASS'}
 [void]$literals.Add([string]$capsule.source_credentials.client_secret);[void]$literals.Add([string]$capsule.source_credentials.refresh_token)
 $mcp=Read-IndependentIncidentMetaToken 'mcp-access-token.dpapi';$inspector=Read-IndependentIncidentMetaToken 'inspector-token.dpapi';$equality=Get-IndependentIncidentMetaEquality $baseline.variables $mcp $inspector
 if(-not $equality.offlineAuthenticatedDecryption -or -not $equality.mcpTokenEqualsExistingProtectedSource -or -not $equality.inspectorTokenEqualsExistingProtectedSource){throw 'META_LITERAL_BINDING'}
 [void]$literals.Add($mcp);[void]$literals.Add($inspector)
 $ikm=[Convert]::FromBase64String($baseline.variables.DAILY_SYNC_CREDENTIAL_KEY_V1);$derived=[Security.Cryptography.HKDF]::DeriveKey([Security.Cryptography.HashAlgorithmName]::SHA256,$ikm,32,[Text.Encoding]::UTF8.GetBytes('cafe24-observation-v1'),[Text.Encoding]::UTF8.GetBytes('order-revision'))
 [void]$literals.Add([Convert]::ToBase64String($derived));[void]$literals.Add([Convert]::ToHexString($derived).ToLowerInvariant())
 $stage='APPROVED_FILE_SELECTION';$repo='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019';$files=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$excludedDirectories=0;$excludedProtected=0;$excludedOther=0
 foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File){if($file.Name -match '^(incident-|phase10-independent-incident-)' -and $file.Extension -cin @('.ps1','.mjs','.ts','.json','.txt')){[void]$files.Add($file.FullName)}}
 foreach($path in @('docs/daily-data-automation/10_배포전통합검증.md','docs/daily-data-automation/진행표.md','docs/daily-data-automation/records/10_비밀노출사고_20261019.md','docs/daily-data-automation/records/10_배포판정.md','docs/daily-data-automation/records/10_배포명세.md','docs/daily-data-automation/records/10_결과.md','docs/daily-data-automation/records/08_결과.md','docs/daily-data-automation/records/08_격리환경복구_20261019.md')){[void]$files.Add((Join-Path $repo $path))}
 $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($root)
 while($stack.Count){$dir=$stack.Pop();foreach($item in Get-ChildItem -LiteralPath $dir -Force){
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SCAN_REPARSE'}
  if($item.PSIsContainer){if($item.Name -match '^(build-v\d+|upload-v\d+|node_modules|\.git|pg-data|source|candidate.*)$'){$excludedDirectories++}else{$stack.Push($item.FullName)}}
  elseif($item.Extension -ceq '.dpapi'){$excludedProtected++}
  elseif($item.Extension -cin @('.json','.log','.txt','.patch')){[void]$files.Add($item.FullName)}else{$excludedOther++}
 }}
 $stage='LOCAL_SCAN';$literalFiles=0;$patternFiles=0;$literalMatches=0;$patternMatches=0;$bytes=0L;$inventory=@()
 foreach($path in @($files|Sort-Object)){$info=Get-Item -LiteralPath $path;if($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.Length -gt 33554432){throw 'SCAN_FILE_BOUND'};$text=[IO.File]::ReadAllText($path);$result=Test-IndependentIncidentSecretText $text $literals;$bytes+=$info.Length;if($result.literalMatchCount){$literalFiles++};if($result.patternMatchCount){$patternFiles++};$literalMatches+=$result.literalMatchCount;$patternMatches+=$result.patternMatchCount;$inventory+=@{pathSha256=(Get-IndependentIncidentStringHash $info.FullName);contentSha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()};$text=$null}
 $stage='ACL_AND_QUARANTINE';$privatePaths=@($script:IncidentPrivate,(Get-Phase08ProtectedPaths).Root,(Get-Phase08ProtectedPaths).File,$script:IncidentStoragePrivate)
 $privatePaths+=@(Get-ChildItem -LiteralPath $script:IncidentPrivate -File -Filter '*.dpapi'|ForEach-Object{$_.FullName})
 $privatePaths+=@(Get-ChildItem -LiteralPath (Get-Phase08ProtectedPaths).Root -File -Filter '*incident*.dpapi'|ForEach-Object{$_.FullName})
 $privatePaths=@($privatePaths|Sort-Object -Unique);$privateAcl=Get-IndependentIncidentAclCounts $privatePaths
 $publicAcl=Get-IndependentIncidentAclCounts @($files)
 $quarantineFlags=$baseline.eligibleAsSecretRollback -ceq $false
 foreach($name in @('runtime-merge-v1','runtime-merge-v2')){$plan=Read-IncidentPrivate $name;if($plan.eligibleSecretRollback -cne $false){$quarantineFlags=$false};$plan=$null}
 $out=@{kind='INCIDENT_INDEPENDENT_FINAL_LOCAL_SECRET_SCAN';at=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($literalMatches -eq 0 -and $patternMatches -eq 0 -and $privateAcl.currentUserAndSystemOnly -and $quarantineFlags){'PASS'}else{'FAIL'});approvedTextFiles=$files.Count;totalBytes=$bytes;literalSourceEnvironmentNames=14;distinctProtectedLiteralCount=$literals.Count;literalMatches=$literalMatches;literalMatchedFiles=$literalFiles;patternMatches=$patternMatches;patternMatchedFiles=$patternFiles;excludedSourceOrDependencyOrPgDirectories=$excludedDirectories;excludedEncryptedDpapiFiles=$excludedProtected;excludedOtherFiles=$excludedOther;privateAcl=$privateAcl;publicMetadataAcl=$publicAcl;privateBackupRollbackEligibilityFlagsFalse=$quarantineFlags;oldBackupRestorationForbiddenByIncidentPolicy=$true;allPreexistingRestoreProgramsIndividuallyAudited=$false;toolTranscriptErasureProven=$false;onlySelectedLocalFilesCovered=$true;fileHashInventory=$inventory;rawSecretsReturned=0;plaintextSecretFilesCreated=0;remoteRequests=0;remoteMutations=0}
 $stage='SAFE_RECEIPT_CREATE_NEW';$destination=Join-Path $root ('independent/'+$Label+'.json');$json=$out|ConvertTo-Json -Depth 9;Assert-IndependentIncidentOutput $json $literals;$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$wire=[Text.Encoding]::UTF8.GetBytes($json);$stream.Write($wire)}finally{$stream.Dispose()}
 @{kind=$out.kind;status=$out.status;approvedTextFiles=$out.approvedTextFiles;literalMatches=$literalMatches;patternMatches=$patternMatches;privateAclOtherPrincipalPaths=$privateAcl.pathsWithOtherAllowedPrincipals;rollbackEligibilityFlagsFalse=$quarantineFlags;rawSecretsReturned=0;remoteRequests=0;evidence=$destination}|ConvertTo-Json -Compress
 if($out.status -cne 'PASS'){exit 1}
}catch{@{kind='INCIDENT_INDEPENDENT_SECRET_SCAN_SAFE_REJECTION';stage=$stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$baseline=$null;$fresh=$null;$crypto=$null;$storage=$null;$capsule=$null;$mcp=$null;$inspector=$null;$literals.Clear();foreach($buffer in @($ikm,$derived)){if($buffer){[Array]::Clear($buffer)}};$text=$null;$wire=$null}
