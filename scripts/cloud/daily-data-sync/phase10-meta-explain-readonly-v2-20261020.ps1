param([switch]$Execute)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$script:ExplainRoot='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/performance-plan-20261020-v2'
$script:ExplainFinal='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v1/final-held.json'
$script:ExplainDeployment='7775ae68-c04c-4d9d-9861-bdfc3dea0b3b'
$script:ExplainImage='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'
$script:ExplainSourceHash='e08449edf5bdaf8366eade5a38ac2f43e8ad4f5aeb988c991a52db21295fae0d'
function Get-ExplainTextHash([string]$Text){[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()}
function New-ExplainSql([string]$Id,[string]$Kind,[string]$From,[string]$To,[string]$Variant){
 if($Id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $Kind -cnotin @('META_AD','META_ADSET') -or
    ($From+'..'+$To) -cnotin @('2026-10-13..2026-10-14','2026-10-09..2026-10-15') -or $Variant -cnotin @('CURRENT','TYPED','TYPED_MATERIALIZED')){throw 'EXPLAIN_INPUT'}
 $table=if($Kind -ceq 'META_AD'){'meta_ad_daily_metrics'}else{'meta_adset_daily_metrics'}
 $sql=@'
WITH current_counts AS (
 SELECT m.connection_id AS "connectionId",m.metric_date AS "metricDate",
 COUNT(DISTINCT m.id)::int AS "rowCount",
 COUNT(DISTINCT m.id) FILTER(WHERE r.version=m.import_version)::int AS "linkedRows",
 COUNT(r.id)::int AS "allLinks",COUNT(r.id) FILTER(WHERE r.version=m.import_version)::int AS "validLinks"
 FROM __TABLE__ m LEFT JOIN source_record_links r ON r.record_id=m.id
 AND r.connection_id=m.connection_id AND r.data_kind::text='__KIND__'
 AND r.source::text='API' AND r.record_table='__TABLE__' AND r.is_current=true
 WHERE m.connection_id IN('__ID__'::uuid) AND m.metric_date>='__FROM__'::date AND m.metric_date<='__TO__'::date
 AND m.source::text='API' AND m.is_current=true GROUP BY m.connection_id,m.metric_date
)
SELECT c.connection_id AS "connectionId",c.metric_date AS "metricDate"
FROM source_coverage c LEFT JOIN current_counts n ON n."connectionId"=c.connection_id AND n."metricDate"=c.metric_date
WHERE c.connection_id IN('__ID__'::uuid) AND c.data_kind::text='__KIND__' AND c.source::text='API'
 AND c.metric_date>='__FROM__'::date AND c.metric_date<='__TO__'::date
 AND c.last_success_run_id IS NOT NULL AND c.last_success_at IS NOT NULL AND c.row_count>=0
 AND COALESCE(n."rowCount",0)=c.row_count AND COALESCE(n."validLinks",0)=c.row_count
 AND COALESCE(n."linkedRows",0)=c.row_count AND COALESCE(n."allLinks",0)=c.row_count
 AND EXISTS(SELECT 1 FROM run_units u JOIN sync_runs r ON r.id=u.run_id
 WHERE u.run_id=c.last_success_run_id AND u.status::text='SUCCEEDED'
 AND r.connection_id=c.connection_id AND u.unit_key=to_char(c.metric_date,'YYYY-MM-DD'))
'@
 $sql=$sql.Replace('__TABLE__',$table).Replace('__KIND__',$Kind).Replace('__ID__',$Id).Replace('__FROM__',$From).Replace('__TO__',$To)
 if($Variant -cne 'CURRENT'){
  $sql=$sql.Replace("r.data_kind::text='$Kind'",('r.data_kind='''+$Kind+'''::"SourceDataKind"'))
  $sql=$sql.Replace("c.data_kind::text='$Kind'",('c.data_kind='''+$Kind+'''::"SourceDataKind"'))
  foreach($a in @('r','m','c')){$sql=$sql.Replace(($a+".source::text='API'"),($a+'.source=''API''::"SourceKind"'))}
  $sql=$sql.Replace("u.status::text='SUCCEEDED'",'u.status=''SUCCEEDED''::"RunUnitStatus"')
 }
 if($Variant -ceq 'TYPED_MATERIALIZED'){$sql=$sql.Replace('WITH current_counts AS (','WITH current_counts AS MATERIALIZED (')}
 return $sql
}
function Get-ExplainTransaction([string]$Sql,[bool]$Plan){
 # Each remote request owns its complete transaction. Exceptions are converted
 # inside the DO block so statement timeout still reaches the explicit rollback.
 $body=if($Plan){'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+$Sql}else{
  'SELECT jsonb_build_object(''dayCount'',count(*),''daysHash'',md5(coalesce(string_agg("connectionId"::text||'':''||to_char("metricDate",''YYYY-MM-DD''),'','' ORDER BY "connectionId","metricDate"),''''))) FROM ('+$Sql+') days'
 }
 return @"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout=20000;
DO `$identity`$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'READ_ONLY_IDENTITY';END IF;END `$identity`$;
SET LOCAL search_path=phase08_meta_ads,public;
DO `$probe`$ DECLARE result jsonb; BEGIN
 IF current_user<>'postgres' OR current_schema()<>'phase08_meta_ads' THEN RAISE EXCEPTION 'PRIVILEGED_READ_IDENTITY';END IF;
 BEGIN
  EXECUTE `$query`$$body`$query`$ INTO result;
  PERFORM set_config('phase10.explain_status','PASS',true);
  PERFORM set_config('phase10.explain_result',result::text,true);
 EXCEPTION WHEN query_canceled THEN PERFORM set_config('phase10.explain_status','TIMEOUT',true);
 WHEN OTHERS THEN PERFORM set_config('phase10.explain_status','QUERY_FAILED',true);
 END;
END `$probe`$;
SELECT current_database() AS db,current_user AS principal,current_setting('transaction_read_only') AS readonly,
 current_setting('phase10.explain_status',true) AS status,
 CASE WHEN current_setting('phase10.explain_status',true)='PASS' THEN current_setting('phase10.explain_result',true) ELSE NULL END AS result;
ROLLBACK;
"@
}
function Get-ExplainHeld {
 $q=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout=20000;
SELECT current_database() AS db,current_user AS principal,current_setting('transaction_read_only') AS readonly,
 (SELECT rolcanlogin FROM pg_roles WHERE rolname='phase08_runtime') AS login,
 (SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication FROM pg_roles WHERE rolname='phase08_runtime') AS restricted,
 (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='phase08_runtime') AS memberships,
 (SELECT count(*)::int FROM pg_stat_activity WHERE usename='phase08_runtime') AS backends,
 (SELECT stopped FROM daily_data_sync_ops.settings WHERE singleton AND target_id='phase08-full-app') AS stopped,
 (SELECT count(*)::int FROM daily_data_sync_ops.schedules) AS schedules,
 (SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,
 (SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
 (SELECT count(*)::int FROM phase08_meta_ads.source_connections) AS connections,
 (SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases,
 (SELECT count(*)::int FROM phase08_meta_ads.sync_runs WHERE status='RUNNING') AS running,
 (SELECT count(*)::int FROM unnest(ARRAY['source_credentials','sync_unit_checkpoints','cafe24_observed_order_revisions','cafe24_observed_day_checkpoints']) t(name)
 WHERE has_table_privilege('phase08_runtime',format('phase08_meta_ads.%I',name),'SELECT,INSERT,UPDATE,DELETE')) AS held_grants;
ROLLBACK;
'@
 $rows=@(Invoke-Phase08Management -Action Query -Query $q);if($rows.Count -ne 1){throw 'HELD_SHAPE'};return $rows[0]
}
function Assert-ExplainHeld($h){
 if($h.db -cne 'postgres' -or $h.principal -cne 'postgres' -or $h.readonly -cne 'on' -or $h.login -cne $false -or $h.restricted -cne $true -or $h.memberships -ne 0 -or $h.backends -ne 0 -or $h.stopped -cne $true -or $h.schedules -ne 3 -or $h.paused -ne 3 -or $h.jobs -ne 149 -or $h.active_jobs -ne 0 -or $h.connections -ne 3 -or $h.enabled -ne 0 -or $h.leases -ne 0 -or $h.running -ne 0 -or $h.held_grants -ne 0){throw 'HELD_GUARD'}
}
function Assert-ExplainDeployment {
 $s=Get-IncidentState
 if($s.variables.DAILY_SYNC_FEATURE_ENABLED -cne 'false' -or $s.variables.DAILY_SYNC_SCHEDULE_ENABLED -cne 'false' -or
    $s.serviceInstance.latestDeployment.id -cne $script:ExplainDeployment -or $s.serviceInstance.latestDeployment.meta.imageDigest -cne $script:ExplainImage){throw 'DEPLOYMENT_TARGET'}
 $r=(Invoke-Phase08SchedulerGraph 'query($e:String!,$s:String!){serviceInstance(environmentId:$e,serviceId:$s){latestDeployment{id deploymentStopped} activeDeployments{id deploymentStopped}}}' @{e=$script:IncidentScope.e;s=$script:IncidentScope.s}).serviceInstance
 if($r.latestDeployment.id -cne $script:ExplainDeployment -or $r.latestDeployment.deploymentStopped -cne $true -or @($r.activeDeployments|Where-Object {$_.deploymentStopped -cne $true}).Count -ne 0){throw 'DEPLOYMENT_NOT_STOPPED'}
 $s=$null
}
function ConvertTo-ExplainProjection($Raw){
 if($Raw -isnot [string]){$Raw=ConvertTo-Json -InputObject $Raw -Depth 100 -Compress}
 $Raw=$Raw|ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String
 $plans=@($Raw);if($plans.Count -ne 1){throw 'PLAN_SHAPE'};$top=$plans[0]
 $nodes=[Collections.Generic.List[object]]::new();$pending=[Collections.Generic.Stack[object]]::new();$pending.Push($top.Plan)
 $numberFields=@{actualRows='Actual Rows';loops='Actual Loops';removedRowsByFilter='Rows Removed by Filter';removedRowsByJoin='Rows Removed by Join Filter';sharedHits='Shared Hit Blocks';sharedReads='Shared Read Blocks';actualStartupMs='Actual Startup Time';actualTotalMs='Actual Total Time'}
 while($pending.Count -gt 0){
  if($nodes.Count -ge 512){throw 'PLAN_NODE_BOUND'};$n=$pending.Pop();$item=[ordered]@{}
  foreach($pair in @(@('nodeType','Node Type'),@('relation','Relation Name'),@('index','Index Name'))){
   $v=$n[$pair[1]];if($null -ne $v){if($v -isnot [string] -or $v -cnotmatch '^[A-Za-z0-9_ -]{1,128}$'){throw 'PLAN_LABEL'};$item[$pair[0]]=$v}
  }
  foreach($label in $numberFields.Keys){$v=$n[$numberFields[$label]];if($null -ne $v){$value=[double]$v;if(-not [double]::IsFinite($value) -or $value -lt 0){throw 'PLAN_NUMBER'};$item[$label]=$value}}
  $conditions=[ordered]@{};$condition=[string]$n['Index Cond']
  foreach($field in @('connection_id','data_kind','source','record_table','record_id','metric_date','run_id','unit_key')){$conditions[$field]=[regex]::IsMatch($condition,('\b'+$field+'\b'))}
  $item.indexConditionFields=$conditions;$condition=$null
  $nodes.Add($item);if($n.Contains('Plans')){foreach($c in $n.Plans){$pending.Push($c)}}
 }
 $out=@{nodes=@($nodes.ToArray());planningMs=[double]$top['Planning Time'];executionMs=[double]$top['Execution Time'];jit=@{}}
 if($top.Contains('JIT')){if($top.JIT.Contains('Functions')){$out.jit.functions=[int]$top.JIT.Functions};if($top.JIT.Contains('Timing')){foreach($name in @('Generation','Inlining','Optimization','Emission','Total')){if($top.JIT.Timing.Contains($name)){$out.jit[$name.ToLowerInvariant()+'Ms']=[double]$top.JIT.Timing[$name]}}}}
 foreach($v in @($out.planningMs,$out.executionMs)+@($out.jit.Values)){if(-not [double]::IsFinite([double]$v) -or [double]$v -lt 0){throw 'PLAN_NUMBER'}}
 return $out
}
function Invoke-ExplainProbe([string]$Sql,[bool]$Plan){
 $raw=$null
 try{
  $raw=@(Invoke-Phase08Management -Action Query -Query (Get-ExplainTransaction $Sql $Plan))
  if($raw.Count -ne 1 -or $raw[0].db -cne 'postgres' -or $raw[0].principal -cne 'postgres' -or $raw[0].readonly -cne 'on' -or $raw[0].status -cnotin @('PASS','TIMEOUT','QUERY_FAILED')){throw 'PROBE_IDENTITY'}
  if($raw[0].status -cne 'PASS'){return @{status=$raw[0].status;rawSuppressed=$true}}
  if($Plan){return @{status='PASS';plan=(ConvertTo-ExplainProjection $raw[0].result)}}
  $d=$raw[0].result;if($d -is [string]){$d=$d|ConvertFrom-Json -AsHashtable}
  if($d.dayCount -isnot [ValueType] -or [long]$d.dayCount -lt 0 -or [long]$d.dayCount -gt 92 -or $d.daysHash -cnotmatch '^[a-f0-9]{32}$'){throw 'DAY_DIGEST_SHAPE'}
  return @{status='PASS';dayCount=[long]$d.dayCount;canonicalDaysMd5=$d.daysHash}
 }catch{return @{status='SAFE_MANAGEMENT_OR_PROJECTION_FAILURE';rawSuppressed=$true}}
 finally{$raw=$null}
}
function Get-ExplainCatalog {
 $q=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout=20000;
SELECT current_database() AS db,current_user AS principal,current_setting('transaction_read_only') AS readonly,
 (SELECT jsonb_agg(jsonb_build_object('table',tablename,'index',indexname,'definitionHash',md5(indexdef)) ORDER BY tablename,indexname)
 FROM pg_indexes WHERE schemaname='phase08_meta_ads' AND tablename IN('meta_ad_daily_metrics','meta_adset_daily_metrics','source_record_links','source_coverage','run_units','sync_runs')) AS indexes,
 (SELECT jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'forced',c.relforcerowsecurity,
 'runtimePolicyExists',EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname AND p.cmd IN('SELECT','ALL') AND ('phase08_runtime'::name=ANY(p.roles) OR 'public'::name=ANY(p.roles))),
 'runtimePolicyExactAllTrue',
   (SELECT count(*)=1 FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname AND ('phase08_runtime'::name=ANY(p.roles) OR 'public'::name=ANY(p.roles)))
   AND EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname
      AND ('phase08_runtime'::name=ANY(p.roles) OR 'public'::name=ANY(p.roles)) AND p.cmd='ALL' AND p.permissive='PERMISSIVE' AND p.qual='true' AND p.with_check='true'),
 'runtimeSelectGranted',has_table_privilege('phase08_runtime',c.oid,'SELECT'),
 'runtimeSchemaUsage',has_schema_privilege('phase08_runtime',n.oid,'USAGE')) ORDER BY c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relname IN('meta_ad_daily_metrics','meta_adset_daily_metrics','source_record_links','source_coverage','run_units','sync_runs')) AS tables;
ROLLBACK;
'@
 $r=@(Invoke-Phase08Management -Action Query -Query $q)
 if($r.Count -ne 1 -or $r[0].db -cne 'postgres' -or $r[0].principal -cne 'postgres' -or $r[0].readonly -cne 'on' -or $r[0].tables.Count -ne 6){throw 'CATALOG_IDENTITY'}
 foreach($t in $r[0].tables){if($t.rls -cne $true -or $t.forced -cne $true -or $t.runtimePolicyExists -cne $true -or $t.runtimePolicyExactAllTrue -cne $true -or $t.runtimeSelectGranted -cne $true -or $t.runtimeSchemaUsage -cne $true){throw 'RUNTIME_RLS_POLICY'}}
 $indexes=@();$tables=@()
 foreach($i in $r[0].indexes){if($i.table -cnotmatch '^[a-z0-9_]{1,64}$' -or $i.index -cnotmatch '^[a-z0-9_]{1,128}$' -or $i.definitionHash -cnotmatch '^[a-f0-9]{32}$'){throw 'CATALOG_LABEL'};$indexes+=@{table=$i.table;index=$i.index;definitionMd5=$i.definitionHash}}
 foreach($t in $r[0].tables){if($t.table -cnotmatch '^[a-z0-9_]{1,64}$'){throw 'CATALOG_LABEL'};$tables+=@{table=$t.table;rls=$t.rls;forced=$t.forced;runtimePolicyExists=$t.runtimePolicyExists;runtimePolicyExactAllTrue=$t.runtimePolicyExactAllTrue;runtimeSelectGranted=$t.runtimeSelectGranted;runtimeSchemaUsage=$t.runtimeSchemaUsage}}
 return @{indexes=$indexes;tables=$tables}
}
function Save-ExplainReceipt($Value){
 $path=Join-Path $script:ExplainRoot 'result.json';$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$b=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 30));$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}
}
function New-ExplainEvidenceDirectory {
 if(Test-Path -LiteralPath $script:ExplainRoot){throw 'EVIDENCE_ALREADY_EXISTS'}
 [void][IO.Directory]::CreateDirectory($script:ExplainRoot)
}
function Invoke-Phase10MetaExplain {
 $stage='START';$before=$null;$after=$null;$id=$null;$sql=$null;$raw=$null;$started=$false
 $result=@{kind='BOUNDED_PRIVILEGED_POSTGRES_META_EXPLAIN';actualPrincipal='postgres';runtimePrincipalUsed=$false;runtimePlanProven=$false;status='FAIL';startedAt=[DateTimeOffset]::UtcNow.ToString('o');probes=@();all68Preserved=$false;remoteMutations=0;providerCalls=0;appHttpRequests=0;postgresRuntimeLoginEnabled=$false;rawPlansSaved=$false;rawPlansOutput=$false;rawIdsOutput=0;fixedCases=12;businessSelectBudget=24;businessSelectAttempts=0;businessSelectExecutions=0;managementGuardCatalogSnapshotQueriesSeparate=$true;automaticRetry=$false;statementTimeoutMs=20000;
 limits=@('Sequential CURRENT then TYPED then TYPED_MATERIALIZED order has cache-warming bias.','Read-only diagnosis is not a 40GET/concurrency4 load or an actual SLA measurement.','Controlled literal queries do not reproduce Prisma prepared-statement generic/custom-plan selection.','Privileged postgres is a different principal; runtime role/RLS/optimizer plan equivalence is not proven.','No SQL text, full plan, expressions, raw IDs or provider data are saved.')}
 try{
  New-ExplainEvidenceDirectory;$started=$true
  $stage='SOURCE_PIN';$p=Join-Path $PSScriptRoot '../../../apps/api/src/common/meta-source-read-coverage.ts';if((Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:ExplainSourceHash){throw 'SOURCE_CHANGED'}
  $stage='DEPLOYMENT';Import-Phase08SchedulerChildDefinitions;Assert-ExplainDeployment;Assert-ExplainHeld (Get-ExplainHeld)
  $stage='BEFORE68';$baseline=Get-Content $script:ExplainFinal -Raw|ConvertFrom-Json -AsHashtable -DateKind String -Depth 40
  $before=Get-IncidentSnapshot;Assert-IncidentContained $before
  if($baseline.deployment.id -cne $script:ExplainDeployment -or $baseline.status -cne 'PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS' -or (Get-IncidentHash $before.table_digests) -cne (Get-IncidentHash $baseline.snapshot.table_digests)){throw 'BASELINE68_CAS'}
  $result.before68Sha=Get-IncidentHash $before.table_digests
  $stage='CATALOG';$result.catalog=Get-ExplainCatalog
  $stage='META_ID';$raw=@(Invoke-Phase08Management -Action Query -Query "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout=20000;SELECT current_database() AS db,current_user AS principal,current_setting('transaction_read_only') AS readonly,id::text AS id FROM phase08_meta_ads.source_connections WHERE provider='META';ROLLBACK;")
  if($raw.Count -ne 1 -or $raw[0].db -cne 'postgres' -or $raw[0].principal -cne 'postgres' -or $raw[0].readonly -cne 'on' -or $raw[0].id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'META_CONNECTION_SCOPE'}
  $id=$raw[0].id;$raw=$null;$allPass=$true;$digests=@{}
  foreach($kind in @('META_ADSET','META_AD')){foreach($range in @(@('2026-10-13','2026-10-14'),@('2026-10-09','2026-10-15'))){foreach($variant in @('CURRENT','TYPED','TYPED_MATERIALIZED')){
   $stage='EXPLAIN_AND_DIGEST';Assert-ExplainHeld (Get-ExplainHeld)
   $sql=New-ExplainSql $id $kind $range[0] $range[1] $variant
   $probe=@{kind=$kind;from=$range[0];to=$range[1];variant=$variant;sqlSha256=(Get-ExplainTextHash $sql)}
   $result.businessSelectAttempts++;$probe.explain=Invoke-ExplainProbe $sql $true
   if($probe.explain.status -cin @('PASS','TIMEOUT','QUERY_FAILED')){$result.businessSelectExecutions++}
   $result.businessSelectAttempts++;$probe.days=Invoke-ExplainProbe $sql $false
   if($probe.days.status -cin @('PASS','TIMEOUT','QUERY_FAILED')){$result.businessSelectExecutions++}
   $key=$kind+':'+$range[0]+':'+$range[1]
   if($probe.explain.status -cne 'PASS' -or $probe.days.status -cne 'PASS'){$allPass=$false}
   if($probe.days.status -ceq 'PASS'){
    $digest=[string]$probe.days.dayCount+':'+$probe.days.canonicalDaysMd5
    if($digests.ContainsKey($key)){$probe.dayDigestEqual=$digests[$key] -ceq $digest;if(-not $probe.dayDigestEqual){$allPass=$false}}
    else{$digests[$key]=$digest;$probe.dayDigestEqual=$true}
   }else{$probe.dayDigestEqual=$false}
   $result.probes+=,$probe;$sql=$null
  }}}
  if($result.probes.Count -ne 12 -or $digests.Count -ne 4){throw 'PROBE_COUNT'}
  $result.status=if($allPass){'PASS_READONLY_DIAGNOSTIC_EQUAL_DAYS'}else{'PARTIAL_OR_FAILED_READONLY_DIAGNOSTIC'}
 }catch{$result.safeFailureStage=$stage;$result.rawExceptionSuppressed=$true}
 finally{
  if($started){
   # Always re-check all 68 rows/tables and all isolation holds, including after
   # a timeout, shape failure or an earlier guard rejection.
   $result.final68Checked=$false;$result.finalHoldsChecked=$false
   try{$after=Get-IncidentSnapshot;$result.after68Sha=Get-IncidentHash $after.table_digests;$result.final68Checked=$true;$result.all68Preserved=$null -ne $before -and (Get-IncidentHash $before.table_digests) -ceq $result.after68Sha}catch{$result.final68SafeFailure=$true;$result.all68Preserved=$false}
   try{Assert-ExplainHeld (Get-ExplainHeld);Assert-ExplainDeployment;$result.finalHoldsChecked=$true}catch{$result.finalHoldSafeFailure=$true}
   if(-not $result.final68Checked -or -not $result.finalHoldsChecked -or -not $result.all68Preserved){$result.status='FAIL_FINAL_PRESERVATION'}
   $result.finishedAt=[DateTimeOffset]::UtcNow.ToString('o');Save-ExplainReceipt $result
  }
  $id=$null;$sql=$null;$raw=$null;$before=$null;$after=$null;$baseline=$null
 }
 return $result
}
if($Execute){$answer=Invoke-Phase10MetaExplain;@{kind=$answer.kind;status=$answer.status;probes=$answer.probes.Count;all68Preserved=$answer.all68Preserved;rawPlansSaved=$false;rawIdsOutput=0}|ConvertTo-Json -Compress;if($answer.status -cne 'PASS_READONLY_DIAGNOSTIC_EQUAL_DAYS'){exit 1}}
