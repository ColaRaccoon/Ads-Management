param([Parameter(Mandatory)][string]$ConfigurationPath,[Parameter(Mandatory)][string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$context=$null;$input=$null;$sql=$null;$tokenBytes=$null;$submitted=$false;$verified=$false;$cleanupAttempted=$false;$stage='PUBLIC_PROOF'
function Remove-Phase08TemporaryVaultFunction([string]$ExpectedSourceSha256) {
 if($ExpectedSourceSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'cleanup-hash'}
 $cleanup=@'
BEGIN;
DO $guard$ DECLARE fn record; BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR to_regnamespace('storage_renewal_ops') IS NOT NULL OR
 NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped AND target_id='phase08-full-app' AND origin='https://phase08-daily-data-sync-production.up.railway.app') OR
 (SELECT count(*) FROM daily_data_sync_ops.schedules)<>3 OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE NOT paused) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.attempts)
 THEN RAISE EXCEPTION 'PHASE08_CLEANUP_REJECTED'; END IF;
 SELECT p.*,r.rolname,l.lanname INTO fn FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='daily_data_sync_ops' AND p.proname='bootstrap_machine' AND p.oid=to_regprocedure('daily_data_sync_ops.bootstrap_machine(text)');
 IF NOT FOUND THEN RETURN; END IF;
 IF fn.rolname<>'postgres' OR NOT fn.prosecdef OR fn.lanname<>'plpgsql' OR fn.prorettype<>'text'::regtype OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=""'] OR pg_catalog.encode(extensions.digest(fn.prosrc,'sha256'),'hex')<>'EXPECTED_SOURCE_SHA256' THEN RAISE EXCEPTION 'PHASE08_CLEANUP_FUNCTION_REJECTED'; END IF;
 REVOKE EXECUTE ON FUNCTION daily_data_sync_ops.bootstrap_machine(text) FROM phase08_runtime;
 REVOKE USAGE ON SCHEMA daily_data_sync_ops FROM phase08_runtime;
 DROP FUNCTION daily_data_sync_ops.bootstrap_machine(text);
END $guard$;
COMMIT;
'@
 $discard=Invoke-Phase08Management -Action Query -Query ($cleanup.Replace('EXPECTED_SOURCE_SHA256',$ExpectedSourceSha256));$discard=$null
 $status=Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY; SELECT to_regprocedure('daily_data_sync_ops.bootstrap_machine(text)') IS NULL AS removed,has_schema_privilege('phase08_runtime','daily_data_sync_ops','USAGE') AS schema_usage; ROLLBACK;"
 if(@($status).Count -ne 1 -or $status.removed -isnot [bool] -or -not $status.removed -or $status.schema_usage -isnot [bool] -or $status.schema_usage){throw 'cleanup-readback'}
}
try {
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 $file=Get-Item -LiteralPath $EvidencePath
 if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 65536){throw 'proof-file'}
 $envelope=[IO.File]::ReadAllText($file.FullName)|ConvertFrom-Json -AsHashtable -DateKind String -Depth 25
 $proof=Invoke-Phase08SchedulerNode @{action='validate';envelope=$envelope}
 if($proof.state -cne 'PHASE08_SIGNED_EVIDENCE_VERIFIED' -or $proof.payload.scheduleEnabled){throw 'proof'}
 $definitions=Read-Phase08SchedulerDefinitions $ConfigurationPath
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='LIVE_BASELINE';$graph=Get-Phase08SchedulerGraphState $context $pins;Get-Phase08SchedulerReady $context $pins|Out-Null
 if($graph.scheduleEnabled -or $graph.appSchedules.Count -ne 3){throw 'schedule-off-required'}
 $loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($definitions.definitions);appSchedules=@($graph.appSchedules);managementSchedules=@($proof.payload.managementSchedules)}
 if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED' -or ($graph.appSchedules|ConvertTo-Json -Depth 15 -Compress) -cne ($proof.payload.appSchedules|ConvertTo-Json -Depth 15 -Compress)){throw 'changed-proof-definitions'}
 Get-Phase08SchedulerDatabase $pins $definitions.ranges|Out-Null
 $before=Get-Phase08SchedulerSnapshot
 $check=Invoke-Phase08SchedulerNode @{action='snapshot';mode='configure';definitions=@($definitions.definitions);before=$before;after=$before}
 if($check.state -cne 'PHASE08_BATCH_READBACK_VERIFIED'){throw 'paused-baseline'}
 $counts=Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY; SELECT (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_08_machine') AS names,(SELECT count(*) FROM phase08_meta_ads.security_audit_events WHERE action='DAILY_SYNC_MACHINE_VAULT_CREATED') AS audits,to_regprocedure('daily_data_sync_ops.bootstrap_machine(text)') IS NOT NULL AS bootstrap_exists; ROLLBACK;"
 if(@($counts).Count -ne 1 -or $counts.names -isnot [long] -and $counts.names -isnot [int] -or $counts.audits -isnot [long] -and $counts.audits -isnot [int] -or $counts.names -ne 0 -or $counts.audits -ne 0 -or $counts.bootstrap_exists -isnot [bool] -or $counts.bootstrap_exists){throw 'inspect-existing-before-retry'}
 $input=@{action='inspect';projectRef='ehnfrrmbkvlsbpvqcvkr';freshVerified=$true;databaseUrl=$context.env.DATABASE_URL}
 $inspect=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'vault-root-bridge.mjs') $input
 if($inspect.state -cne 'PHASE08_VAULT_RUNTIME_LOGGING_VERIFIED'){throw 'logging'}
 $token=$context.env.DAILY_SYNC_MACHINE_TOKEN
 if($token -isnot [string] -or $token -cnotmatch '^[A-Za-z0-9+/]{43}=$'){throw 'machine-format'}
 $decoded=[Convert]::FromBase64String($token)
 try {if($decoded.Length -ne 32 -or [Convert]::ToBase64String($decoded) -cne $token){throw 'machine-format'}}finally{[Array]::Clear($decoded,0,$decoded.Length);$decoded=$null}
 $tokenBytes=[Text.Encoding]::UTF8.GetBytes($token);$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($tokenBytes)).ToLowerInvariant();[Array]::Clear($tokenBytes,0,$tokenBytes.Length);$tokenBytes=$null
 $expires=[DateTimeOffset]::UtcNow.AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
 $plan=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'vault-root-bridge.mjs') @{action='plan';plan=@{machineSha256=$hash;expiresAt=$expires}}
 if($plan.state -cne 'PHASE08_VAULT_PLAN_PREPARED' -or $plan.sql -isnot [string] -or $plan.functionSourceSha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'plan'}
 $functionHash=$plan.functionSourceSha256
 $stage='REGISTER';$sql=$plan.sql;$submitted=$true;$discard=Invoke-Phase08Management -Action Query -Query $sql;$sql=$null;$discard=$null;$plan=$null
 $stage='BOUND_PARAMETER';$input=@{action='bind';projectRef='ehnfrrmbkvlsbpvqcvkr';freshVerified=$true;databaseUrl=$context.env.DATABASE_URL;machineToken=$token;machineSha256=$hash};$token=$null
 $result=Invoke-Phase08ConfigurationChild (Join-Path $PSScriptRoot 'vault-root-bridge.mjs') $input;$input=$null
 if($result.state -cne 'PHASE08_MACHINE_VAULT_CREATED'){throw 'bind-outcome'}
 $stage='READBACK';$counts=Invoke-Phase08Management -Action Query -Query "BEGIN READ ONLY; SELECT (SELECT count(*) FROM vault.secrets WHERE name='daily_data_sync_08_machine') AS names,(SELECT count(*) FROM phase08_meta_ads.security_audit_events WHERE action='DAILY_SYNC_MACHINE_VAULT_CREATED' AND actor_type='SYSTEM' AND target_id='phase08-full-app' AND result='SUCCESS') AS audits,has_schema_privilege('phase08_runtime','daily_data_sync_ops','USAGE') AS schema_usage,has_function_privilege('phase08_runtime','daily_data_sync_ops.bootstrap_machine(text)','EXECUTE') AS function_execute; ROLLBACK;"
 if(@($counts).Count -ne 1 -or $counts.names -ne 1 -or $counts.audits -ne 1 -or $counts.schema_usage -isnot [bool] -or $counts.schema_usage -or $counts.function_execute -isnot [bool] -or $counts.function_execute){throw 'readback'}
 $after=Get-Phase08SchedulerSnapshot;$check=Invoke-Phase08SchedulerNode @{action='snapshot';mode='configure';definitions=@($definitions.definitions);before=$before;after=$after}
 if($check.state -cne 'PHASE08_BATCH_READBACK_VERIFIED'){throw 'preservation'}
 $stage='REMOVE_TEMPORARY_FUNCTION'
 $cleanupAttempted=$true;Remove-Phase08TemporaryVaultFunction $functionHash
 $discard=$null;$verified=$true
 @{state='PHASE08_MACHINE_VAULT_INSTALL_VERIFIED';vaultNames=1;systemAudits=1;temporaryAccessRevoked=$true;temporaryFunctionRemoved=$true;secretValuesReturned=0;providerRequests=0;retryPerformed=$false}|ConvertTo-Json -Compress
} catch {$cleanupState='NOT_REQUIRED';if($submitted -and -not $verified){$cleanupState='CLEANUP_UNCERTAIN_INSPECT_REQUIRED';if(-not $cleanupAttempted){$cleanupAttempted=$true;try{Remove-Phase08TemporaryVaultFunction $functionHash;$cleanupState='TEMPORARY_ACCESS_REMOVED'}catch{}}};@{state='PHASE08_MACHINE_VAULT_INSTALL_FAILED';stage=$stage;outcomeUncertain=($submitted -and -not $verified);cleanupState=$cleanupState;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally {$context=$null;$token=$null;$input=$null;$sql=$null;$plan=$null;$envelope=$null;$cleanup=$null;if($tokenBytes){[Array]::Clear($tokenBytes,0,$tokenBytes.Length)}}
