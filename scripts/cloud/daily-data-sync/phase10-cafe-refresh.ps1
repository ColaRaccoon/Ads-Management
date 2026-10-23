Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$operation='20261019-phase10-refresh-a';$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence'
$stage='TARGET';$live=$null;$wire=$null;$child=$null
function Save-Refresh($value,[string]$name){$path=Join-Path $root ($name+'.json');$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}}
try {
 $marker=Join-Path $root 'cafe-refresh-attempt.json';if(Test-Path -LiteralPath $marker){throw 'CONSUMED_INSPECT_ACTUAL_STATE'}
 $live=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 if($live.serviceInstance.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $live.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $live.variables.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $live.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $live.variables.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime'){throw 'ISOLATED_IDENTITY'}
 Save-Refresh @{kind='PHASE10_CAFE_EXACT_REFRESH_PLANNED';operationKey=$operation;observedAt=[DateTimeOffset]::UtcNow.ToString('o');maximumTokenPosts=1;maximumOrderGets=0;expectedBeforeRevision=6;expectedAfterRevision=7;scope='mall.read_order';originalPairRestoreForbidden=$true} 'cafe-refresh-attempt'
 $stage='PROTECTED_CHILD';$psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 foreach($arg in @('node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json',"$PSScriptRoot/phase10-api-cafe-refresh.mjs")){$psi.ArgumentList.Add($arg)}
 $psi.Environment.Clear();foreach($key in @('PATH','SystemRoot','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA')){if([Environment]::GetEnvironmentVariable($key)){$psi.Environment[$key]=[Environment]::GetEnvironmentVariable($key)}}
 $child=[Diagnostics.Process]::Start($psi);$outputTask=$child.StandardOutput.ReadToEndAsync();$errorTask=$child.StandardError.ReadToEndAsync()
 $wire=@{classification='SAME_SCOPE_EXACT_PAIR_REFRESH_ONCE';projectRef='ehnfrrmbkvlsbpvqcvkr';operationKey=$operation;databaseUrl=$live.variables.DATABASE_URL;env=$live.variables}|ConvertTo-Json -Compress -Depth 25
 $child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
 if(-not $child.WaitForExit(55000)){$child.Kill($true);throw 'CHILD_TIMEOUT_INSPECT_BEFORE_RETRY'}
 $raw=$outputTask.GetAwaiter().GetResult();$null=$errorTask.GetAwaiter().GetResult()
 if($raw.Length -gt 16384){throw 'CHILD_BOUND'};$out=$raw|ConvertFrom-Json -AsHashtable -Depth 15;$raw=$null
 if($out.kind -cnotin @('PHASE10_EXISTING_ISOLATED_CAFE_PAIR_REFRESHED','PHASE10_CAFE_REFRESH_FAILED')){throw 'OUTPUT_SHAPE'}
 Save-Refresh $out 'cafe-refresh-result';$out|ConvertTo-Json -Depth 15
 if($child.ExitCode -ne 0){exit 1}
}catch{@{kind='PHASE10_CAFE_REFRESH_WRAPPER_FAILED';stage=$stage;inspectActualStateBeforeAnyRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{$wire=$null;$raw=$null;$live=$null;$out=$null;if($child){$child.Dispose()}}
