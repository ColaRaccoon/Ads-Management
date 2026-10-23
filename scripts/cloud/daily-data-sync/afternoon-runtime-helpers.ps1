# Definitions only; no credentials, requests or SQL run when sourced.
. "$PSScriptRoot/scheduler-live-helpers.ps1"
function Get-Phase08AfternoonRuntimeSnapshot {
 $p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/afternoon-runtime-snapshot.mjs" @{}
 if($p.state -cne 'PHASE08_AFTERNOON_RUNTIME_SNAPSHOT_SQL' -or $p.sql -isnot [string] -or -not $p.sql.StartsWith('BEGIN READ ONLY;')){throw 'snapshot-source'}
 $rows=@(Invoke-Phase08Management -Action Query -Query $p.sql);if($rows.Count -ne 1){throw 'snapshot-count'};$r=$rows[0]
 $names=@('database','principal','business_md5','stopped','tables','total_jobs','active_jobs','live_leases','outage_runs','outage_work_attempts','outage_inspections','outage_audits','original_history','collection_succeeded_units')
 $keys=if($r -is [Collections.IDictionary]){@($r.Keys)}else{@($r.PSObject.Properties.Name)}
 if($keys.Count -ne $names.Count -or @($keys|Where-Object {$_ -cnotin $names}).Count -ne 0){throw 'snapshot-shape'}
 if($r.database -cne 'postgres' -or $r.principal -cne 'postgres' -or $r.stopped -isnot [bool] -or $r.business_md5 -isnot [string] -or $r.business_md5 -cnotmatch '^[a-f0-9]{32}$' -or $r.original_history -cne 'c044e6c4249188e410d31aacf57422dc'){throw 'snapshot-identity'}
 foreach($n in @('tables','total_jobs','active_jobs','live_leases','outage_runs','outage_work_attempts','outage_inspections','outage_audits','collection_succeeded_units')){if(($r.$n -isnot [int] -and $r.$n -isnot [long]) -or $r.$n -lt 0 -or $r.$n -gt 10000){throw 'snapshot-type'}}
 if($r.tables -ne 68 -or $r.total_jobs -ne 149){throw 'snapshot-schema'}
 return $r
}
function Get-Phase08AfternoonRuntimeService($Pins){
 $r=Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!,$d:String!){serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId startCommand sleepApplication latestDeployment{id status canRedeploy} activeDeployments{id status}} deployment(id:$d){id status canRedeploy}}' @{e=$Pins.identity.environmentId;s=$Pins.identity.serviceId;d=$Pins.deploymentId}
 $s=$r.serviceInstance
 # Railway clears latestDeployment after removal. Only the explicitly pinned,
 # actually REMOVED deployment with zero active instances may fill that gap.
 if($null -eq $s.latestDeployment){
  if(@($s.activeDeployments).Count -ne 0 -or $r.deployment.id -cne $Pins.deploymentId -or $r.deployment.status -cne 'REMOVED' -or $r.deployment.canRedeploy -isnot [bool]){throw 'runtime-removed-service'}
  $s.latestDeployment=$r.deployment
 }
 if($s.serviceId -cne $Pins.identity.serviceId -or $s.environmentId -cne $Pins.identity.environmentId -or $s.startCommand -cne 'node deploy/cloud/phase08-launch.mjs' -or $s.sleepApplication -isnot [bool] -or -not $s.sleepApplication -or $s.latestDeployment.id -cne $Pins.deploymentId -or $s.latestDeployment.canRedeploy -isnot [bool]){throw 'runtime-service'}
 return $s
}
