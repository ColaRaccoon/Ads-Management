Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cloud-consumers-readonly-v3-20261021.ps1"
function Check([bool]$Value){if(-not $Value){throw 'PURE_GUARD_FAILED'}}
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase10-cloud-consumers-readonly-v3-20261021.ps1'),[ref]$tokens,[ref]$errors);Check ($errors.Count -eq 0)
Check (@($ast.FindAll({param($n)$n -is [Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.UserPath -ceq 'matches'},$true)).Count -eq 0)
Add-Needle 'SYNTHETIC_GROUP' 'SYNTHETIC_PRIVATE_CANARY_1343'
$v=@{SECRET_A='SYNTHETIC_PRIVATE_CANARY_1343';PUBLIC_REF=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"x":"SYNTHETIC_PRIVATE_CANARY_1343"}'));UNRELATED='PUBLIC_ONLY'}
$consumerMatches=[Collections.Generic.List[object]]::new();$variablesRead=0
$loop=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq 'key' -and $n.Extent.Text.Contains('$classes=@(Test-ConsumerValue')},$true));Check ($loop.Count -eq 1)
& ([scriptblock]::Create($loop[0].Extent.Text))
Check ($consumerMatches -is [Collections.Generic.List[object]]);Check ($consumerMatches.Count -eq 2);Assert-IndependentIncidentOutput ($consumerMatches.ToArray()|ConvertTo-Json -Depth 8) $secrets
$edgeLoop=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Variable.VariablePath.UserPath -ceq 'row' -and $n.Extent.Text.Contains('$digest=$null')},$true));Check ($edgeLoop.Count -eq 1)
$digest=Get-IndependentIncidentStringHash 'SYNTHETIC_PRIVATE_CANARY_1343';$r=@{rows=@(@{name='A';value=$digest},@{name='B';digest=$digest},@{name='C'},@{name='D';value='NOT_A_DIGEST'})};$p=@{id='abcdefghijklmnopqrst'};$ref=$p.id
$edgeMatches=[Collections.Generic.List[object]]::new();$gaps=[Collections.Generic.List[object]]::new()
& ([scriptblock]::Create($edgeLoop[0].Extent.Text))
Check ($edgeMatches.Count -eq 2);Check ($gaps.Count -eq 2);Assert-IndependentIncidentOutput ($edgeMatches.ToArray()|ConvertTo-Json -Depth 8) $secrets
$out=@{kind='CLOUD_CONSUMER_V3_ACTUAL_PROJECTION_AST_GUARDS';status='PASS';checks=9;syntheticVariableMatches=2;syntheticDigestMatches=2;syntheticDigestGaps=2;sourceSha256=(Get-FileHash (Join-Path $PSScriptRoot 'phase10-cloud-consumers-readonly-v3-20261021.ps1')).Hash.ToLowerInvariant();remoteRequests=0;protectedReads=0;rawValuesReturned=0}
$path='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/consumer-readonly-1343/cloud-v3-pure-guards.json';$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($out|ConvertTo-Json));$f.Write($b,0,$b.Length)}finally{$f.Dispose()};$out|ConvertTo-Json -Compress
