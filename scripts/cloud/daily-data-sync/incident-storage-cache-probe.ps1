Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-storage-rotation.ps1"
$material=$null;$context=$null;$wire=$null;$raw=$null;$child=$null
try{
 $material=Read-IncidentStorageMaterial;$context=Read-Phase08ProtectedJson
 if($context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.env.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $context.env.SUPABASE_STORAGE_BUCKET -cne 'meta-ads-phase08-isolated'){throw 'TARGET'}
 $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.ArgumentList.Add("$PSScriptRoot/incident-storage-cache-probe.mjs");$psi.Environment.Clear();foreach($k in @('PATH','SystemRoot','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($k)){$psi.Environment[$k]=[Environment]::GetEnvironmentVariable($k)}}
 $child=[Diagnostics.Process]::new();$child.StartInfo=$psi;$null=$child.Start();$out=$child.StandardOutput.ReadToEndAsync();$err=$child.StandardError.ReadToEndAsync()
 $wire=@{projectRef=$context.projectRef;baseUrl=$context.env.SUPABASE_URL;bucket=$context.env.SUPABASE_STORAGE_BUCKET;publishableKey=$context.env.SUPABASE_PUBLISHABLE_KEY;oldToken=$material.oldToken;newToken=$material.newToken;oldSubject=$material.oldSubject;newSubject=$material.newSubject;oldTokenSha256=$material.oldTokenSha256;newTokenSha256=$material.newTokenSha256;sentinelHash=$material.sentinelHash}|ConvertTo-Json -Compress -Depth 5
 $child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null;if(-not $child.WaitForExit(95000)){$child.Kill($true);throw 'TIMEOUT'};$raw=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();if($child.ExitCode -ne 0 -or $raw.Length -gt 262144){throw 'CHILD'};$result=$raw|ConvertFrom-Json -AsHashtable -Depth 15 -DateKind String
 Write-IncidentStorageReceipt $result ('native-cache-diagnostic-'+[Guid]::NewGuid().ToString('N'));$result|ConvertTo-Json -Depth 10
}catch{@{kind='INCIDENT_STORAGE_NATIVE_CACHE_DIAGNOSTIC';status='FAIL';rawErrorSuppressed=$true;remoteMutations=0}|ConvertTo-Json;exit 1}finally{$material=$null;$context=$null;$wire=$null;$raw=$null;if($child){$child.Dispose()}}
