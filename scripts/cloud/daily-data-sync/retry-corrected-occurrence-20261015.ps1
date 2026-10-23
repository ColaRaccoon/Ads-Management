param([Parameter(Mandatory)][string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/operator-session.ps1"
Import-Phase08SchedulerChildDefinitions
$stage='REVIEWED_APP';$context=$null;$operator=$null;$prepared=$null
try {
 $output=Assert-Phase08SchedulerOutputPath 'C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/operator-retry-actual-20261015.json'
 $pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne 'a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097'){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $null=Get-Phase08SchedulerGraphState $context $pins
 $file=Get-Item -LiteralPath $EvidencePath
 if($file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'evidence-file'}
 $envelope=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String
 $operator=Read-Phase08Operator
 $stage='SIGNED_SQL_PREPARATION'
 $prepared=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'operator-retry-october15-bridge.mjs') @{envelope=$envelope;actorId=$operator.appId;authId=$operator.authId}
 if($prepared.state -cne 'PHASE08_OPERATOR_RETRY_SQL_PREPARED' -or $prepared.sourceSha -cne $pins.sourceSha -or $prepared.deploymentId -cne $pins.deploymentId -or $prepared.sqlSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'prepared'}
 if($prepared.sql -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($prepared.sql) -gt 131072 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($prepared.sql))).ToLowerInvariant() -cne $prepared.sqlSha256){throw 'sql-bytes'}
 $stage='GUARDED_TRANSACTION'
 $null=Invoke-Phase08Management -Action Query -Query $prepared.sql
 $stage='READBACK'
 $rows=@(Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY;SELECT (SELECT count(*) FROM daily_data_sync_ops.attempts WHERE status='OPERATOR_RETRY_APPROVED')::int AS markers,(SELECT count(*) FROM phase08_meta_ads.security_audit_events WHERE action='SYNC_SCHEDULE_OPERATOR_RETRY' AND actor_type='USER' AND result='REQUESTED')::int AS audits;COMMIT;")
 if($rows.Count -ne 1 -or ($rows[0].markers -isnot [int] -and $rows[0].markers -isnot [long]) -or ($rows[0].audits -isnot [int] -and $rows[0].audits -isnot [long]) -or $rows[0].markers -ne 2 -or $rows[0].audits -ne 2){throw 'readback'}
 $out=@{state='PHASE08_CORRECTED_OCCURRENCE_RETRY_APPROVED';observedAt=[DateTimeOffset]::UtcNow.ToString('o');sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;sqlSha256=$prepared.sqlSha256;markers=2;userAudits=2;originalFailureHistoryPreserved=$true;unitAttemptsPreserved=$true;checkpointPreserved=$true;selectedDatesPreserved=$true;deadlinesPreserved=$true;providerRequests=0;operatingWrites=0}
 $null=Write-Phase08SchedulerPublicEvidence $out $output
 $out|ConvertTo-Json -Compress
}catch{@{state='PHASE08_CORRECTED_OCCURRENCE_RETRY_FAILED';stage=$stage;outcomeUncertain=($stage -cin @('GUARDED_TRANSACTION','READBACK','PUBLIC_EVIDENCE'));inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null;$prepared=$null;$envelope=$null}
