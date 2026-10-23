param([Parameter(Mandatory)][ValidateSet('weekly','cafe')][string]$Mode)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
$stage='IDENTITY';$context=$null
try{
 Import-Phase08SchedulerChildDefinitions;$pins=Get-Phase08SchedulerPins
 if($pins.sourceSha -cne 'f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df'){throw 'source'}
 $context=Read-Phase08ProtectedJson;Assert-Phase08SchedulerContext $context $pins
 $output=Assert-Phase08SchedulerOutputPath ("C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/october16-repeat-$Mode-proof-actual-20261016.json")
 $stage='FIXED_READONLY';$action=if($Mode -ceq 'weekly'){'weekly-sql'}elseif($Mode -ceq 'cafe'){'cafe-sql'}else{'first-unit-sql'}
 $p=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-proof.mjs" @{action=$action}
 $expected=if($Mode -ceq 'weekly'){'META_WEEKLY_SQL_PREPARED'}elseif($Mode -ceq 'cafe'){'CAFE_AFTERNOON_SQL_PREPARED'}else{'META_FIRST_UNIT_SQL_PREPARED'}
 if($p.state -cne $expected -or $p.sql -isnot [string] -or $p.sql.Length -gt 65536 -or -not $p.sql.StartsWith('BEGIN READ ONLY;') -or -not $p.sql.EndsWith('COMMIT;')){throw 'sql'}
 $rows=@(Invoke-Phase08Management -Action Query -Query $p.sql);$project=if($Mode -ceq 'weekly'){'project-weekly'}elseif($Mode -ceq 'cafe'){'project-cafe'}else{'project-first-unit'}
 $stage='STRICT_PROJECT';$out=Invoke-Phase08ConfigurationChild "$PSScriptRoot/october16-repeat-proof.mjs" @{action=$project;rows=@($rows)}
 $wanted=if($Mode -ceq 'weekly'){'PHASE08_META_AFTERNOON_WEEKLY_READONLY'}elseif($Mode -ceq 'cafe'){'PHASE08_CAFE_AFTERNOON_READONLY'}else{'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT'}
 if($out.state -cne $wanted -or $out.verified -isnot [bool] -or -not $out.verified){throw 'not-complete'}
 $out['classification']=if($Mode -ceq 'weekly'){'OCTOBER16_SCHEDULED_WEEKLY_POST_PUBLISH_READONLY'}elseif($Mode -ceq 'cafe'){'OCTOBER16_CAFE_DAY15_POST_PUBLISH_READONLY'}else{'OCTOBER16_FIRST_DAY09_COMMITTED_FINGERPRINT'}
 $out['mode']=$Mode;$out['sourceSha']=$pins.sourceSha;$out['deploymentId']=$pins.deploymentId;$out['observedAt']=[DateTimeOffset]::UtcNow.ToString('o');$out['appHttpRequests']=0
 $null=Write-Phase08SchedulerPublicEvidence $out $output;$out|ConvertTo-Json -Depth 6 -Compress
}catch{@{state='PHASE08_OCTOBER16_PROOF_FAILED';stage=$stage;mode=$Mode;providerRequests=0;appHttpRequests=0;databaseWrites=0;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}finally{$context=$null;$rows=$null;$out=$null}
