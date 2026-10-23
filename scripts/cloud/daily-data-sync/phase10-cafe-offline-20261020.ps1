# Definitions are loaded; none of the remote functions is called.
$ErrorActionPreference='Stop'
. "$PSScriptRoot/incident-common.ps1"
$baseline=$null;$plan=$null;$inputValue=$null;$child=$null;$text=$null
try{
 $baseline=Read-IncidentPrivate 'compromised-baseline'
 $plan=Read-IncidentPrivate 'crypto-plan-20261019-crypto-rotation-a'
 $evidence=@{};foreach($name in @('DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES','DAILY_SYNC_CAFE24_VERIFIED_NORMAL_STATUSES','DAILY_SYNC_CAFE24_PAYMENT_METHOD_CSV_MAP','DAILY_SYNC_CAFE24_PAYMENT_METHOD_MAP_VERIFIED_AT','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED','DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT')){if($baseline.variables.Contains($name)){$evidence[$name]=$baseline.variables[$name]}}
 $inputValue=@{checkpointKey=$baseline.variables.DAILY_SYNC_CHECKPOINT_KEY_B64;checkpoints=$plan.beforeCipherSnapshot.checkpoints;evidence=$evidence}
 $start=[Diagnostics.ProcessStartInfo]::new('node');$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 foreach($arg in @('--import','tsx',"$PSScriptRoot/phase10-cafe-offline-20261020.mjs")){$start.ArgumentList.Add($arg)}
 $start.Environment['TSX_TSCONFIG_PATH']='apps/api/tsconfig.json';$child=[Diagnostics.Process]::new();$child.StartInfo=$start;[void]$child.Start()
 $out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync();$child.StandardInput.Write(($inputValue|ConvertTo-Json -Depth 40 -Compress));$child.StandardInput.Close()
 if(-not $child.WaitForExit(30000)){$child.Kill($true);throw 'OFFLINE_TIMEOUT'}
 $text=$out.GetAwaiter().GetResult();$ignored=$err.GetAwaiter().GetResult();if($child.ExitCode -ne 0){throw 'OFFLINE_CHILD_FAILED'}
 $safe=$text|ConvertFrom-Json -AsHashtable -Depth 20
 if($safe.kind -cne 'PHASE10_CAFE_ARCHIVED_OFFLINE_REPLAY' -or $safe.rawValuesReturned -ne 0 -or $safe.providerRequests -ne 0){throw 'OFFLINE_OUTPUT'}
 $folder='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/api-20261020-cafe-rollback';[void][IO.Directory]::CreateDirectory($folder)
 $stream=[IO.File]::Open("$folder/cafe-archived-offline.json",[IO.FileMode]::CreateNew);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($safe|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $safe|ConvertTo-Json -Depth 20 -Compress
}catch{Write-Output '{"kind":"PHASE10_CAFE_ARCHIVED_OFFLINE_REPLAY_FAILED","rawErrorSuppressed":true,"providerRequests":0,"databaseConnections":0,"databaseWrites":0}';exit 1}
finally{$baseline=$null;$plan=$null;$inputValue=$null;$text=$null;$ignored=$null;$child?.Dispose()}
