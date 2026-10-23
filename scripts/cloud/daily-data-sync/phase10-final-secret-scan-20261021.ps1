param([ValidatePattern('^[a-z0-9-]+$')][string]$Label='resume-20261021-secret-scan-v1')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$requestedScanLabel=$Label
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
. "$PSScriptRoot/operator-session.ps1"
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
$stage='PROTECTED_MEMORY';$literals=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal);$baseline=$null;$fresh=$null;$crypto=$null;$storage=$null;$capsule=$null;$mcp=$null;$inspector=$null;$ikm=$null;$derived=$null;$cafeBytes=$null
try{
 $baseline=Read-IncidentPrivate 'compromised-baseline';$fresh=Read-IncidentPrivate 'fresh-core-v2';$crypto=Read-IncidentPrivate 'crypto-keys-20261019-crypto-rotation-a'
 $operatorMaterial=Read-Phase08Operator;[void]$literals.Add([string]$operatorMaterial.password);$operatorMaterial=$null
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
 $newPlan=Read-IncidentPrivate 'resume-20261020-v3';foreach($name in @('DAILY_SYNC_CREDENTIAL_KEY_V2','DAILY_SYNC_CHECKPOINT_KEY_B64','DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64')){if($newPlan.after.ContainsKey($name)){[void]$literals.Add([string]$newPlan.after[$name])}};$newPlan=$null;$stage='APPROVED_FILE_SELECTION';$repo='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019';$files=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$excludedDirectories=0;$excludedProtected=0;$excludedOther=0
 $stage='CAFE_PROTECTED_RESPONSE_LITERALS';$cafeNewLiteralCount=0;$cafeOldRefreshLiteralIncluded=$false;$cafeCaptured=$null;$cafeTokenBody=$null;$cafeBytes=$null
 $cafePlanName='cafe08-recovery-plan-20261020-cafe08-read-recovery-a'
 if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($cafePlanName+'.dpapi'))){
  $cafePlan=Read-IncidentPrivate $cafePlanName
  if($cafePlan.eligibleSecretRollback -cne $false -or $cafePlan.operationKey -cne '20261020-cafe08-read-recovery-a' -or [string]::IsNullOrWhiteSpace($cafePlan.refreshToken)){throw 'CAFE_PLAN_LITERAL_BINDING'}
  [void]$literals.Add([string]$cafePlan.refreshToken);$cafeOldRefreshLiteralIncluded=$true;$cafePlan=$null
 }
 $cafeResponseName='cafe08-recovery-response-20261020-cafe08-read-recovery-a'
 if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($cafeResponseName+'.dpapi'))){
  $cafeCaptured=Read-IncidentPrivate $cafeResponseName
  if($cafeCaptured.eligibleSecretRollback -cne $false -or $cafeCaptured.operationKey -cne '20261020-cafe08-read-recovery-a'){throw 'CAFE_RESPONSE_LITERAL_BINDING'}
  if($cafeCaptured.httpStatus -eq 200 -and $cafeCaptured.complete -ceq $true){
   $cafeBytes=[Convert]::FromBase64String($cafeCaptured.bodyB64);if($cafeBytes.Length -lt 1 -or $cafeBytes.Length -gt 32768){throw 'CAFE_RESPONSE_BOUND'}
   $cafeTokenBody=[Text.Encoding]::UTF8.GetString($cafeBytes)|ConvertFrom-Json -AsHashtable -Depth 10 -DateKind String
   foreach($name in @('access_token','refresh_token')){if($cafeTokenBody[$name] -isnot [string] -or $cafeTokenBody[$name].Length -lt 20 -or $cafeTokenBody[$name].Length -gt 8192){throw 'CAFE_RESPONSE_TOKEN_BOUND'};[void]$literals.Add([string]$cafeTokenBody[$name]);$cafeNewLiteralCount++}
  }
  $cafeCaptured=$null;$cafeTokenBody=$null;if($cafeBytes){[Array]::Clear($cafeBytes)};$cafeBytes=$null
 }
 $stage='CURRENT21_PROTECTED_LITERALS'
 $current21Plans=@('cafe08-recovery-storage-probe-20261021-cafe08-epoch-live-a','cafe08-recovery-plan-20261021-cafe08-epoch-live-a','cafe08-recovery-response-20261021-cafe08-epoch-live-a','cafe08-recovery-forward-20261021-cafe08-epoch-live-a','cafe08-live-epoch-plan-20261021-cafe08-epoch-live-a','cafe08-live-epoch-normalized-20261021-cafe08-epoch-live-a-2026-10-16','cafe08-live-epoch-normalized-20261021-cafe08-epoch-live-a-2026-10-17')
 $current21Protected=0
 foreach($current21Name in $current21Plans){if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($current21Name+'.dpapi'))){
  $current21Value=Read-IncidentPrivate $current21Name
  if($current21Value.eligibleSecretRollback -cne $false){throw 'CURRENT21_QUARANTINE'}
  $current21Protected++
  foreach($field in @('refreshToken','access','observationKeyB64')){if($current21Value.ContainsKey($field) -and $current21Value[$field] -is [string]){[void]$literals.Add($current21Value[$field])}}
  if($current21Name -ceq 'cafe08-recovery-response-20261021-cafe08-epoch-live-a'){
   if($current21Value.operationKey -cne '20261021-cafe08-epoch-live-a' -or $current21Value.httpStatus -ne 200 -or $current21Value.complete -cne $true){throw 'CURRENT21_RESPONSE'}
   $current21Body=[Convert]::FromBase64String($current21Value.bodyB64)
   try{if($current21Body.Length -gt 32768){throw 'CURRENT21_BODY_BOUND'};$current21Token=[Text.Encoding]::UTF8.GetString($current21Body)|ConvertFrom-Json -AsHashtable -Depth 10
    foreach($field in @('access_token','refresh_token')){if($current21Token[$field] -isnot [string] -or $current21Token[$field].Length -lt 20){throw 'CURRENT21_TOKEN'};[void]$literals.Add($current21Token[$field])}
   }finally{[Array]::Clear($current21Body);$current21Token=$null;$current21Body=$null}
  };$current21Value=$null
 }}
 $stage='APPROVED_FILE_SELECTION'
 foreach($file in Get-ChildItem -LiteralPath $PSScriptRoot -File){if($file.Name -match '^(incident-|phase10-(?:resume|independent|local)-|phase10-.*(?:20261020|20261021|performance)|phase10-dashboard-decimal)' -and $file.Extension -cin @('.ps1','.mjs','.cjs','.ts','.tsx','.json','.txt')){[void]$files.Add($file.FullName)}}
 foreach($path in @('docs/daily-data-automation/10_배포전통합검증.md','docs/daily-data-automation/진행표.md','docs/daily-data-automation/records/10_비밀노출사고_20261019.md','docs/daily-data-automation/records/10_배포판정.md','docs/daily-data-automation/records/10_배포명세.md','docs/daily-data-automation/records/10_결과.md','docs/daily-data-automation/records/08_결과.md','docs/daily-data-automation/records/08_격리환경복구_20261019.md')){[void]$files.Add((Join-Path $repo $path))}
 $stack=[Collections.Generic.Stack[string]]::new();$stack.Push($root)
 while($stack.Count){$dir=$stack.Pop();foreach($item in Get-ChildItem -LiteralPath $dir -Force){
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SCAN_REPARSE'}
  if($item.PSIsContainer){if($item.Name -match '^(build-v\d+|upload-v\d+|node_modules|\.git|pg-data|source|candidate.*)$'){$excludedDirectories++}else{$stack.Push($item.FullName)}}
  elseif($item.Extension -ceq '.dpapi'){$excludedProtected++}
  elseif($item.Extension -cin @('.json','.log','.txt','.patch')){[void]$files.Add($item.FullName)}else{$excludedOther++}
 }}
 foreach($extraRoot in @('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/resume-20261020','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-20261020','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-cafe-rollback','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v1','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-build-20261020-v1','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/performance-meta-sql-20261020-v5','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/performance-meta-sql-20261020-v2','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-rollback-v8','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/rollback-20261020-independent-rollback-v1','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-20261020-foundation-v2','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v2','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-build-20261020-v2','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/performance-plan-20261020-v1','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/performance-plan-20261020-v2','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/performance-meta-sql-20261020-v6','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/performance-meta-sql-20261020-v3','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v3','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-build-20261020-v3','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-old-history-v9','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-old-history-v10','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-rollback-v11','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-rollback-v12','C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/history-20261020-independent-history-v1')){foreach($x in Get-ChildItem -LiteralPath $extraRoot -Recurse -File){if($x.Extension -cin @('.json','.log','.txt') -and $x.FullName -notmatch '[\\/](node_modules|pg-data)[\\/]'){[void]$files.Add($x.FullName)}}};foreach($x in Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter 'phase10-resume-*'){[void]$files.Add($x.FullName)};foreach($x in Get-ChildItem -LiteralPath (Join-Path $repo 'docs/daily-data-automation') -Recurse -File -Filter '*.md'){[void]$files.Add($x.FullName)};$candidate='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v1';$cm=Get-Content (Join-Path $candidate 'source-content-manifest.json') -Raw|ConvertFrom-Json;foreach($x in $cm.files){[void]$files.Add((Join-Path $candidate $x.name))};[void]$files.Add((Join-Path $PSScriptRoot 'phase10-local-bootstrap-20261020.cjs'));$candidate2='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v2';$cm2=Get-Content (Join-Path $candidate2 'source-content-manifest.json') -Raw|ConvertFrom-Json;foreach($x in $cm2.files){[void]$files.Add((Join-Path $candidate2 $x.name))};$candidate3='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v3';$cm3=Get-Content (Join-Path $candidate3 'source-content-manifest.json') -Raw|ConvertFrom-Json;foreach($x in $cm3.files){[void]$files.Add((Join-Path $candidate3 $x.name))};$candidate4='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v4';$cm4=Get-Content (Join-Path $candidate4 'source-content-manifest.json') -Raw|ConvertFrom-Json;foreach($x in $cm4.files){[void]$files.Add((Join-Path $candidate4 $x.name))};$candidate5='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v5';$cm5=Get-Content (Join-Path $candidate5 'source-content-manifest.json') -Raw|ConvertFrom-Json;foreach($x in $cm5.files){[void]$files.Add((Join-Path $candidate5 $x.name))};foreach($extra in @('evidence','performance-projection-20261020','recheck-20261020-v4','recheck-build-20261020-v4','performance-meta-sql-20261020-v7','performance-meta-sql-20261020-v8','independent/performance-meta-sql-20261020-v4','independent/performance-relations-20261020-v1')){$extraPath=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation' $extra;if(Test-Path -LiteralPath $extraPath){foreach($x in Get-ChildItem -LiteralPath $extraPath -Recurse -File){if($x.Extension -cin @('.json','.log','.txt') -and $x.FullName -notmatch '[\\/](node_modules|pg-data)[\\/]'){[void]$files.Add($x.FullName)}}}};$stage='LOCAL_SCAN';$literalFiles=0;$patternFiles=0;$literalMatches=0;$patternMatches=0;$bytes=0L;$inventory=@()
 # REOPENED_EVIDENCE_ROOTS: fixed dated scope; exclude local database/dependency directories.
 $candidate6='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v6'
 if(Test-Path -LiteralPath $candidate6){$cm6=Get-Content -LiteralPath (Join-Path $candidate6 'source-content-manifest.json') -Raw|ConvertFrom-Json;if($cm6.files.Count -ne 495){throw 'C6_SCAN_CLOSURE'};foreach($x in $cm6.files){[void]$files.Add((Join-Path $candidate6 $x.name))}}
 $candidate7='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v7'
 if(Test-Path -LiteralPath $candidate7){$cm7=Get-Content -LiteralPath (Join-Path $candidate7 'source-content-manifest.json') -Raw|ConvertFrom-Json;if($cm7.files.Count -ne 495){throw 'C7_SCAN_CLOSURE'};foreach($x in $cm7.files){[void]$files.Add((Join-Path $candidate7 $x.name))}}
 foreach($extraRoot in Get-ChildItem -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation' -Directory){
  if($extraRoot.Name -cmatch '^(?:portable-build|cafe-[a-z0-9-]+|mixed)-202610(?:20|21)-v[1-9][0-9]*$'){
   foreach($x in Get-ChildItem -LiteralPath $extraRoot.FullName -Recurse -File){
    if($x.Extension -cin @('.json','.log','.txt') -and $x.FullName -notmatch '[\\/](node_modules|pg-data)[\\/]'){[void]$files.Add($x.FullName)}
   }
  }
 }
 foreach($current21Root in @('continuation-20261021','independent/resume-20261021')){
  $selected21=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation' $current21Root
  if(Test-Path -LiteralPath $selected21){foreach($entry21 in Get-ChildItem -LiteralPath $selected21 -Recurse -File){if(($entry21.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'CURRENT21_REPARSE'};if($entry21.Extension -cin @('.json','.txt','.log','.md') -and $entry21.FullName -notmatch '[\\/](node_modules|pg-data)[\\/]'){[void]$files.Add($entry21.FullName)}}}
 }
 foreach($path in @($files|Sort-Object)){$info=Get-Item -LiteralPath $path;if($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $info.Length -gt 33554432){throw 'SCAN_FILE_BOUND'};$text=[IO.File]::ReadAllText($path);$result=Test-IndependentIncidentSecretText $text $literals;$bytes+=$info.Length;if($result.literalMatchCount){$literalFiles++};if($result.patternMatchCount){$patternFiles++};$literalMatches+=$result.literalMatchCount;$patternMatches+=$result.patternMatchCount;$inventory+=@{pathSha256=(Get-IndependentIncidentStringHash $info.FullName);contentSha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()};$text=$null}
 $stage='ACL_AND_QUARANTINE';$privatePaths=@($script:IncidentPrivate,(Get-Phase08ProtectedPaths).Root,(Get-Phase08ProtectedPaths).File,$script:IncidentStoragePrivate)
 $privatePaths+=$phase08OperatorPath
 $privatePaths+=@(Get-ChildItem -LiteralPath $script:IncidentPrivate -File -Filter '*.dpapi'|ForEach-Object{$_.FullName})
 $privatePaths+=@(Get-ChildItem -LiteralPath (Get-Phase08ProtectedPaths).Root -File -Filter '*incident*.dpapi'|ForEach-Object{$_.FullName})
 foreach($localRoot in Get-ChildItem -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime' -Directory | Where-Object {$_.Name -cmatch '^cafe-(?:live|epoch|epoch-live)-local-'}){
  if($localRoot.Name -cnotmatch '^cafe-(?:live|epoch|epoch-live)-local-[a-f0-9-]{36}$' -or ($localRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'LOCAL_PRIVATE_PG_SCOPE'}
  foreach($passwordFile in @('initdb-owner-password.txt','epoch-owner-password.txt','owner-password.txt')){if(Test-Path -LiteralPath (Join-Path $localRoot.FullName $passwordFile)){throw 'LOCAL_PRIVATE_PASSWORD_RESIDUAL'}}
  $privatePaths+=$localRoot.FullName
  foreach($localEntry in Get-ChildItem -LiteralPath $localRoot.FullName -Recurse -Force){if(($localEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'LOCAL_PRIVATE_PG_REPARSE'};$privatePaths+=$localEntry.FullName}
 }
 $nativeRetention=Get-Content -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-live-input-local-20261020-v1/attempt-28545a0c-2218-4b3a-8f2a-7fc8d58bcedc/privacy-proof.json' -Raw|ConvertFrom-Json -AsHashtable -Depth 15 -DateKind String
 if($nativeRetention.kind -cne 'CAFE08_LOCAL_NATIVE_PRIVATE_RETENTION' -or $nativeRetention.temporaryRandomLocalPasswordFileCreated -ne 1 -or $nativeRetention.temporaryPasswordFileRemaining -ne 0){throw 'NATIVE_RETENTION_PROOF_SCOPE'}
 $epochPasswordCreated=0;$epochPasswordRemaining=0;$epochPasswordProofs=0
 foreach($epochRoot in Get-ChildItem -LiteralPath 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation' -Directory | Where-Object {$_.Name -cmatch '^cafe-epoch-eval-20261020-v[1-9][0-9]*$'}){
  foreach($attempt in Get-ChildItem -LiteralPath $epochRoot.FullName -Directory | Where-Object {$_.Name -cmatch '^attempt-[a-f0-9-]{36}$'}){
   $resultPath=Join-Path $attempt.FullName 'result.json';if(Test-Path -LiteralPath $resultPath){$epochResult=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json -AsHashtable -Depth 30 -DateKind String;if($epochResult.ContainsKey('native') -and $epochResult.native.ContainsKey('temporaryPasswordFilesCreated')){$epochPasswordProofs++;$epochPasswordCreated += [int]$epochResult.native.temporaryPasswordFilesCreated;if($epochResult.native.temporaryPasswordFileRemaining -cne $false){$epochPasswordRemaining++}}}
  }
 }
 if($epochPasswordRemaining -ne 0){throw 'EPOCH_TEMP_PASSWORD_RESIDUAL'}
 $privatePaths=@($privatePaths|Sort-Object -Unique);$privateAcl=Get-IndependentIncidentAclCounts $privatePaths
 $publicAcl=Get-IndependentIncidentAclCounts @($files)
 $quarantineFlags=$baseline.eligibleAsSecretRollback -ceq $false
 foreach($name in @('runtime-merge-v1','runtime-merge-v2','resume-20261020-v1','resume-20261020-v2','resume-20261020-v3','performance-recheck-20261020-v1-prep','performance-recheck-20261020-v1','performance-recheck-20261020-v3-prep','performance-recheck-20261020-v3','performance-recheck-20261020-v4-prep','performance-recheck-20261020-v4')){$plan=Read-IncidentPrivate $name;if($plan.eligibleSecretRollback -cne $false){$quarantineFlags=$false};$plan=$null}
 foreach($name in @('cafe08-recovery-storage-probe-20261020-cafe08-read-recovery-a','cafe08-recovery-plan-20261020-cafe08-read-recovery-a','cafe08-recovery-response-20261020-cafe08-read-recovery-a','cafe08-recovery-forward-20261020-cafe08-read-recovery-a','cafe08-field-plan-20261020-cafe08-field-sample-a','cafe08-full-read-plan-20261020-cafe08-full-read-a','cafe08-status-window-plan-20261020-cafe08-status-window-a','cafe08-c47-approval-plan-20261020-cafe08-c47-approval-a','cafe08-full-read-plan-20261020-cafe08-full-read-b','cafe08-normalized-day-20261020-cafe08-full-read-b-2026-10-16','cafe08-normalized-day-20261020-cafe08-full-read-b-2026-10-17')){
  if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($name+'.dpapi'))){$cafePlan=Read-IncidentPrivate $name;if($cafePlan.eligibleSecretRollback -cne $false){$quarantineFlags=$false};$cafePlan=$null}
 }
 $out=@{current21ProtectedObjectsChecked=$current21Protected;current21ScopeIncluded=$true;kind='INCIDENT_INDEPENDENT_FINAL_LOCAL_SECRET_SCAN';at=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($literalMatches -eq 0 -and $patternMatches -eq 0 -and $privateAcl.currentUserAndSystemOnly -and $quarantineFlags){'PASS'}else{'FAIL'});approvedTextFiles=$files.Count;totalBytes=$bytes;literalSourceEnvironmentNames=14;distinctProtectedLiteralCount=$literals.Count;newCafeTokenLiterals=$cafeNewLiteralCount;oldCafeRefreshLiteralIncluded=$cafeOldRefreshLiteralIncluded;literalMatches=$literalMatches;literalMatchedFiles=$literalFiles;patternMatches=$patternMatches;patternMatchedFiles=$patternFiles;excludedSourceOrDependencyOrPgDirectories=$excludedDirectories;excludedEncryptedDpapiFiles=$excludedProtected;excludedOtherFiles=$excludedOther;privateAcl=$privateAcl;publicMetadataAcl=$publicAcl;privateBackupRollbackEligibilityFlagsFalse=$quarantineFlags;oldBackupRestorationForbiddenByIncidentPolicy=$true;allPreexistingRestoreProgramsIndividuallyAudited=$false;toolTranscriptErasureProven=$false;onlySelectedLocalFilesCovered=$true;fileHashInventorySha256=(Get-IncidentHash $inventory);rawSecretsReturned=0;plaintextSecretFilesCreated=0;plaintextCreationCountScope='THIS_SCANNER_ONLY';nativeHarnessTemporaryRandomPasswordFileCreated=(1+$epochPasswordCreated);nativeHarnessTemporaryPasswordFilesRemaining=$epochPasswordRemaining;liveInputHarnessTemporaryPasswordFilesCreated=1;epochHarnessTemporaryPasswordFilesCreated=$epochPasswordCreated;epochPasswordResultReceipts=$epochPasswordProofs;temporaryPasswordCountsScope='LIVE_INPUT_RECEIPT_AND_EPOCH_RESULT_FILES';remoteRequests=0;remoteMutations=0}
 $unconsumedAbsent=$true;foreach($name in @('performance-recheck-20261020-v2','performance-recheck-20261020-v2-prep')){if(Test-Path -LiteralPath (Join-Path $script:IncidentPrivate ($name+'.dpapi'))){$unconsumedAbsent=$false}};$out.unconsumedPreparedV3PrivatePlansAbsent=$unconsumedAbsent;if(-not $unconsumedAbsent){$out.status='FAIL'};$stage='SAFE_RECEIPT_CREATE_NEW';$destination=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021' ($Label+'.json');$json=$out|ConvertTo-Json -Depth 9;Assert-IndependentIncidentOutput $json $literals;$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$wire=[Text.Encoding]::UTF8.GetBytes($json);$stream.Write($wire)}finally{$stream.Dispose()}
 @{kind=$out.kind;status=$out.status;approvedTextFiles=$out.approvedTextFiles;literalMatches=$literalMatches;patternMatches=$patternMatches;privateAclOtherPrincipalPaths=$privateAcl.pathsWithOtherAllowedPrincipals;rollbackEligibilityFlagsFalse=$quarantineFlags;rawSecretsReturned=0;remoteRequests=0;evidence=$destination}|ConvertTo-Json -Compress
 if($out.status -cne 'PASS'){exit 1}
}catch{@{kind='INCIDENT_INDEPENDENT_SECRET_SCAN_SAFE_REJECTION';stage=$stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$cafePlan=$null;$cafeCaptured=$null;$cafeTokenBody=$null;if($cafeBytes){[Array]::Clear($cafeBytes)};$cafeBytes=$null;$operatorMaterial=$null;$baseline=$null;$fresh=$null;$crypto=$null;$storage=$null;$capsule=$null;$mcp=$null;$inspector=$null;$literals.Clear();foreach($buffer in @($ikm,$derived)){if($buffer){[Array]::Clear($buffer)}};$text=$null;$wire=$null}
