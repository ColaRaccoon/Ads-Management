Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. "$PSScriptRoot/update-relay-restore02.ps1"
$script:checks=0
function Assert($x){$script:checks++;if(-not $x){throw 'synthetic-assert'}}
function Reject([scriptblock]$x){$failed=$false;try{&$x|Out-Null}catch{$failed=$true};Assert $failed}
$row=@{database='postgres';principal='postgres';tables=68;stopped=$true;schedules=3;expected_schedules=3;jobs=149;live_leases=0;digest=('a'*32)}
$typed=[pscustomobject]$row.Clone();foreach($n in @('tables','schedules','expected_schedules','jobs','live_leases')){$typed.$n=[long]$typed.$n};Assert ((Assert-Phase08Relay02Stopped @($typed)) -ceq ('a'*32))
Assert ((Assert-Phase08Relay02Stopped @($row)) -ceq ('a'*32))
foreach($change in @(@{stopped=$false},@{stopped='true'},@{jobs=148},@{live_leases=1},@{tables='68'},@{expected_schedules=2})){$bad=$row.Clone();foreach($k in $change.Keys){$bad[$k]=$change[$k]};Reject {Assert-Phase08Relay02Stopped @($bad)}}
$fn=@{id='42f4d9e1-eddb-4b00-b574-399a489f78b4';slug='phase08-scheduled-relay';version=2;status='ACTIVE';verify_jwt=$false;ezbr_sha256='f998dd2160b7d65dc8954f984c21b5432a9860250a0ffc5f2bf4da88b7503492'}
$secrets=@(@{name='PHASE08_RELAY_BASIC_PASSWORD';value=('a'*64)},@{name='PHASE08_RELAY_MACHINE_TOKEN';value=('b'*64)})+@(1..7|ForEach-Object {@{name=('SUPABASE_TEST_'+$_);value=('c'*64)}})
Assert-Phase08Relay02Metadata @($fn) $secrets 2 $fn.ezbr_sha256
$bad=$fn.Clone();$bad.verify_jwt='false';Reject {Assert-Phase08Relay02Metadata @($bad) $secrets 2 $fn.ezbr_sha256}
$bad=$fn.Clone();$bad.version=3;Reject {Assert-Phase08Relay02Metadata @($bad) $secrets 2 $fn.ezbr_sha256}
Reject {Assert-Phase08Relay02Metadata @($fn) $secrets[0..7] 2 $fn.ezbr_sha256}
$sql=Get-Phase08Relay02StoppedSql;Assert ($sql.StartsWith('BEGIN READ ONLY') -and $sql.Contains("anchor_at='2026-10-14T17:02:00Z'") -and -not ($sql -cmatch '(?m)^\s*(INSERT|UPDATE|DELETE) '))
@{state='SYNTHETIC_RELAY02_HELPER_PASS';checks=$script:checks;network=0;credentials=0;provider=0}|ConvertTo-Json -Compress
