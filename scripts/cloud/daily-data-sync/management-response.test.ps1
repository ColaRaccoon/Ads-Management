Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# Original function only; neither credential reader nor any executable body loads.
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'protected-context.ps1'),[ref]$tokens,[ref]$errors)
$fn=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Invoke-Phase08Management'})
if($errors.Count -or $fn.Count -ne 1){throw 'fixture-function'}
function Get-Phase08SupabaseCredential {return 'SYNTHETIC_ONLY_NO_REAL_CREDENTIAL'}
$script:httpCalls=0
function Invoke-WebRequest {
 param($Headers,$MaximumRedirection,$TimeoutSec,$SkipHttpErrorCheck,$ErrorAction,$Body,$ContentType,$Uri,$Method)
 if($Uri -cne 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/database/query' -or $MaximumRedirection -ne 0 -or $Method -cne 'Post'){throw 'fixed-target'}
 $script:httpCalls++
 return [pscustomobject]@{StatusCode=201;Content='[{"anchorAt":"2026-10-14T17:00:00.000Z","fromDate":"2026-10-14","count":149,"paused":true}]'}
}
# Legacy automatic timestamp conversion changed the public anchor on JSON roundtrip.
. ([scriptblock]::Create($fn[0].Extent.Text.Replace(' -DateKind String','')))
$legacy=Invoke-Phase08Management -Action Query -Query 'BEGIN READ ONLY; SELECT 1; COMMIT;'
if($legacy.anchorAt -is [string]){throw 'legacy-not-reproduced'}
. ([scriptblock]::Create($fn[0].Extent.Text))
$actual=Invoke-Phase08Management -Action Query -Query 'BEGIN READ ONLY; SELECT 1; COMMIT;'
if($actual.anchorAt -isnot [string] -or $actual.anchorAt -cne '2026-10-14T17:00:00.000Z' -or $actual.fromDate -cne '2026-10-14' -or $actual.count -ne 149 -or $actual.paused -isnot [bool]){throw 'exact-json-roundtrip'}
$roundtrip=$actual|ConvertTo-Json -Compress|ConvertFrom-Json -DateKind String
if($roundtrip.anchorAt -cne '2026-10-14T17:00:00.000Z'){throw 'readback-anchor'}
@{state='PHASE08_MANAGEMENT_RESPONSE_SYNTHETIC_PASS';cases=3;mockHttpCalls=$script:httpCalls;actualNetworkCalls=0;actualProtectedReads=0}|ConvertTo-Json -Compress
