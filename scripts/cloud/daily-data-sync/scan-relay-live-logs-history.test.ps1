Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'scan-relay-live-logs.ps1'),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'parse'}
$node=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if($IncludeOctober15Deployments)')},$true));if($node.Count -ne 1){throw 'one-history-profile'}
$history=[scriptblock]::Create($node[0].Extent.Text+"`nreturn ,`$deployments")
$script:n=0;function Check($v){$script:n++;if(-not $v){throw 'synthetic'}}
function Run($sha,$id){$pins=[pscustomobject]@{sourceSha=$sha;deploymentId=$id};$IncludeOctober15Deployments=$true;$deployments=@($id);&$history}
$sha='d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21';$id='5dac048f-5015-46fa-8ca4-5227352c834c';$rows=Run $sha $id
$expected=@('e71e73ea-838f-45d3-a19d-32033d3d7391','a0045206-20f8-4982-be2c-35505cbd3870','56ed1723-ba91-4cdd-a335-f0e241cc180c','86d5ad6d-eec8-414a-a922-9c6b8c62a245','ee97acf7-bce3-4134-a639-2f80cc4f310a','a35d7507-2044-41f5-9f91-fd4838ad0d28','5dac048f-5015-46fa-8ca4-5227352c834c')
Check ($rows.Count -eq 7 -and ($rows -join '|') -ceq ($expected -join '|'));Check (@($rows|Select-Object -Unique).Count -eq 7)
foreach($pair in @(@(('a'*64),$id),@($sha,'a35d7507-2044-41f5-9f91-fd4838ad0d28'))){$failed=$false;try{Run $pair[0] $pair[1]|Out-Null}catch{$failed=$true};Check $failed}
$text=$ast.Extent.Text;Check ($text.Contains('limit:5000') -and $text.Contains('$offset -lt 1000') -and $text.Contains('$offset+=25') -and $text.Contains('Start-Sleep -Seconds 10') -and $text.Contains('$logBytes -gt 1048576'))
@{state='PHASE08_LOG_HISTORY_V12_SYNTHETIC_PASS';assertions=$script:n;historyDeployments=7;network=0;providerRequests=0}|ConvertTo-Json -Compress
