# Explicit read-only diagnosis of pinned 06 metadata; no live wrapper body.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$vars=@{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='ef46528f-4b59-4ee6-9d9c-b0852b5a9274'}
$checks=@();$mutations=0
foreach($entry in @(
 @{name='BASE_IDENTITY';query='query($p:String!,$e:String!,$s:String!){project(id:$p){id services{edges{node{id}}}} serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}} tcpProxies(environmentId:$e,serviceId:$s){id serviceId environmentId applicationPort}}'},
 @{name='ENVIRONMENT_METADATA';query='query($p:String!){project(id:$p){id environments{edges{node{id unmergedChangesCount}}}}}'},
 @{name='PROXY_METADATA';query='query($e:String!,$s:String!){tcpProxies(environmentId:$e,serviceId:$s){id serviceId environmentId applicationPort deletedAt syncStatus}}'},
 @{name='VARIABLE_PRESENCE';query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}'}
)){
 $value=$null
 try{
  $selected=if($entry.name -ceq 'ENVIRONMENT_METADATA'){@{p=$vars.p}}elseif($entry.name -ceq 'PROXY_METADATA'){@{e=$vars.e;s=$vars.s}}else{$vars}
  $value=Invoke-Phase08SchedulerGraph $entry.query $selected
  switch($entry.name){
   'BASE_IDENTITY'{
    $checks+=@{check=$entry.name;graphSucceeded=$true;projectMatches=($value.project.id -ceq $vars.p);
     serviceMatches=@($value.project.services.edges|Where-Object {$_.node.id -ceq $vars.s}).Count;
     instanceMatches=($value.serviceInstance.serviceId -ceq $vars.s -and $value.serviceInstance.environmentId -ceq $vars.e);
     deploymentPresent=($null -ne $value.serviceInstance.latestDeployment);proxyRecords=@($value.tcpProxies).Count;
     wrongProxyTargets=@($value.tcpProxies|Where-Object {$_.serviceId -cne $vars.s -or $_.environmentId -cne $vars.e -or $_.applicationPort -ne 5432}).Count}
   }
   'ENVIRONMENT_METADATA'{
    $envRows=@($value.project.environments.edges|Where-Object {$_.node.id -ceq $vars.e})
    $checks+=@{check=$entry.name;graphSucceeded=$true;exactEnvironmentCount=$envRows.Count;
     countIsNull=($envRows.Count -eq 1 -and $null -eq $envRows[0].node.unmergedChangesCount);
     unmergedChangesCount=if($envRows.Count -eq 1){$envRows[0].node.unmergedChangesCount}else{$null}}
   }
   'PROXY_METADATA'{
    $checks+=@{check=$entry.name;graphSucceeded=$true;proxyRecords=@($value.tcpProxies).Count;
     liveProxyRecords=@($value.tcpProxies|Where-Object {$_.syncStatus -ceq 'DELETING' -or ($null -eq $_.deletedAt -and $_.syncStatus -cne 'DELETED')}).Count}
   }
   'VARIABLE_PRESENCE'{$checks+=@{check=$entry.name;graphSucceeded=$true;databaseUrlPresent=($value.variables.ContainsKey('DATABASE_URL') -and $value.variables.DATABASE_URL -is [string]);variableCount=$value.variables.Count}}
  }
 }catch{$checks+=@{check=$entry.name;graphSucceeded=$false;rawErrorSuppressed=$true}}
 finally{$value=$null;$selected=$null}
}
$result=@{kind='PHASE09_CAFE_PROXY_READONLY_DIAGNOSIS';observedAt=[DateTimeOffset]::UtcNow.ToString('o');checks=$checks;mutations=$mutations;tcpCreateCalls=0;databaseConnections=0;providerCalls=0}
$path='C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation/proxy06-diagnosis-20261019.json'
$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($result|ConvertTo-Json -Compress -Depth 10));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose();$bytes=$null}
$result|ConvertTo-Json -Compress -Depth 10
