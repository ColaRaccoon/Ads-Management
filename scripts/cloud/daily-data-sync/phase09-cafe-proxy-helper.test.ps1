# Synthetic helper-only validation. Loads function ASTs, never the live body.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'phase09-cafe-snapshot-proxy.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'helper-parse'}
foreach($name in @('Get-Phase09CafeProxyState','Get-Phase09CreatedProxyIdentity','Get-Phase09VariablesDigest')){
 $fn=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name})
 if($fn.Count -ne 1){throw 'function-not-found'}
 . ([scriptblock]::Create($fn[0].Extent.Text))
}
$project='d72f4256-8632-437a-9dae-9b5d96736fc7';$environment='d261a432-a6a4-4031-b8ea-c619ac263cc3';$service='ef46528f-4b59-4ee6-9d9c-b0852b5a9274'
$response=@{project=@{id=$project;services=@{edges=@(@{node=@{id=$service}})};environments=@{edges=@(@{node=@{id=$environment;unmergedChangesCount=0}})}};
 serviceInstance=@{serviceId=$service;environmentId=$environment;latestDeployment=@{id='synthetic-deployment'}};variables=@{SYNTHETIC_ONLY='placeholder'};tcpProxies=@()}
function Invoke-Phase08SchedulerGraph($Query,$Variables){return $response}
$passed=0
function Assert-SyntheticReject([scriptblock]$Action){$rejected=$false;try{& $Action|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'expected-rejection'}}
if(@((Get-Phase09CafeProxyState).tcpProxies).Count -ne 0){throw 'baseline'};$passed++
$response.project.environments.edges[0].node.unmergedChangesCount=1
Assert-SyntheticReject {Get-Phase09CafeProxyState};$passed++
$response.project.environments.edges[0].node.unmergedChangesCount=0
$response.project.environments.edges[0].node.unmergedChangesCount=$null
if(@((Get-Phase09CafeProxyState).tcpProxies).Count -ne 0){throw 'explicit-null-cli-default'};$passed++
$response.project.environments.edges[0].node.Remove('unmergedChangesCount')
Assert-SyntheticReject {Get-Phase09CafeProxyState};$passed++
$response.project.environments.edges[0].node.unmergedChangesCount=0
$response.serviceInstance.serviceId='wrong-target'
Assert-SyntheticReject {Get-Phase09CafeProxyState};$passed++
$response.serviceInstance.serviceId=$service
$response.tcpProxies=@(@{id='synthetic-proxy-id';serviceId=$service;environmentId=$environment;applicationPort=5432;deletedAt='2026-10-19T00:00:00Z';syncStatus='DELETED'})
if(@((Get-Phase09CafeProxyState).tcpProxies).Count -ne 0){throw 'deleted-history'};$passed++
$response.tcpProxies=@(@{id='synthetic-proxy-id';serviceId=$service;environmentId=$environment;applicationPort=5432;deletedAt=$null;syncStatus='DELETING'})
if(@((Get-Phase09CafeProxyState).tcpProxies).Count -ne 1){throw 'deleting-not-complete'};$passed++
$response.tcpProxies[0].deletedAt='2026-10-19T00:00:00Z'
if(@((Get-Phase09CafeProxyState).tcpProxies).Count -ne 1){throw 'deleting-with-timestamp-not-complete'};$passed++
$valid='{"applicationPort":5432,"staged":false,"committed":true,"proxy":{"id":"synthetic-proxy-id"}}'
if((Get-Phase09CreatedProxyIdentity $valid).id -cne 'synthetic-proxy-id'){throw 'committed-create'};$passed++
Assert-SyntheticReject {Get-Phase09CreatedProxyIdentity '{"id":"synthetic-proxy-id"}'};$passed++
Assert-SyntheticReject {Get-Phase09CreatedProxyIdentity '{"applicationPort":5432,"proxy":null}'};$passed++
Assert-SyntheticReject {Get-Phase09CreatedProxyIdentity '{"applicationPort":5432,"proxy":{"id":"short"}}'};$passed++
if((Get-Phase09VariablesDigest @{a='one';b='two'}) -cne (Get-Phase09VariablesDigest @{b='two';a='one'})){throw 'digest-order'};$passed++
@{kind='PHASE09_CAFE_PROXY_HELPERS_SYNTHETIC_PASS';passed=$passed;networkCalls=0;databaseWrites=0;liveBodyInvoked=$false}|ConvertTo-Json -Compress
