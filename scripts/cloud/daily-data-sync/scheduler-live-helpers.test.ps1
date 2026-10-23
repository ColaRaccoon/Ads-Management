. "$PSScriptRoot/scheduler-live-helpers.ps1"
Import-Phase08SchedulerChildDefinitions
$pins=Invoke-Phase08SchedulerNode @{action='pins'}
if($pins.identity.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr'){throw 'definition-extraction'}
$files=@('scheduler-live-helpers.ps1','prepare-scheduler-evidence.ps1','apply-scheduler-batch.ps1')
foreach($file in $files){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors);if($errors.Count){throw 'syntax'}}
if(-not (Test-Phase08BusinessDiagnostic 'TARGET' 'TARGET_CERTIFICATE_REJECTED')){throw 'typed-helper'}
if(Test-Phase08BusinessDiagnostic 'TARGET' @('P1011','SYNTHETIC_PRIVATE')){throw 'diagnostic-array'}
# Actual child invocation contains public pins only; protected inputs and network are never invoked.
@{state='PHASE08_SCHEDULER_DEFINITIONS_PASS';cases=5;networkCalls=0;protectedReads=0}|ConvertTo-Json -Compress
