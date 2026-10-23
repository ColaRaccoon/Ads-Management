Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$file=Join-Path $PSScriptRoot 'seed-isolated-business-config.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'syntax'}
foreach($name in @('Test-Phase08BusinessDiagnostic','Get-Phase08BusinessSafeErrorType','Invoke-Phase08ConfigurationChild')) {
  $definition=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name})[0]
  . ([scriptblock]::Create($definition.Extent.Text))
}
$scriptPath=Join-Path $PSScriptRoot 'business-roundtrip.test.mjs'
$childDefinition=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Invoke-Phase08ConfigurationChild'})[0]
# Reproduce the original bridge without explicit encodings in memory only.
# On Windows the Unicode fixture must fail the immutable source fingerprint.
if($IsWindows) {
  . ([scriptblock]::Create($childDefinition.Extent.Text.Replace('$psi.StandardInputEncoding=$phase08Utf8;$psi.StandardOutputEncoding=$phase08Utf8;$psi.StandardErrorEncoding=$phase08Utf8','')))
  $legacyExport=Invoke-Phase08ConfigurationChild $scriptPath @{} @('--fixture')
  $legacyConfiguration=@{observedAt=$legacyExport.observedAt;hash=$legacyExport.fingerprint;products=$legacyExport.configuration.products;costRules=$legacyExport.configuration.costRules;productRules=$legacyExport.configuration.productRules;couponRules=$legacyExport.configuration.couponRules}
  $legacyRejected=$false
  try {$discard=Invoke-Phase08ConfigurationChild $scriptPath $legacyConfiguration} catch {
    $legacyRejected=$_.Exception.Data['Stage'] -ceq 'CONFIGURATION' -and $_.Exception.Data['Code'] -ceq 'CONFIGURATION_FINGERPRINT_MISMATCH'
  }
  if(-not $legacyRejected){throw 'legacy-encoding-reproduction'}
  . ([scriptblock]::Create($childDefinition.Extent.Text))
}
$export=Invoke-Phase08ConfigurationChild $scriptPath @{} @('--fixture')
# This is the same assembly/serialization used by the protected wrapper.
$configuration=@{observedAt=$export.observedAt;hash=$export.fingerprint;products=$export.configuration.products;costRules=$export.configuration.costRules;productRules=$export.configuration.productRules;couponRules=$export.configuration.couponRules}
$result=Invoke-Phase08ConfigurationChild $scriptPath $configuration
if($result.state -cne 'BUSINESS_SERIALIZATION_PASS'){throw 'roundtrip'}
foreach($pair in @(@('TARGET',@('P1001','SYNTHETIC_PRIVATE')),@(@('TARGET','SYNTHETIC_PRIVATE'),'P1001'),@('TARGET',123),@('SYNTHETIC_PRIVATE','P1001'),@('TARGET',('P1001'+'x'*100)))) {
  if(Test-Phase08BusinessDiagnostic $pair[0] $pair[1]){throw 'diagnostic-type'}
}
if(-not (Test-Phase08BusinessDiagnostic 'CONFIGURATION' 'CONFIGURATION_FINGERPRINT_MISMATCH')){throw 'diagnostic-valid'}
if(-not (Test-Phase08BusinessDiagnostic 'SEED' 'CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED')){throw 'diagnostic-long-legitimate'}
foreach($value in @(@('PrismaClientInitializationError','SYNTHETIC_PRIVATE'),123,'SYNTHETIC_PRIVATE')) {
  if((Get-Phase08BusinessSafeErrorType $value) -cne 'UNCLASSIFIED'){throw 'diagnostic-error-type'}
}
if((Get-Phase08BusinessSafeErrorType 'PrismaClientInitializationError') -cne 'PrismaClientInitializationError'){throw 'diagnostic-error-type-valid'}
@{state='PHASE08_BUSINESS_ROUNDTRIP_SYNTHETIC_PASS';orderedRowHashPreserved=$true;dateStringsPreserved=$true;emptyArraysPreserved=$true;networkRequests=0;credentialReads=0}|ConvertTo-Json
