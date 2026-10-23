Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-cafe-pair-renew-20261021.ps1"
. "$PSScriptRoot/operator-session.ps1"
$destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/cafe-oneoff-metadata-v1.json'
$stage='START';$operator=$null;$live=$null;$snapshot=$null;$rows=$null
try{
 if(Test-Path -LiteralPath $destination){throw 'CONSUMED'}
 $stage='FIXED_HELD_IDENTITY';$live=Get-IncidentState;$snapshot=Get-IncidentSnapshot;Assert-CafeRecoveryHold $snapshot $live;Assert-CafeRecoveryDeploymentStopped
 $stage='PROTECTED_OPERATOR';$operator=Read-Phase08Operator;$appId=$operator.appId;$authId=$operator.authId
 if($appId -cnotmatch '^[a-f0-9-]{36}$' -or $authId -cnotmatch '^[a-f0-9-]{36}$'){throw 'ACTOR_BOUND'}
 $stage='CATALOG_AND_DAY_READONLY'
 $sql=@"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT current_database() AS db,current_user AS principal,
 (SELECT count(*)::int FROM phase08_meta_ads.app_users WHERE id='$appId'::uuid AND auth_user_id='$authId'::uuid AND role='SUPER_ADMIN' AND invite_status='ACTIVE' AND is_active) AS matching_operator,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relname IN('cafe24_observed_epoch_day_checkpoints','cafe24_observed_epoch_order_revisions')) AS new_epoch_tables,
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename,p.policyname) FROM(SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='phase08_meta_ads')p) AS policies,
 (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.table_name,g.privilege_type) FROM information_schema.role_table_grants g WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads') AS grants,
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.from_date,p.version) FROM(SELECT data_kind,from_date,to_date,primary_source,version FROM phase08_meta_ads.source_policies WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1')p) AS cafe_policies,
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.day) FROM(SELECT day::date AS day,
  (SELECT count(*)::int FROM phase08_meta_ads.cafe24_order_lines WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND order_date=day::date) AS current_lines,
  (SELECT count(*)::int FROM phase08_meta_ads.cafe24_order_api_versions WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND order_date=day::date) AS versions,
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.trigger,r.status) FROM(SELECT trigger,status,count(*)::int AS n FROM phase08_meta_ads.sync_runs WHERE connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND from_date=day::date AND to_date=day::date GROUP BY trigger,status)r) AS runs
  FROM unnest(ARRAY['2026-10-16','2026-10-17']) day)d) AS days;
ROLLBACK;
"@
 $rows=@(Invoke-Phase08Management -Action Query -Query $sql)
 if($rows.Count -ne 1 -or $rows[0].db -cne 'postgres' -or $rows[0].principal -cne 'postgres' -or $rows[0].matching_operator -ne 1 -or $rows[0].new_epoch_tables -ne 0){throw 'METADATA_IDENTITY'}
 $proof=@{kind='CAFE08_ONEOFF_FRESH_READONLY_METADATA';status='PASS_METADATA_ONLY';at=[DateTimeOffset]::UtcNow.ToString('o');fixedIsolatedIdentity=$true;operatorExactActiveSuperAdmin=$true;newEpochTablesAbsent=$true;policies=$rows[0].policies;runtimeGrants=$rows[0].grants;cafePolicies=$rows[0].cafe_policies;days=$rows[0].days;whole68Sha256=(Get-CafeRecoveryTablesHash $snapshot.table_digests);environmentSha256=(Get-IncidentVariableHash $live.variables);runtimeNoLoginBackend0=$true;deploymentStopped=$true;sharedChanges=0;operatingChanges=0;remoteMutations=0;providerCalls=0;appHttp=0;secretValuesReturned=0}
 $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($proof|ConvertTo-Json -Depth 30));$stream.Write($bytes);$stream.Flush($true)}finally{$stream.Dispose()}
 @{status=$proof.status;operatorVerified=$true;newEpochTablesAbsent=$true;policyCount=@($proof.policies).Count;grantsCount=@($proof.runtimeGrants).Count;remoteMutations=0;secretValuesReturned=0;evidence=$destination}|ConvertTo-Json -Compress
}catch{@{status='FAIL';safeStage=$stage;rawErrorSuppressed=$true;remoteMutations=0;secretValuesReturned=0}|ConvertTo-Json -Compress;exit 1}
finally{$operator=$null;$live=$null;$snapshot=$null;$rows=$null;$sql=$null;$appId=$null;$authId=$null}
