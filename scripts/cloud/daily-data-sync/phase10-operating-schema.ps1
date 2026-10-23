Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='GRAPH_READ';$v=$null;$wire=$null;$child=$null
try{
 $file='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence/operating-schema.json';if(Test-Path -LiteralPath $file){throw 'RECEIPT_EXISTS'}
 $r=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}' @{p='6fe72710-1fc8-445a-a77f-da2da8fee200';e='01ab3d5a-1036-45b0-aa9c-47179339c9be';s='b0835b08-7799-4c1c-8bcd-90746b9d4248'};$v=$r.variables
 if($v.SUPABASE_DATABASE_PROJECT_REF -cne 'iygjmosbelbosfxidqxv' -or $v.SUPABASE_DATABASE_SCHEMA -cne 'meta_ads' -or $v.SUPABASE_DATABASE_RUNTIME_USER -cne 'meta_ads_prod_runtime'){throw 'IDENTITY'}
 $stage='READ_ONLY_CHILD';$psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.ArgumentList.Add("$PSScriptRoot/phase10-operating-schema.mjs")
 $child=[Diagnostics.Process]::Start($psi);$output=$child.StandardOutput.ReadToEndAsync();$errorOutput=$child.StandardError.ReadToEndAsync();$wire=@{projectRef='iygjmosbelbosfxidqxv';databaseUrl=$v.DATABASE_URL}|ConvertTo-Json -Compress;$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null
 if(-not $child.WaitForExit(30000)){$child.Kill($true);throw 'TIMEOUT'};$raw=$output.GetAwaiter().GetResult();$null=$errorOutput.GetAwaiter().GetResult();if($raw.Length -gt 1048576 -or $child.ExitCode -ne 0){throw 'CHILD_FAILED'};$result=$raw|ConvertFrom-Json -AsHashtable -Depth 20
 if($result.kind -cne 'PHASE10_OPERATING_SCHEMA_READ_ONLY' -or $result.productionWrites -ne 0){throw 'RESULT'}
 $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($result|ConvertTo-Json -Depth 20));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 @{kind=$result.kind;observedAt=$result.observedAt;tableCount=$result.tableCount;columnCount=$result.columnCount;indexCount=$result.indexCount;schemaMetadataSha256=$result.schemaMetadataSha256;productionWrites=0;businessRowsRead=0}|ConvertTo-Json
}catch{@{kind='PHASE10_OPERATING_SCHEMA_READ_FAILED';stage=$stage;productionWrites=0;rawSuppressed=$true}|ConvertTo-Json;exit 1}
finally{$v=$null;$r=$null;$wire=$null;$raw=$null;if($child){$child.Dispose()}}
