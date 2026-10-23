# Read only one fixed recovery deployment; never persist raw log or credential values.
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='IDENTITY';$live=$null;$logs=$null;$context=$null;$values=$null
try{
 Import-Phase08SchedulerChildDefinitions
 $p='d72f4256-8632-437a-9dae-9b5d96736fc7';$e='d261a432-a6a4-4031-b8ea-c619ac263cc3';$s='4b30daa8-9333-46b7-ad89-cfd64ff5266c';$id='004241ae-ff50-4d0c-b179-3663448bb378'
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/recovery-20261019';$output="$root/log-scan.json"
 if(Test-Path -LiteralPath $output){throw 'RECEIPT_EXISTS'}
 $live=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p=$p;e=$e;s=$s}
 if($live.serviceInstance.serviceId -cne $s -or $live.serviceInstance.environmentId -cne $e -or $live.serviceInstance.latestDeployment.id -cne $id -or $live.serviceInstance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $live.variables.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $live.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads'){throw 'IDENTITY'}
 $stage='BOUNDED_CLI_LOGS'
 $start=[Diagnostics.ProcessStartInfo]::new('C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe');$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 foreach($a in @('logs',$id,'--project',$p,'--environment',$e,'--service',$s,'--lines','800','--json')){$start.ArgumentList.Add($a)}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start;$null=$process.Start();$out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
 if(-not $process.WaitForExit(30000)){$process.Kill($true);throw 'LOG_TIMEOUT'}
 $wire=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($process.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetByteCount($wire) -gt 700000){throw 'LOG_BOUND'}
 $logs=@($wire -split "`n"|Where-Object {$_.Trim()}|ForEach-Object {$_|ConvertFrom-Json -AsHashtable -Depth 15});$wire=$null
 $context=Read-Phase08ProtectedJson;$values=$live.variables;$values.RECOVERY_PREVIOUS_STORAGE_TOKEN=$context.env.SUPABASE_STORAGE_ACCESS_TOKEN
 $stage='READONLY_KNOWN_SECRET_SCAN';$proof=Invoke-Phase08ConfigurationChild "$PSScriptRoot/scan-deployment-secrets.mjs" @{env=$values;projectRef='ehnfrrmbkvlsbpvqcvkr';connectionId='0c35defe-45fc-4a54-bc79-704df7bca5b1';logs=$logs;logsComplete=($logs.Count -lt 800)}
 if($proof.state -cne 'PHASE08_SECRET_SCAN_COMPLETE' -or $proof.matchDetected -cne $false -or $proof.complete -cne $true -or $proof.rawValuesReturned -ne 0){throw 'SCAN_NOT_CLEAN'}
 $result=@{kind='PHASE08_RECOVERY_DEPLOYMENT_LOG_SCAN';observedAt=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$id;scan=$proof;rawLogsPersisted=$false;scope='FIXED_DEPLOYMENT_RETURNED_LOGS_ONLY';oldAndNewStorageTokensIncluded=$true;providerRequests=0;databaseWrites=0;operatingChanges=0}
 $bytes=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 10));$file=[IO.File]::Open($output,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$file.Write($bytes,0,$bytes.Length)}finally{$file.Dispose()}
 $result|ConvertTo-Json -Depth 10
}catch{@{kind='PHASE08_RECOVERY_LOG_SCAN_REJECTED';stage=$stage;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{$live=$null;$logs=$null;$context=$null;$values=$null;$wire=$null;$out=$null;$err=$null;if($process){$process.Dispose()}}
