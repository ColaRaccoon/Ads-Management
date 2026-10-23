param([Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')][string]$ArtifactId)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/meta-day09-diagnostic-protected.ps1"
$context=$null;$key=$null;$material=$null;$out=$null;$envCopy=$null;$stage='OUTPUT_PREFLIGHT';$childStage=$null
try{
 Import-Phase08SchedulerChildDefinitions
 $output=Assert-Phase08SchedulerOutputPath ('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/meta-day09-link-gates-'+$ArtifactId+'-actual-20261015.json')
 $stage='LOCAL_PROTECTED_CONTEXT';$context=Read-Phase08ProtectedJson
 if($context.ids.metaConnectionId -cne '1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'){throw 'local-connection-binding'}
 $stage='LOCAL_CAPTURE_KEY';$key=Read-Phase08MetaDay09DiagnosticKey
 # The immutable context predates the public connection-ID variable. Bind its
 # original ID to the exact same reviewed connection without any network call.
 $stage='LOCAL_META_METADATA';$envCopy=$context.env|ConvertTo-Json -Depth 25 -Compress|ConvertFrom-Json -AsHashtable -Depth 25 -DateKind String
 $envCopy.PHASE08_META_CONNECTION_ID='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6'
 $material=@{projectRef='ehnfrrmbkvlsbpvqcvkr';day='2026-10-09';classification='MANUAL_DIAGNOSTIC';mode='offline';artifactId=$ArtifactId;captureKeyB64=$key;env=$envCopy}
 $stage='OFFLINE_CIPHER_CLASSIFIER'
 $out=Invoke-Phase08ConfigurationChild "$PSScriptRoot/meta-day09-link-result.mjs" $material
 if($out.state -ceq 'PHASE08_META_MANUAL_DIAGNOSTIC_FAILED'){
  if($out.stage -is [string] -and $out.stage -cin @('INPUT','DIRECTORY','METADATA','SEAL','CLASSIFY')){$childStage=$out.stage};throw 'child-diagnostic-rejected'
 }
 $stage='CLOSED_PUBLIC_PROJECTION'
 $out=Invoke-Phase08ConfigurationChild "$PSScriptRoot/meta-day09-link-result.mjs" @{action='project';value=$out}
 if($out.state -cne 'PHASE08_META_DAY09_LINK_GATES' -or $out.classification -cne 'MANUAL_DIAGNOSTIC' -or $out.day -cne '2026-10-09' -or $out.stage -cne 'LINK_GATE_DIAGNOSTIC' -or $out.offlineOnly -isnot [bool] -or -not $out.offlineOnly){throw 'summary'}
 foreach($name in @('providerRequests','databaseWrites','rawValuesReturned')){if(($out[$name] -isnot [int] -and $out[$name] -isnot [long]) -or $out[$name] -ne 0){throw 'boundary'}}
 $stage='PUBLIC_EVIDENCE';$null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Compress -Depth 12
}catch{@{state='PHASE08_META_DAY09_LINK_DIAGNOSTIC_REJECTED';stage=$stage;childStage=$childStage;rawErrorSuppressed=$true;providerRequests=0;databaseWrites=0}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$key=$null;$material=$null;$out=$null;$envCopy=$null}
