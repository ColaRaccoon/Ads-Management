Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/consumers-localreadonly21.ps1"
$adc=@{type='impersonated_service_account';source_credentials=@{type='authorized_user';client_secret='SYNTHETIC_GOOGLE_CLIENT_SECRET';refresh_token='SYNTHETIC_GOOGLE_REFRESH_TOKEN'}}|ConvertTo-Json -Compress
$v=@{SUPABASE_DATABASE_PROJECT_REF='ehnfrrmbkvlsbpvqcvkr';SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';SUPABASE_SECRET_KEY='SYNTHETIC_SUPABASE_SECRET';DAILY_SYNC_CAFE24_CLIENT_SECRET='SYNTHETIC_CAFE_CLIENT_SECRET';PHASE08_GOOGLE_ADC_JSON_B64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($adc));DAILY_SYNC_META_VAULT_KEY='SYNTHETIC_META_VAULT_KEY';PHASE08_META_RECORD_B64='SYNTHETIC_META_SEALED_RECORD'}
$m=Get-ConsumersSharedMaterial $v ('SYNTHETIC_MCP_TOKEN_'*4) ('SYNTHETIC_INSPECTOR_TOKEN_'*4);if($m.Keys.Count -ne 4 -or $m.GOOGLE.literals.Count -ne 2 -or $m.META.literals.Count -ne 3 -or $m.GOOGLE.encoded.Count -ne 1){throw 'MATERIAL_SYNTHETIC'}
$v.SUPABASE_DATABASE_SCHEMA='public';$rejected=$false;try{$null=Get-ConsumersSharedMaterial $v ('A'*80) ('B'*80)}catch{$rejected=$true};if(-not $rejected){throw 'WRONG_SCOPE'}
$v.SUPABASE_DATABASE_SCHEMA='phase08_meta_ads';$v.PHASE08_GOOGLE_ADC_JSON_B64='!bad!';$rejected=$false;try{$null=Get-ConsumersSharedMaterial $v ('A'*80) ('B'*80)}catch{$rejected=$true};if(-not $rejected){throw 'BAD_B64'}
$pins=Get-ConsumersLocalPins;if($pins.Count -ne 6){throw 'PINS'}
@{kind='CONSUMERS_LOCAL_ONLY_PS_TESTS';passed=4;protectedReads=0;remoteRequests=0;remoteWrites=0}|ConvertTo-Json -Compress
