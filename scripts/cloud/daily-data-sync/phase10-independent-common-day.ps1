Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$child=$null;$vars=$null;$inputValue=$null;$stage='TARGET'
try {
 Import-Phase08SchedulerChildDefinitions
 $live=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 $vars=$live.variables
 if($live.serviceInstance.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $live.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $vars.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $vars.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $vars.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or $vars.RELEASE_GIT_SHA -cne 'acbda3d65cff713650d317fa40e74764af46d2c0' -or $vars.PHASE08_SOURCE_CONTENT_SHA256 -cne '16d8fbd10b357847b7a1666762f2196b850e394bc0cdee6d15df68075c7a2743'){throw 'TARGET'}
 $envInput=@{};foreach($key in @('SUPABASE_DATABASE_SCHEMA','SUPABASE_DATABASE_RUNTIME_USER','DAILY_SYNC_FEATURE_ENABLED','DAILY_SYNC_SCHEDULE_ENABLED')){$envInput[$key]=$vars[$key]}
 $inputValue=@{projectRef='ehnfrrmbkvlsbpvqcvkr';day='2026-10-14';databaseUrl=$vars.DATABASE_URL;env=$envInput}
 $stage='READONLY_CHILD';$psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $utf8=[Text.UTF8Encoding]::new($false,$true);$psi.StandardInputEncoding=$utf8;$psi.StandardOutputEncoding=$utf8;$psi.StandardErrorEncoding=$utf8
 foreach($arg in @('node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json',"$PSScriptRoot/phase10-independent-common-day.mjs")){$psi.ArgumentList.Add($arg)}
 $psi.Environment.Clear();foreach($key in @('PATH','SystemRoot','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA')){if([Environment]::GetEnvironmentVariable($key)){$psi.Environment[$key]=[Environment]::GetEnvironmentVariable($key)}}
 $child=[Diagnostics.Process]::Start($psi);$outTask=$child.StandardOutput.ReadToEndAsync();$errorTask=$child.StandardError.ReadToEndAsync()
 $wire=$inputValue|ConvertTo-Json -Compress -Depth 8;$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
 if(-not $child.WaitForExit(45000)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
 $raw=$outTask.GetAwaiter().GetResult();$null=$errorTask.GetAwaiter().GetResult();if($raw.Length -gt 32768){throw 'CHILD_OUTPUT_BOUND'}
 $out=$raw|ConvertFrom-Json -AsHashtable -Depth 20;$raw=$null
 if($child.ExitCode -ne 0){if($out.kind -ceq 'PHASE10_INDEPENDENT_COMMON_DAY_FAILED'){$out|ConvertTo-Json -Compress;exit 1};throw 'CHILD_FAILED'}
 if($out.kind -cne 'PHASE10_INDEPENDENT_COMMON_DAY_REAL_DB' -or $out.databaseWrites -ne 0 -or $out.providerRequests -ne 0 -or $out.rawUserRowsReturned -ne 0 -or $out.allComparedValuesExact -cne $true){throw 'OUTCOME'}
 $out.actualDeploymentId=$live.serviceInstance.latestDeployment.id;$out.actualDeploymentStatus=$live.serviceInstance.latestDeployment.status;$out.actualAppHttpRequests=0
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/common-day-20261014.json';$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=$utf8.GetBytes(($out|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 @{kind=$out.kind;day=$out.day;reference=$out.reference;actualTotals=$out.actual.totals;allComparedValuesExact=$true;evidencePath=$path;appHttpRequests=0;providerRequests=0;databaseWrites=0}|ConvertTo-Json -Depth 10
}catch{@{kind='PHASE10_INDEPENDENT_COMMON_DAY_PARENT_REJECTED';stage=$stage;providerRequests=0;databaseWrites=0;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()};$vars=$null;$live=$null;$inputValue=$null;$wire=$null;$raw=$null}
