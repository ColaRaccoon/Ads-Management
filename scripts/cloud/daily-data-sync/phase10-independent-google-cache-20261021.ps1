Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
$adc=$null;$source=$null
try{
 $adc=(Read-IndependentIncidentFile (Join-Path $env:APPDATA 'gcloud/application_default_credentials.json') 65536)|ConvertFrom-Json -AsHashtable -Depth 20
 if($adc.type -cne 'impersonated_service_account' -or $adc.source_credentials.type -cne 'authorized_user'){throw 'ADC_TYPE'}
 $source=$adc.source_credentials;$fields=@();foreach($k in @('token','access_token','id_token','expiry','expiry_date','expires_at')){$fields+=@{field=$k;present=$source.ContainsKey($k);nonEmpty=($source.ContainsKey($k) -and [string]$source[$k] -ne '')}}
 if(@($fields|Where-Object nonEmpty).Count -gt 0){throw 'CACHE_REQUIRES_SEPARATE_BINDING_REVIEW'}
 $out=@{kind='GOOGLE_CACHED_ACCESS_ELIGIBILITY';status='NO_EXISTING_BOUND_CACHED_ACCESS_AVAILABLE';source='CURRENT_GCLOUD_ADC_SOURCE_CREDENTIALS';fields=$fields;credentialsDatabaseExists=(Test-Path -LiteralPath (Join-Path $env:APPDATA 'gcloud/credentials.db'));accessTokenDatabaseExists=(Test-Path -LiteralPath (Join-Path $env:APPDATA 'gcloud/access_tokens.db'));userinfoOrTokeninfoRequests=0;tokenRefreshPosts=0;gcloudAuthPrintExecuted=$false;rawIdentityOrSecretsReturned=0;reason='ADC_HAS_NO_ACCESS_OR_ID_TOKEN_OR_EXPIRY_AND_KNOWN_GCLOUD_CREDENTIAL_ACCESS_DBS_ABSENT'}
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/consumer-readonly-1343/google-cache-eligibility-v1.json';$f=[IO.File]::Open($path,[IO.FileMode]::CreateNew);try{$bytes=[Text.Encoding]::UTF8.GetBytes(($out|ConvertTo-Json -Depth 10));$f.Write($bytes);$f.Flush($true)}finally{$f.Dispose()}
 @{status=$out.status;path=$path;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();providerRequests=0}|ConvertTo-Json -Compress
}catch{@{status='SAFE_REJECTION';rawErrorSuppressed=$true;providerRequests=0}|ConvertTo-Json -Compress;exit 1}finally{$adc=$null;$source=$null}
