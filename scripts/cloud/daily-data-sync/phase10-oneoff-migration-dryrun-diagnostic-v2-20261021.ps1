Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-cafe-oneoff-controller-v4-20261021.ps1"
$dest='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/oneoff-migration-dryrun-diagnostic-v2.json'
$x=$null;$sql=$null;$token=$null;$headers=$null;$response=$null;$body=$null
try{
 if(Test-Path -LiteralPath $dest){throw 'CONSUMED'}
 $x=Read-OneoffPrepared 'cafe08-oneoff-20261021-prepared-b'
 $null=Assert-OneoffHeldState $x.variablesHash $x.plan
 $sql=Invoke-OneoffWire @{action='Migrate';plan=$x.plan;before=$x.before}
 if(-not $sql.EndsWith('COMMIT;') -or [regex]::Matches($sql,'COMMIT;').Count -ne 1){throw 'DRYRUN_TRANSACTION_BOUNDARY'}
 $sql=$sql.Substring(0,$sql.Length-7)+'ROLLBACK;'
 $allowed=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 $module=$sql
 foreach($m in [regex]::Matches($module,"'(?<code>ONEOFF_[A-Z_]+)'")){[void]$allowed.Add($m.Groups['code'].Value)}
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)};$body=@{query=$sql}|ConvertTo-Json -Compress
 $response=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/database/query' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
 if([Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 2097152){throw 'REPLY_BOUND'}
 $guardCodes=@([regex]::Matches($response.Content,'ONEOFF_[A-Z_]+')|ForEach-Object {$_.Value}|Where-Object {$allowed.Contains($_)}|Select-Object -Unique)
 $states=@([regex]::Matches($response.Content,'(?:ERROR:\s*|"code"\s*:\s*")(?<state>[0-9A-Z]{5})(?=[:"\s])')|ForEach-Object {$_.Groups['state'].Value}|Select-Object -Unique)
 $proof=@{kind='ONEOFF_ADDITIVE52_ROLLBACK_DIAGNOSTIC';at=[DateTimeOffset]::UtcNow.ToString('o');httpStatus=[int]$response.StatusCode;fixedGuardCodes=$guardCodes;sqlStates=$states;transactionCommitReplacedByRollback=$true;providerRequests=0;rawErrorReturned=0;rawSqlReturned=0;automaticRetry=$false}
 $f=[IO.File]::Open($dest,[IO.FileMode]::CreateNew);try{$b=[Text.UTF8Encoding]::new($false).GetBytes(($proof|ConvertTo-Json -Depth 6));$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}
 $proof|ConvertTo-Json -Depth 6 -Compress
}catch{@{status='FAIL';line=$_.InvocationInfo.ScriptLineNumber;scriptLeaf=[IO.Path]::GetFileName($_.InvocationInfo.ScriptName);rawErrorSuppressed=$true;providerRequests=0}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$x=$null;$sql=$null;$token=$null;$headers=$null;$body=$null;$response=$null}
