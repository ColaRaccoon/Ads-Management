$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-meta-explain-readonly-v2-20261020.ps1"
function Assert-Test($Value,[string]$Label){if(-not $Value){throw "SYNTHETIC_TEST_$Label"}}
$script:Tables=@(1..68|ForEach-Object {[ordered]@{table=('synthetic_'+$_);rows=0;md5=('a'*32)}})
$script:Held=@{db='postgres';principal='postgres';readonly='on';login=$false;restricted=$true;memberships=0;backends=0;stopped=$true;schedules=3;paused=3;jobs=149;active_jobs=0;connections=3;enabled=0;leases=0;running=0;held_grants=0}
function New-ExplainEvidenceDirectory {if($script:Case -ceq 'consumed'){throw 'EVIDENCE_ALREADY_EXISTS'}}
function Save-ExplainReceipt($Value){$script:Saved=$Value}
function Import-Phase08SchedulerChildDefinitions {}
function Get-IncidentState { @{variables=@{DAILY_SYNC_FEATURE_ENABLED='false';DAILY_SYNC_SCHEDULE_ENABLED='false'};serviceInstance=@{latestDeployment=@{id=$script:ExplainDeployment;meta=@{imageDigest=$script:ExplainImage}}}} }
function Invoke-Phase08SchedulerGraph($Query,$Variables){@{serviceInstance=@{latestDeployment=@{id=$script:ExplainDeployment;deploymentStopped=$true};activeDeployments=@()}}}
function Get-Content {return (@{status='PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS';deployment=@{id=$script:ExplainDeployment};snapshot=@{table_digests=$script:Tables}}|ConvertTo-Json -Depth 10 -Compress)}
function Get-IncidentSnapshot {
 $script:SnapshotCalls++;$tables=@($script:Tables|ForEach-Object {[ordered]@{table=$_.table;rows=$_.rows;md5=$_.md5}})
 $script:FixtureCloneJsonOrderEqual=(Get-IncidentHash $tables) -ceq (Get-IncidentHash $script:Tables)
 if($script:Case -ceq 'after-drift' -and $script:SnapshotCalls -gt 1){$tables[0].rows=1}
 return @{table_digests=$tables;stopped=$true;paused=3;active_jobs=0;live_leases=0}
}
function Invoke-Phase08Management([string]$Action,[string]$Query){
 $script:ManagementCalls++
 Assert-Test ($Action -ceq 'Query') 'ACTION_QUERY_ONLY'
 Assert-Test ($Query.Contains('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')) 'READONLY'
 Assert-Test ($Query.Contains('ROLLBACK;')) 'ROLLBACK'
 Assert-Test ($Query -cnotmatch '\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\s') 'NO_DB_WRITE'
 if($Query.Contains('phase10.explain_result')){
  $script:ProbeCalls++
  Assert-Test ((-not $Query.Contains('SET LOCAL ROLE')) -and $Query.Contains('SET LOCAL search_path=phase08_meta_ads,public;') -and $Query.Contains('statement_timeout=20000')) 'POSTGRES_IDENTITY_TIMEOUT'
  Assert-Test ($Query.Contains("current_user<>'postgres'") -and $Query.Contains("WHEN query_canceled")) 'PRE_IDENTITY_TIMEOUT_CATCH'
  if($script:Case -ceq 'management-throws'){throw 'SYNTHETIC_RAW_SECRET_MUST_NOT_ESCAPE'}
  $status=if($script:Case -ceq 'timeout'){'TIMEOUT'}else{'PASS'}
  $isPlan=$Query.Contains('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)')
  $raw=if($isPlan){@(@{Plan=@{'Node Type'='Nested Loop';'Actual Rows'=2;'Actual Loops'=1;'Actual Total Time'=99.1;Output=@('SYNTHETIC_RAW_SECRET_MUST_NOT_ESCAPE');Plans=@(@{'Node Type'='Index Scan';'Relation Name'='source_record_links';'Index Name'='synthetic_idx';'Actual Rows'=9;'Actual Loops'=50;'Rows Removed by Filter'=99;'Shared Hit Blocks'=123;Filter='SYNTHETIC_RAW_SECRET_MUST_NOT_ESCAPE'})};'Planning Time'=1.2;'Execution Time'=100.1;JIT=@{Functions=2;Timing=@{Generation=1.1;Total=9.9}}})}else{@{dayCount=2;daysHash=('b'*32)}}
  if($script:Case -ceq 'unequal-days' -and -not $isPlan -and $script:ProbeCalls -gt 2){$raw.daysHash='c'*32}
  if($script:Case -ceq 'bad-plan-number' -and $isPlan){$raw[0].Plan['Actual Rows']=-1}
  $raw=ConvertTo-Json -InputObject $raw -Depth 100 -Compress
  return @{db='postgres';principal=$(if($script:Case -ceq 'wrong-runtime'){'phase08_runtime'}else{'postgres'});readonly='on';status=$status;result=$raw}
 }
 if($Query.Contains('AS indexes')){
  $tables=@('meta_ad_daily_metrics','meta_adset_daily_metrics','source_record_links','source_coverage','run_units','sync_runs')|ForEach-Object {@{table=$_;rls=$true;forced=$true;runtimePolicyExists=($script:Case -cne 'missing-rls');runtimePolicyExactAllTrue=($script:Case -cne 'nontrue-policy');runtimeSelectGranted=$true;runtimeSchemaUsage=$true}}
  return @{db='postgres';principal='postgres';readonly='on';indexes=@(@{table='source_record_links';index='synthetic_idx';definitionHash=('d'*32)});tables=@($tables)}
 }
 if($Query.Contains('id::text AS id')){
  $r=@{db='postgres';principal='postgres';readonly='on';id='00000000-0000-4000-8000-000000000001'}
  if($script:Case -ceq 'duplicate-meta'){return @($r,$r)};return $r
 }
 $h=$script:Held.Clone();if($script:Case -ceq 'login-open'){$h.login=$true};if($script:Case -ceq 'wrong-principal'){$h.principal='phase08_runtime'};return $h
}
$tested=@()
foreach($case in @('happy','timeout','unequal-days','management-throws','wrong-runtime','bad-plan-number','missing-rls','nontrue-policy','duplicate-meta','login-open','wrong-principal','after-drift','consumed')){
 $script:Case=$case;$script:Saved=$null;$script:SnapshotCalls=0;$script:ProbeCalls=0;$script:ManagementCalls=0
 $r=Invoke-Phase10MetaExplain;$json=$r|ConvertTo-Json -Depth 40 -Compress
 Assert-Test (-not $json.Contains('SYNTHETIC_RAW_SECRET_MUST_NOT_ESCAPE') -and -not $json.Contains('00000000-0000-4000-8000-000000000001')) 'NO_RAW_SECRET_OR_IDS'
 if($case -ceq 'happy'){
  if($r.status -cne 'PASS_READONLY_DIAGNOSTIC_EQUAL_DAYS'){@{kind='SYNTHETIC_FAILURE_STAGE_ONLY';status=$r.status;stage=$r.safeFailureStage;probes=$r.probes.Count;final68=$r.all68Preserved;fixtureCloneJsonOrderEqual=$script:FixtureCloneJsonOrderEqual}|ConvertTo-Json -Compress}
  Assert-Test ($r.status -ceq 'PASS_READONLY_DIAGNOSTIC_EQUAL_DAYS' -and $r.probes.Count -eq 12 -and $script:ProbeCalls -eq 24) 'TWELVE_CASES'
  Assert-Test ($r.all68Preserved -ceq $true -and $r.finalHoldsChecked -ceq $true -and $r.probes[0].explain.plan.nodes.Count -eq 2 -and $r.probes[0].explain.plan.jit.totalMs -eq 9.9) 'FIXED_PLAN_FINAL'
 }else{Assert-Test ($r.status -cne 'PASS_READONLY_DIAGNOSTIC_EQUAL_DAYS') ('REJECT_'+$case)}
 if($case -cne 'consumed'){Assert-Test ($r.final68Checked -ceq $true -and $script:SnapshotCalls -ge 1 -and $null -ne $script:Saved) 'ALWAYS_FINAL68_RECEIPT'}
 if($case -cin @('timeout','management-throws','wrong-runtime','bad-plan-number')){Assert-Test ($script:ProbeCalls -eq 24) 'NO_RETRY_FIXED_BUDGET'}
 if($case -ceq 'after-drift'){Assert-Test ($r.status -ceq 'FAIL_FINAL_PRESERVATION' -and -not $r.all68Preserved) 'DRIFT_REJECT'}
 $tested+=$case
}
foreach($variant in @('CURRENT','TYPED','TYPED_MATERIALIZED')){
 $sql=New-ExplainSql '00000000-0000-4000-8000-000000000001' META_ADSET 2026-10-13 2026-10-14 $variant
 if($variant -cne 'CURRENT'){Assert-Test (-not $sql.Contains('::text=') -and $sql.Contains('::"SourceDataKind"') -and $sql.Contains('::"SourceKind"') -and $sql.Contains('::"RunUnitStatus"')) 'VALUE_TYPED_ONLY'}
 Assert-Test ($sql.Contains('AS MATERIALIZED') -ceq ($variant -ceq 'TYPED_MATERIALIZED')) 'MATERIALIZED_VARIANT'
}
$bad=$false;try{New-ExplainSql "bad';SELECT 1" META_ADSET 2026-10-13 2026-10-14 CURRENT}catch{$bad=$true};Assert-Test $bad 'ID_INJECTION_REJECT'
@{kind='SYNTHETIC_EXPLAIN_WRAPPER_TESTS';pass=($tested.Count+4);cases=$tested;remoteCalls=0;postgresExecutions=0;rawValuesOutput=0}|ConvertTo-Json -Compress
