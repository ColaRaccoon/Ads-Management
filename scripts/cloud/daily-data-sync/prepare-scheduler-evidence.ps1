param([Parameter(Mandatory)][string]$ConfigurationPath,[Parameter(Mandatory)][string]$OutputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='PUBLIC_PINS';$context=$null;$envelope=$null
try {
 Import-Phase08SchedulerChildDefinitions
 $pins=Get-Phase08SchedulerPins
 $output=Assert-Phase08SchedulerOutputPath $OutputPath
 $definition=Read-Phase08SchedulerDefinitions $ConfigurationPath
 $stage='PROTECTED_CONTEXT';$context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $stage='GRAPH';$graph=Get-Phase08SchedulerGraphState $context $pins
 $stage='READY';$ready=Get-Phase08SchedulerReady $context $pins
 $stage='DATABASE';$database=Get-Phase08SchedulerDatabase $pins $definition.ranges
 $snapshot=Get-Phase08SchedulerSnapshot
 $stage='RUNTIME_READONLY';Get-Phase08SchedulerRuntimeProof $context
 $now=[DateTimeOffset]::UtcNow
 $payload=[ordered]@{kind='PHASE08_ROOT_REVIEWED_DEPLOYMENT_V1';identity=$pins.identity;sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;deploymentStatus=$graph.deploymentStatus;
  observedAt=$now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');expiresAt=$now.AddMinutes(10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');graphObservedAt=$graph.observedAt;readyObservedAt=$ready.observedAt;databaseObservedAt=$database.observedAt;
  database=$database.database;connections=@($database.connections);appSchedules=@($graph.appSchedules);
  managementSchedules=@($snapshot.snapshot.schedules|ForEach-Object {[ordered]@{key=$_.key;connectionId=$_.connectionId;provider=$_.provider;anchorAt=$_.anchorAt;windowMinutes=$_.windowMinutes;cadenceDays=$_.cadenceDays}});
  featureEnabled=$graph.featureEnabled;scheduleEnabled=$graph.scheduleEnabled}
 $stage='LOADED_DEFINITIONS';$loaded=Invoke-Phase08SchedulerNode @{action='loaded';definitions=@($definition.definitions);appSchedules=@($payload.appSchedules);managementSchedules=@($payload.managementSchedules)}
 if($loaded.state -cne 'PHASE08_LOADED_DEFINITIONS_VERIFIED'){throw 'loaded-definitions'}
 $stage='SIGN';$envelope=Sign-Phase08SchedulerEvidence $payload
 $validated=Invoke-Phase08SchedulerNode @{action='validate';envelope=$envelope}
 if($validated.state -cne 'PHASE08_SIGNED_EVIDENCE_VERIFIED'){throw 'signed-readback'}
 $stage='PUBLIC_FILE';$path=Write-Phase08SchedulerPublicEvidence $envelope $output
 @{state='PHASE08_DEPLOYMENT_EVIDENCE_PREPARED';file=$path;sourceSha=$pins.sourceSha;deploymentId=$pins.deploymentId;expiresAt=$payload.expiresAt;databaseWrites=0;providerRequests=0;privateValuesReturned=0}|ConvertTo-Json -Compress
} catch {@{state='PHASE08_DEPLOYMENT_EVIDENCE_FAILED';stage=$stage;rawErrorSuppressed=$true;retryPerformed=$false}|ConvertTo-Json -Compress;exit 1}
finally {$context=$null;$envelope=$null;$payload=$null;$graph=$null;$database=$null;$snapshot=$null}
