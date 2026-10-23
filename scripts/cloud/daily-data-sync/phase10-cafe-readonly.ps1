param([ValidateSet('ARCHIVED_CHECKPOINT_READONLY','CURRENT_SINGLE_ITEM_READONLY')][string]$Classification)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='TARGET';$inputValue=$null;$live=$null
try {
 Import-Phase08SchedulerChildDefinitions
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence/cafe-'+$Classification+'.json'
 if(Test-Path -LiteralPath $path){throw 'RECEIPT_EXISTS'}
 $live=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 if($live.serviceInstance.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $live.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $live.variables.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $live.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $live.variables.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime'){throw 'ISOLATION'}
 $inputValue=@{classification=$Classification;projectRef='ehnfrrmbkvlsbpvqcvkr';freshVerified=$true;databaseUrl=$live.variables.DATABASE_URL;env=$live.variables}
 $stage='REVIEWED_CHILD'
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
 $psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 foreach($arg in @('node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json',"$PSScriptRoot/phase10-api-cafe-diagnostic.mjs")){$psi.ArgumentList.Add($arg)}
 $psi.Environment.Clear();foreach($key in @('PATH','SystemRoot','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA')){if([Environment]::GetEnvironmentVariable($key)){$psi.Environment[$key]=[Environment]::GetEnvironmentVariable($key)}}
 $child=[Diagnostics.Process]::Start($psi);$outputTask=$child.StandardOutput.ReadToEndAsync();$errorTask=$child.StandardError.ReadToEndAsync()
 try {
  $wire=$inputValue|ConvertTo-Json -Compress -Depth 25;$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
  if(-not $child.WaitForExit(45000)){$child.Kill($true);throw 'CHILD_TIMEOUT'}
  $raw=$outputTask.GetAwaiter().GetResult();$null=$errorTask.GetAwaiter().GetResult()
  if($raw.Length -gt 16384){throw 'CHILD_BOUND'}
  $out=$raw|ConvertFrom-Json -AsHashtable -Depth 15;$raw=$null
  if($out.kind -ceq 'PHASE10_CAFE_DIAGNOSTIC_FAILED'){
   if($out.stage -cnotin @('TARGET','ARCHIVED_READONLY','OFFLINE_NORMALIZE','CURRENT_SINGLE_ITEM') -or $out.providerRequests -notin @(0,1) -or $out.databaseWrites -ne 0 -or $out.credentialRefreshes -ne 0){throw 'UNKNOWN_DIAGNOSTIC'}
   $failurePath=$path.Replace('.json','-failure.json');$json=$out|ConvertTo-Json -Depth 10
   $stream=[IO.File]::Open($failurePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
   try{$bytes=[Text.Encoding]::UTF8.GetBytes($json);$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
   $json;exit 1
  }
 }finally{$wire=$null;$raw=$null;$child.Dispose()}
 if($out.kind -cne 'PHASE10_ARCHIVED_CAFE_FAILURE_DIAGNOSTIC' -or $out.databaseWrites -ne 0 -or $out.credentialRefreshes -ne 0 -or $out.checkpointResumed -ne $false -or $out.providerRequests -ne $(if($Classification -ceq 'ARCHIVED_CHECKPOINT_READONLY'){0}else{1})){throw 'DIAGNOSTIC_NOT_VERIFIED'}
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($out|ConvertTo-Json -Depth 15));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $out|ConvertTo-Json -Depth 15
}catch{@{kind='PHASE10_CAFE_READ_REJECTED';stage=$stage;rawErrorSuppressed=$true;automaticRetry=$false}|ConvertTo-Json;exit 1}
finally{$inputValue=$null;$live=$null;$out=$null}
