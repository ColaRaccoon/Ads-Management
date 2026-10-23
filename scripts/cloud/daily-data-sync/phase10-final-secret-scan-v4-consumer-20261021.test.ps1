Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot 'phase10-final-secret-scan-v4-consumer-20261021.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'PARSE_ERRORS'}
$function=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Test-IndependentIncidentSecretText'},$true))
if($function.Count -ne 1){throw 'FUNCTION_COUNT'}
. ([scriptblock]::Create($function[0].Extent.Text))
$passed=0
function Check([bool]$Value){if(-not $Value){throw 'PURE_GUARD'};$script:passed++}
$canary='SYNTHETIC_CONSUMER_LITERAL_NOT_A_REAL_SECRET_1343'
$r=Test-IndependentIncidentSecretText ('a'+$canary+'b') @($canary);Check ($r.literalMatchCount -eq 1)
$r=Test-IndependentIncidentSecretText 'public metadata only' @($canary);Check ($r.literalMatchCount -eq 0 -and $r.patternMatchCount -eq 0)
$r=Test-IndependentIncidentSecretText ('sb_secret_'+('X'*32)) @();Check ($r.patternMatchCount -eq 1)
$r=Test-IndependentIncidentSecretText ('postgresql://test:'+('X'*40)+'@example.invalid/db') @();Check ($r.patternMatchCount -eq 1)
$r=Test-IndependentIncidentSecretText $canary @($canary);Check (-not (($r|ConvertTo-Json -Compress).Contains($canary)))
$selector=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if($file.Name -match')},$true))
Check ($selector.Count -eq 1)
foreach($sample in @(@('consumers-localreadonly21.ps1','.ps1',$true),@('consumer-meta-readonly-v3-20261021.mjs','.mjs',$true),@('phase10-independent-google-consumers-v3-20261021.py','.py',$true),@('phase10-independent-google-consumers-v3-20261021.pyc','.pyc',$false))){
 $files=[Collections.Generic.HashSet[string]]::new();$file=[pscustomobject]@{Name=$sample[0];Extension=$sample[1];FullName=('C:/synthetic/'+$sample[0])}
 & ([scriptblock]::Create($selector[0].Extent.Text));Check (($files.Count -eq 1) -ceq $sample[2])
}
Check ($ast.Extent.Text.Contains("@('continuation-20261021','continuation21','independent/resume-20261021')"))
Check ($ast.Extent.Text.Contains("`$Label='resume-20261021-consumer-secret-scan-v4'"))
$oldTokens=$null;$oldErrors=$null;$old=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase10-final-secret-scan-v2-20261021.ps1'),[ref]$oldTokens,[ref]$oldErrors)
$oldFunction=@($old.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Test-IndependentIncidentSecretText'},$true))
Check ($oldFunction.Count -eq 1 -and $oldFunction[0].Extent.Text -ceq $function[0].Extent.Text)
$proof=@{kind='CONSUMER_V4_SECRET_SCAN_SOURCE_VALIDATION';status='PASS_SOURCE_AND_PURE_ONLY';at=[DateTimeOffset]::UtcNow.ToString('o');passed=$passed;parserErrors=0;guardFunctionUnchanged=$true;consumerTwoPrefixesIncluded=$true;pythonSourceIncluded=$true;continuation21RootIncluded=$true;newUniqueLabel=$true;protectedReads=0;remoteRequests=0;actualScanExecuted=$false;sourceSha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();generatorSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'phase10-scan-consumer-v4-tools-20261021.mjs') -Algorithm SHA256).Hash.ToLowerInvariant();baseV2Sha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'phase10-final-secret-scan-v2-20261021.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()}
$destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/consumer-readonly-1343/google-scan-v4-source-validation-v1.json'
$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($proof|ConvertTo-Json -Depth 10));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
@{status=$proof.status;passed=$passed;path=$destination;sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant();protectedReads=0;remoteRequests=0}|ConvertTo-Json -Compress
