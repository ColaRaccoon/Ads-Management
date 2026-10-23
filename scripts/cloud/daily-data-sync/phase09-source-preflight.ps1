Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='GRAPH'
try {
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){project(id:$p){id services{edges{node{id}}}} variables(projectId:$p,environmentId:$e,serviceId:$s) tcpProxies(environmentId:$e,serviceId:$s){serviceId environmentId applicationPort proxyPort domain}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='ef46528f-4b59-4ee6-9d9c-b0852b5a9274'}
 if($r.project.id -cne 'd72f4256-8632-437a-9dae-9b5d96736fc7' -or @($r.project.services.edges|Where-Object {$_.node.id -ceq 'ef46528f-4b59-4ee6-9d9c-b0852b5a9274'}).Count -ne 1){throw 'target'}
 $stage='CHILD'
 $stage='PROXY'
 $proxy=@($r.tcpProxies|Where-Object {$_.serviceId -ceq 'ef46528f-4b59-4ee6-9d9c-b0852b5a9274' -and $_.environmentId -ceq 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -and $_.applicationPort -eq 5432})
 if($proxy.Count -ne 1){throw 'existing-tcp-proxy'}
 $stage='URL'
 $url=[UriBuilder]::new($r.variables.DATABASE_URL);$url.Host=$proxy[0].domain;$url.Port=$proxy[0].proxyPort
 $stage='SEND_CHILD'
 $payload=@{projectId=$r.project.id;serviceId='ef46528f-4b59-4ee6-9d9c-b0852b5a9274';url=$url.Uri.AbsoluteUri}|ConvertTo-Json -Compress
 $payload | & 'C:/Program Files/nodejs/node.exe' 'node_modules/tsx/dist/cli.mjs' --tsconfig apps/api/tsconfig.json "$PSScriptRoot/phase09-source-preflight.mts" 2>$null
 if($LASTEXITCODE -ne 0){exit 1}
}catch{@{kind='PHASE09_CAFE_SOURCE_PREFLIGHT_FAILED';stage=$stage;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$payload=$null;$r=$null;$url=$null}
