Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
$stage='START';$mutation=$false
try{
 $live=Get-IncidentState;$before=Get-IncidentSnapshot;Assert-IncidentContained $before
 if($before.runtime_role.login -cne $false -or $before.runtime_backends -ne 0){throw 'NOLOGIN_REQUIRED'}
 $metadata=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM phase08_meta_ads.source_connections c) AS connections,(SELECT jsonb_agg(to_jsonb(g) ORDER BY table_name,privilege_type) FROM information_schema.role_table_grants g WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('cafe24_observed_order_revisions','cafe24_observed_day_checkpoints','source_credentials','sync_unit_checkpoints')) AS grants;COMMIT;")
 if($metadata.Count -ne 1 -or $metadata[0].connections.Count -ne 3){throw 'CONNECTION_SET'}
 Write-IncidentPrivate @{metadata=$metadata[0];snapshot=$before;restoreOnlyAfterExternalCredentialResolution=$true} 'provider-hold-before'
 Write-IncidentReceipt @{kind='INCIDENT_PROVIDER_HOLD_PLANNED';at=[DateTimeOffset]::UtcNow.ToString('o');disableProviders=@('GOOGLE','META','CAFE24');runtimeGrantHoldTables=@('cafe24_observed_order_revisions','cafe24_observed_day_checkpoints','source_credentials','sync_unit_checkpoints');permissionExpansion=0} 'provider-hold-attempt'
 $sql=@'
BEGIN;SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='20s';
SELECT pg_advisory_xact_lock(hashtextextended('daily-data-sync-08-management',0));
DO $guard$ BEGIN
IF current_database()<>'postgres' OR current_user<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL
OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app')
OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='phase08_runtime' AND rolcanlogin)
OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='phase08_runtime')
OR EXISTS(SELECT 1 FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp())
OR (SELECT count(*) FROM phase08_meta_ads.source_connections)<>3
OR (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE enabled)<>3
OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE provider::text='GOOGLE' AND external_account_id='1391592099' AND shop_key='default')
OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND provider::text='META' AND external_account_id='2138525300002203' AND shop_key='default')
OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND provider::text='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1')
THEN RAISE EXCEPTION 'INCIDENT_PROVIDER_HOLD_GUARD';END IF;END $guard$;
UPDATE phase08_meta_ads.source_connections SET enabled=false,updated_at=clock_timestamp() WHERE enabled;
REVOKE ALL PRIVILEGES ON TABLE phase08_meta_ads.cafe24_observed_order_revisions,phase08_meta_ads.cafe24_observed_day_checkpoints,phase08_meta_ads.source_credentials,phase08_meta_ads.sync_unit_checkpoints FROM phase08_runtime;
COMMIT;
'@
 $stage='ONE_SCOPED_PROVIDER_HOLD';$mutation=$true;$null=Invoke-Phase08Management -Action Query -Query $sql
 $after=Get-IncidentSnapshot;Assert-IncidentContained $after
 foreach($table in $before.table_digests){if($table.table -ceq 'source_connections'){continue};$current=@($after.table_digests|Where-Object {$_.table -ceq $table.table});if($current.Count -ne 1 -or $current[0].rows -ne $table.rows -or $current[0].md5 -cne $table.md5){throw 'UNRELATED_BUSINESS_CHANGED'}}
 $verification=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT (SELECT count(*)::int FROM phase08_meta_ads.source_connections WHERE enabled) AS enabled,(SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema='phase08_meta_ads' AND table_name IN('cafe24_observed_order_revisions','cafe24_observed_day_checkpoints','source_credentials','sync_unit_checkpoints')) AS remaining_grants;COMMIT;")
 if($verification.Count -ne 1 -or $verification[0].enabled -ne 0 -or $verification[0].remaining_grants -ne 0){throw 'HOLD_NOT_EFFECTIVE'}
 Write-IncidentReceipt @{kind='INCIDENT_PROVIDER_AND_CRYPTO_TABLE_HOLD_VERIFIED';at=[DateTimeOffset]::UtcNow.ToString('o');enabledProviderConnections=0;runtimeCredentialObservationCheckpointGrants=0;other67TablesUnchanged=$true;businessDataDeleted=0;providerRequests=0;externalCredentialsModified=0;productionChanges=0;snapshot=$after} 'provider-held'
 @{kind='INCIDENT_PROVIDER_HOLD_COMPLETED';at=[DateTimeOffset]::UtcNow.ToString('o');providerRequests=0;productionChanges=0;rawValuesReturned=0}|ConvertTo-Json
}catch{@{kind='INCIDENT_PROVIDER_HOLD_SAFE_REJECTION';stage=$stage;outcomeUncertain=$mutation;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally{$live=$null;$before=$null;$after=$null;$metadata=$null;$sql=$null;$verification=$null}
