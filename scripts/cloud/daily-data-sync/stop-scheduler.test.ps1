Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'stop-scheduler.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse'}
$main=@($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($main.Count -ne 1){throw 'main'}
$fixture=@'
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$submitted=$false;$stage='READONLY_IDENTITY';$sql=$null;$script:writes=0;$script:reads=0;$script:builds=0;$script:snapshots=0
function Import-Phase08SchedulerChildDefinitions {}
function Invoke-Phase08Management {
 param($Action,$Query)
 if($Action -cne 'Query'){throw 'action'}
 if($Query -match '^BEGIN READ ONLY;'){
  $script:reads++
  if($Query -match 'current_database'){return [pscustomobject]@{database='postgres';role=$(if($Scenario -ceq 'wrong-role'){'foreign'}else{'postgres'})}}
  if($Query -match 'SELECT stopped'){return [pscustomobject]@{stopped=$(if($Scenario -ceq 'readback-type'){'true'}else{$true})}}
  throw 'readonly-query'
 }
 if($Query -cne 'BEGIN; SELECT fixed; COMMIT;'){throw 'single-batch'}
 $script:writes++;if($script:writes -gt 1 -or $Mode -ceq 'status' -or $Scenario -ceq 'wrong-role'){throw 'mutation-or-retry'};return @()
}
function Invoke-Phase08SchedulerNode {
 param($Value)
 if($Value.action -cne 'build' -or $Value.mode -cne $Mode -or $Mode -ceq 'status'){throw 'builder'}
 if($Value.mode -ceq 'pause' -and (($Value.definitions.key -join ',') -cne 'phase08-cafe24,phase08-google,phase08-meta')){throw 'pause-key-scope'}
 $script:builds++;return @{state='PHASE08_BATCH_PREPARED';sql='BEGIN; SELECT fixed; COMMIT;'}
}
function Get-Phase08SchedulerSnapshot {
 if($Mode -ceq 'kill'){throw 'broken-metadata-kill-must-not-read'}
 $script:snapshots++
 $paused=$script:snapshots -gt 1 -and $Mode -ceq 'pause'
 $digest=if($Scenario -ceq 'preservation' -and $script:snapshots -gt 1){'b'}else{'a'}
 return @{preserved_schema_digest=$digest;other_cron_digest='a';snapshot=@{installed=$true;settings=@(@{targetId='phase08-full-app';origin='https://phase08-daily-data-sync-production.up.railway.app';stopped=$true});schedules=@('phase08-cafe24','phase08-google','phase08-meta'|ForEach-Object {@{key=$_;paused=$paused}});jobs=@(1..149|ForEach-Object {@{active=(-not $paused)}})}}
}
'@
$cases=@(@{mode='kill';scenario='normal';success=$true},@{mode='kill';scenario='wrong-role';success=$false},@{mode='kill';scenario='readback-type';success=$false},@{mode='pause';scenario='normal';success=$true},@{mode='pause';scenario='preservation';success=$false},@{mode='status';scenario='normal';success=$true})
foreach($case in $cases){
 $code=$fixture+"`n"+'$Mode='''+$case.mode+''';$Scenario='''+$case.scenario+"';`n"+$main[0].Extent.Text
 $psi=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source);$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $psi.ArgumentList.Add('-NoProfile');$psi.ArgumentList.Add('-EncodedCommand');$psi.ArgumentList.Add([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code)))
 $child=[Diagnostics.Process]::Start($psi);$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync()
 try{if(-not $child.WaitForExit(15000)){$child.Kill($true);throw 'timeout'}
  $raw=$out.GetAwaiter().GetResult();$discard=$err.GetAwaiter().GetResult()
  if($raw.Contains('SYNTHETIC_PRIVATE') -or $discard.Contains('SYNTHETIC_PRIVATE')){throw 'raw-diagnostic'}
  $result=$raw|ConvertFrom-Json -DateKind String
  if($case.success){if($child.ExitCode -ne 0 -or $result.state -cne 'PHASE08_SCHEDULER_STOP_STATUS_VERIFIED'){throw 'success'}
   if($case.mode -ceq 'pause' -and ($result.jobs -ne 149 -or $result.activeJobs -ne 0 -or $result.pausedSchedules -ne 3)){throw 'pause-counts'}
   if($result.applicationFlagChanged -or $result.inflightHttpCancelled -or $result.retryPerformed){throw 'scope'}
  }else{if($child.ExitCode -eq 0 -or $result.state -cne 'PHASE08_SCHEDULER_STOP_STATUS_FAILED' -or $result.retryPerformed){throw 'failure'}
   if($case.scenario -ceq 'wrong-role' -and $result.outcomeUncertain){throw 'mutation-before-identity'}
   if($case.scenario -ceq 'preservation' -and -not $result.outcomeUncertain){throw 'uncertain'}
  }
 }finally{$child.Dispose()}
}
@{state='PHASE08_SCHEDULER_STOP_SYNTHETIC_PASS';cases=$cases.Count;actualNetworkCalls=0;actualSecretReads=0}|ConvertTo-Json -Compress
