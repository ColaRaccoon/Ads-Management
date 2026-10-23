$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase10-resume-storage-readcheck-20261020.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'AST'}
$fn=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Get-ReadcheckClassification'});if($fn.Count -ne 1){throw 'FUNCTION'}
Invoke-Expression $fn[0].Extent.Text
$cases=@(
 @(200,200,403,200,$true,'READ_CACHE_RESIDUAL_STILL_PRESENT'),
 @(401,200,403,200,$true,'NO_CACHED_RESIDUAL_OBSERVED_AT_THIS_URL'),
 @(404,200,404,200,$true,'NO_CACHED_RESIDUAL_OBSERVED_AT_THIS_URL'),
 @(500,200,403,200,$true,'INCONCLUSIVE_HTTP'),
 @(429,200,403,200,$true,'INCONCLUSIVE_HTTP'),
 @(401,401,403,200,$true,'INCONCLUSIVE_HTTP'),
 @(401,200,500,200,$true,'INCONCLUSIVE_HTTP'),
 @(401,200,403,500,$true,'INCONCLUSIVE_HTTP'),
 @(401,200,403,200,$false,'INCONCLUSIVE_HTTP'),
 @(200,200,200,200,$true,'OLD_BEARER_READ_ALLOWED_ORIGIN_DENIAL_UNPROVEN'),
 @(200,500,500,500,$false,'OLD_BEARER_READ_ALLOWED_ORIGIN_DENIAL_UNPROVEN')
)
foreach($c in $cases){$d=@{checks=@(@{name='old_bare_native_fetch';status=$c[0];contentMatchesExpectedSentinel=$true},@{name='new_bare_native_fetch';status=$c[1];contentMatchesExpectedSentinel=$c[4]},@{name='old_no_cache_unique_query';status=$c[2];contentMatchesExpectedSentinel=$true},@{name='new_no_cache_unique_query';status=$c[3];contentMatchesExpectedSentinel=$c[4]})};$r=Get-ReadcheckClassification $d;if($r.status -cne $c[5]){throw 'HTTP_CLASSIFICATION'}}
@{kind='STORAGE_READCHECK_HTTP_CLASSIFICATION_TEST';pass=$cases.Count;remoteRequests=0;protectedReads=0}|ConvertTo-Json -Compress
