Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-cafe-pair-recovery-20261020.ps1"
$destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-recovery-20261020-v1/independent-readproof.json'
$plan=$null;$forward=$null;$snapshot=$null;$live=$null;$cipher=$null;$audit=$null;$stage='START'
try {
 if(Test-Path -LiteralPath $destination){throw 'EVIDENCE_CONSUMED'}
 $stage='PROTECTED_EXPECTATIONS';$plan=Read-IncidentPrivate 'cafe08-recovery-plan-20261020-cafe08-read-recovery-a';$forward=Read-IncidentPrivate 'cafe08-recovery-forward-20261020-cafe08-read-recovery-a'
 if($plan.operationKey -cne '20261020-cafe08-read-recovery-a' -or $plan.eligibleSecretRollback -cne $false -or $forward.eligibleSecretRollback -cne $false -or $plan.auditId -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$'){throw 'EXPECTED_PLAN'}
 $stage='FRESH_HELD_STATE';$live=Get-IncidentState;$snapshot=Get-IncidentSnapshot;Assert-CafeRecoveryHold $snapshot $live;Assert-CafeRecoveryDeploymentStopped
 if((Get-IncidentVariableHash $live.variables) -cne $plan.variableHash -or (Get-CafeRecoveryControlsHash $snapshot) -cne $plan.beforeControlsHash){throw 'CONTROLS_CHANGED'}
 $unchanged=0;foreach($table in $plan.beforeTables){
  if($table.table -cin @('source_credentials','source_connections','security_audit_events')){continue}
  $actual=@($snapshot.table_digests|Where-Object {$_.table -ceq $table.table})
  if($actual.Count -ne 1 -or $actual[0].rows -ne $table.rows -or $actual[0].md5 -cne $table.md5){throw 'UNRELATED_TABLE_CHANGED'};$unchanged++
 };if($unchanged -ne 65){throw 'TABLE_SET'}
 $stage='FRESH_PAIR_DECRYPTION';$cipher=Get-CafeRecoveryCipherSnapshot;$pair=Invoke-CafeRecoveryChild @{action='VERIFY';prepared=$forward;snapshot=$cipher;plan=$plan}
 if($pair.verified -cne $true -or $pair.exactNewPairAuthenticatedDecryption -cne $true){throw 'PAIR_VERIFY'}
 $stage='READONLY_ORIGINAL_AUDIT_AND_APPEND';$id=$plan.auditId
 $sql=@"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='20s';
SELECT
 (SELECT count(*)::int FROM phase08_meta_ads.security_audit_events WHERE id<>'$id'::uuid) AS original_count,
 (SELECT md5(coalesce(string_agg(md5(to_jsonb(a)::text),'' ORDER BY md5(to_jsonb(a)::text)),'')) FROM phase08_meta_ads.security_audit_events a WHERE id<>'$id'::uuid) AS original_md5,
 (SELECT count(*)::int FROM phase08_meta_ads.security_audit_events WHERE id='$id'::uuid AND actor_type='SYSTEM' AND actor_user_id IS NULL AND action='CAFE24_CREDENTIAL_ROTATED' AND target_type='SOURCE_CONNECTION' AND target_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND result='SUCCESS' AND after_json='{"operationKey":"20261020-cafe08-read-recovery-a","scope":"mall.read_order","keyVersion":2,"beforeRevision":8,"afterRevision":9,"providerPosts":1,"enabledRemainsFalse":true}'::jsonb) AS exact_append,
 (SELECT count(*)::int FROM phase08_meta_ads.security_audit_events) AS total_count;
ROLLBACK;
"@
 $audit=@(Invoke-Phase08Management -Action Query -Query $sql);$original=@($plan.beforeTables|Where-Object {$_.table -ceq 'security_audit_events'})
 if($audit.Count -ne 1 -or $original.Count -ne 1 -or $audit[0].original_count -ne $original[0].rows -or $audit[0].original_md5 -cne $original[0].md5 -or $audit[0].exact_append -ne 1 -or $audit[0].total_count -ne ($original[0].rows+1)){throw 'AUDIT_PRESERVATION'}
 $proof=@{kind='CAFE08_RENEWAL_INDEPENDENT_FRESH_READPROOF';status='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');unrelatedTablesPreserved=65;originalAuditEntireRowsPreserved=$true;exactSystemAuditAppended=1;pair=$pair;controlsEnvironmentUnchanged=$true;securityDeploymentStopped=$true;runtimeNoLoginBackend0=$true;normalResume=$false;observationRebaselineHold=$true;providerConnectionsOff=$true;remoteMutations=0;providerCalls=0;sharedCredentialChanges=0;operatingChanges=0;rawValuesReturned=0;snapshot=$snapshot}
 $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write([Text.Encoding]::UTF8.GetBytes(($proof|ConvertTo-Json -Depth 40)));$stream.Flush($true)}finally{$stream.Dispose()}
 @{status='PASS';unrelatedTablesPreserved=65;originalAuditEntireRowsPreserved=$true;exactSystemAuditAppended=1;remoteMutations=0;providerCalls=0;rawValuesReturned=0;evidence=$destination}|ConvertTo-Json -Compress
}catch{
 @{status='FAIL';safeStage=$stage;rawErrorSuppressed=$true;remoteMutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress;exit 1
}finally{$plan=$null;$forward=$null;$snapshot=$null;$live=$null;$cipher=$null;$audit=$null;$sql=$null}
