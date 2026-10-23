Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'scan-relay-live-logs.ps1'),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'parse'}
$fn=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-Phase08ReviewedLogDeployments'},$true));if($fn.Count -ne 1){throw 'function'};Invoke-Expression $fn[0].Extent.Text
$code="import{reviewedV18LogProfile,V18_LOG_SOURCE_SHA}from'./scripts/cloud/daily-data-sync/relay-log-v18-profile.mjs';import{ISOLATED_IDENTITY}from'./scripts/cloud/daily-data-sync/deployment-evidence.mjs';console.log(JSON.stringify(reviewedV18LogProfile({sourceSha:V18_LOG_SOURCE_SHA,deploymentId:'af7a6921-3307-4cf0-9f17-053c21ce3ff4',identity:ISOLATED_IDENTITY})));"
$value=(& node --input-type=module -e $code)|ConvertFrom-Json -AsHashtable -DateKind String;$pins=@{sourceSha=$value.sourceSha;deploymentId=$value.currentDeploymentId};$out=@(Get-Phase08ReviewedLogDeployments $value $pins);if($out.Count -ne 14){throw 'positive'}
foreach($mode in @('extra','type','duplicate','missing','foreign','pair','state-array')){
 $bad=$value|ConvertTo-Json -Depth 8 -Compress|ConvertFrom-Json -AsHashtable -DateKind String;$p=$pins.Clone()
 switch($mode){extra{$bad['raw']='SYNTHETIC_PRIVATE'};type{$bad.totalDeployments='14'};duplicate{$bad.deployments[0]=$bad.deployments[1]};missing{$bad.deployments=@($bad.deployments|Select-Object -Skip 1);$bad.totalDeployments=10};foreign{$bad.deployments[0]='11111111-1111-4111-8111-111111111111'};pair{$p.sourceSha='6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde';$bad.sourceSha=$p.sourceSha};state-array{$bad.state=@($bad.state)}}
 $failed=$false;try{$null=Get-Phase08ReviewedLogDeployments $bad $p}catch{$failed=$true};if(-not $failed){throw 'negative'}
}
@{state='V18_LOG_HISTORY_PROJECTION_PASSED';cases=8;remoteCalls=0}|ConvertTo-Json -Compress
