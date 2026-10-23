Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$phase08Ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-cloud-portable-smoke.ps1'),[ref]$null,[ref]$null)
$phase08Function=$phase08Ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Convert-Phase08SmokeLogSummary'},$true)
if($phase08Function.Count -ne 1){throw 'TEST_FUNCTION_MISSING'}
Invoke-Expression $phase08Function[0].Extent.Text
$phase08SyntheticSecret='SYNTHETIC_SECRET_NEVER_EMIT'
$phase08Value=[ordered]@{state='PORTABLE_METADATA_VERIFIED';googleState='GOOGLE_METADATA_VERIFIED';metaState='META_METADATA_VERIFIED';providerRequests=@{googleAdsPost=1;metaGraphGet=3;googleSdkFetchObserved=0};googleSdkRequestsFullyObserved=$false;datedStatsRequests=0;mcpInsightsRequests=0;dbWrites=0}
function Assert-Test($condition){if(-not $condition){throw 'PHASE08_SYNTHETIC_ASSERT_FAILED'}}
$phase08Attributes=@(foreach($key in $phase08Value.Keys){[pscustomobject]@{key=$key;value=($phase08Value[$key]|ConvertTo-Json -Compress)}})
$phase08Attributes+=[pscustomobject]@{key='rawToken';value=$phase08SyntheticSecret}
$phase08Structured=[pscustomobject]@{message=$phase08SyntheticSecret;attributes=$phase08Attributes}
$phase08Result=Convert-Phase08SmokeLogSummary $phase08Structured
Assert-Test ($phase08Result.state -ceq 'PORTABLE_METADATA_VERIFIED' -and $phase08Result.providerRequests.metaGraphGet -eq 3)
Assert-Test (-not ($phase08Result|ConvertTo-Json -Depth 8).Contains($phase08SyntheticSecret))
$phase08Raw=[pscustomobject]@{message=($phase08Value|ConvertTo-Json -Depth 5 -Compress);attributes=@([pscustomobject]@{key='unrelated';value=$phase08SyntheticSecret})}
Assert-Test ((Convert-Phase08SmokeLogSummary $phase08Raw).providerRequests.googleAdsPost -eq 1)
Assert-Test ($null -eq (Convert-Phase08SmokeLogSummary ([pscustomobject]@{message=$phase08SyntheticSecret;attributes=@([pscustomobject]@{key='unrelated';value=$phase08SyntheticSecret})})))
Assert-Test ((Convert-Phase08SmokeLogSummary ([pscustomobject]@{message='{"state":"PORTABLE_SMOKE_TIMEOUT","raw":"SYNTHETIC_SECRET_NEVER_EMIT"}'})).Keys.Count -eq 1)
foreach($phase08Invalid in @(
  [pscustomobject]@{message='';attributes=@([pscustomobject]@{key='state';value='"PORTABLE_METADATA_VERIFIED"'})},
  [pscustomobject]@{message='';attributes=@($phase08Attributes+[pscustomobject]@{key='state';value='"PORTABLE_METADATA_VERIFIED"'})},
  [pscustomobject]@{message='{"state":"PORTABLE_METADATA_VERIFIED","googleState":"WRONG","metaState":"META_METADATA_VERIFIED","googleSdkRequestsFullyObserved":false,"datedStatsRequests":0,"mcpInsightsRequests":0,"dbWrites":0,"providerRequests":{"googleAdsPost":1,"metaGraphGet":3,"googleSdkFetchObserved":0}}'}
)) {
  $phase08Rejected=$false
  try{$phase08Discard=Convert-Phase08SmokeLogSummary $phase08Invalid}catch{$phase08Rejected=$true}
  Assert-Test $phase08Rejected
}
$phase08Source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'run-cloud-portable-smoke.ps1'))
Assert-Test ($phase08Source -notmatch 'deploymentRedeploy\(' -and $phase08Source.Contains('limit:300') -and -not $phase08Source.Contains('filter:"PORTABLE_"'))
Assert-Test ($phase08Source -notmatch 'startCommand=\$null' -and $phase08Source.Contains("'node deploy/cloud/phase08-launch.mjs'") -and $phase08Source.Contains("throw 'command-readback'"))
[ordered]@{state='PHASE08_SMOKE_LOG_SYNTHETIC_PASS';cases=9;networkRequests=0;credentialReads=0}|ConvertTo-Json
