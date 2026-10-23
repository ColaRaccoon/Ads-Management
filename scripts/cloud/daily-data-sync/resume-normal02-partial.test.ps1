Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. "$PSScriptRoot/resume-normal02-partial.ps1" -EvidencePath synthetic
$good=[pscustomobject]@{state='PHASE08_NORMAL02_PARTIALLY_RESUMED';global_stopped=$false;meta_paused=$true;business_history_preserved=$true;original_weekly_succeeded=$false;active_jobs=[long]149;uncollected_old_dates=[long]7}
$out=Assert-Phase08PartialResumeResult @($good);if($out.metaPaused -isnot [bool] -or -not $out.metaPaused -or $out.uncollectedOldDates -ne 7){throw 'synthetic'}
$good.meta_paused=$false;$rejected=$false;try{Assert-Phase08PartialResumeResult @($good)|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'synthetic'}
@{state='PHASE08_PARTIAL_RESUME_PROJECTION_SYNTHETIC_PASS';checks=2;network=0}|ConvertTo-Json -Compress
