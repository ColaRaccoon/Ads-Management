Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/consumers-localreadonly21-v2.ps1"
$adc=@{type='impersonated_service_account';source_credentials=@{type='authorized_user';client_secret='SYNTHETIC_GOOGLE_CLIENT_SECRET';refresh_token='SYNTHETIC_GOOGLE_REFRESH_TOKEN'}}|ConvertTo-Json -Compress
$v=@{SUPABASE_DATABASE_PROJECT_REF='ehnfrrmbkvlsbpvqcvkr';SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_SECRET_KEY='SYNTHETIC_SUPABASE_SECRET';DAILY_SYNC_CAFE24_CLIENT_SECRET='SYNTHETIC_CAFE_CLIENT_SECRET';PHASE08_GOOGLE_ADC_JSON_B64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($adc));DAILY_SYNC_META_VAULT_KEY='SYNTHETIC_META_VAULT_KEY';PHASE08_META_RECORD_B64='SYNTHETIC_META_SEALED_RECORD'}
$m=Get-ConsumersSharedMaterial $v ('SYNTHETIC_MCP_TOKEN_'*4) ('SYNTHETIC_INSPECTOR_TOKEN_'*4);if($m.Keys.Count -ne 4 -or $m.GOOGLE.literals.Count -ne 2 -or $m.META.literals.Count -ne 3 -or $m.GOOGLE.encoded.Count -ne 1){throw 'MATERIAL_SYNTHETIC'}
$v.SUPABASE_DATABASE_SCHEMA='public';$rejected=$false;try{$null=Get-ConsumersSharedMaterial $v ('A'*80) ('B'*80)}catch{$rejected=$true};if(-not $rejected){throw 'WRONG_SCOPE'}
$v.SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';$v.PHASE08_GOOGLE_ADC_JSON_B64='!bad!';$rejected=$false;try{$null=Get-ConsumersSharedMaterial $v ('A'*80) ('B'*80)}catch{$rejected=$true};if(-not $rejected){throw 'BAD_B64'}
$pins=Get-ConsumersLocalPins;if($pins.Count -ne 6){throw 'PINS'}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('consumer-local-dispatch-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($testRoot)
try{
 foreach($name in @('consumers-localreadonly21.mjs','consumer-meta-readonly-v2-20261021.ps1','phase10-independent-incident-inventory.ps1','incident-common.ps1','scheduler-live-helpers.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $testRoot $name)}
 $stub=@'
param([switch]$Execute)
function Write-MetaConsumerNew { throw 'SYNTHETIC_EXECUTE_REACHED_BEFORE_PROTECTED_READ' }
function Get-MetaConsumerFailureMetadata { return @{errorId='SYNTHETIC'} }
'@
 [IO.File]::WriteAllText((Join-Path $testRoot 'mock-dot.ps1'),$stub,[Text.UTF8Encoding]::new($false))
 $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'consumers-localreadonly21-v2.ps1')).Replace('. "$PSScriptRoot/consumer-meta-readonly-v2-20261021.ps1"','. "$PSScriptRoot/mock-dot.ps1"');[IO.File]::WriteAllText((Join-Path $testRoot 'consumers-localreadonly21-v2.ps1'),$source,[Text.UTF8Encoding]::new($false))
 $actual=@(& pwsh -NoProfile -File (Join-Path $testRoot 'consumers-localreadonly21-v2.ps1') -Execute 2>$null);$actualResult=($actual -join '')|ConvertFrom-Json -AsHashtable;if($actualResult.stage -cne 'ATTEMPT' -or $actualResult.status -cne 'SAFE_FAILURE' -or $actualResult.remoteRequests -ne 0){throw 'EXECUTE_DISPATCH_NOT_PRESERVED'}
 $ready=@(& pwsh -NoProfile -File (Join-Path $testRoot 'consumers-localreadonly21-v2.ps1') 2>$null);$readyResult=($ready -join '')|ConvertFrom-Json -AsHashtable;if($readyResult.status -cne 'READY_NOT_EXECUTED'){throw 'NON_EXECUTE_DISPATCH'}
}finally{if([IO.Path]::GetFullPath($testRoot).StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $testRoot -Recurse -Force}}
@{kind='CONSUMERS_LOCAL_ONLY_PS_TESTS';passed=6;protectedReads=0;remoteRequests=0;remoteWrites=0}|ConvertTo-Json -Compress
