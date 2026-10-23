Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
$stage='LOCAL_ADC';$adc=$null;$capsule=$null;$baseline=$null;$config=$null;$bag=[Collections.Generic.List[string]]::new()
try{
 $baseline=Read-IncidentPrivate 'compromised-baseline'
 $adc=(Read-IndependentIncidentFile (Join-Path $env:APPDATA 'gcloud/application_default_credentials.json') 65536)|ConvertFrom-Json -AsHashtable -Depth 20
 $capsule=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($baseline.variables.PHASE08_GOOGLE_ADC_JSON_B64))|ConvertFrom-Json -AsHashtable -Depth 20
 if($adc.type -cne 'impersonated_service_account' -or $adc.source_credentials.type -cne 'authorized_user' -or $capsule.type -cne $adc.type){throw 'ADC_TYPE'}
 foreach($item in @($adc,$capsule)){foreach($name in @('client_secret','refresh_token')){[void]$bag.Add([string]$item.source_credentials[$name])}}
 $fields=@();foreach($name in @('account','email')){
  $present=$adc.source_credentials.ContainsKey($name);$value=if($present){[string]$adc.source_credentials[$name]}else{''}
  $capsulePresent=$capsule.source_credentials.ContainsKey($name);$other=if($capsulePresent){[string]$capsule.source_credentials[$name]}else{''}
  if($value){[void]$bag.Add($value)}
  $fields+=@{name=$name;present=$present;nonEmpty=($value.Length -gt 0);emailShaped=($value -cmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$');valueSha256=$(if($value){Get-IndependentIncidentStringHash $value}else{$null});capsuleFieldPresent=$capsulePresent;capsuleEqualsOriginal=($present -and $capsulePresent -and $value -ceq $other)}
 }
 $stage='LOCAL_CONFIG_METADATA';$configPath=Join-Path $env:APPDATA 'gcloud/configurations/config_default';$account='';$configExists=Test-Path -LiteralPath $configPath
 if($configExists -and (Get-Item -LiteralPath $configPath).Length -gt 0){$config=Read-IndependentIncidentFile $configPath 65536;$match=[regex]::Match($config,'(?m)^account\s*=\s*([^\r\n]+)$');if($match.Success){$account=$match.Groups[1].Value.Trim();[void]$bag.Add($account)}}
 $out=@{kind='INCIDENT_GOOGLE_LOCAL_IDENTITY_SCOPE';at=[DateTimeOffset]::UtcNow.ToString('o');sourceCredentialType='authorized_user';sourceFields=$fields;defaultConfigExists=$configExists;defaultConfigAccountNonEmpty=($account.Length -gt 0);defaultConfigAccountSha256=$(if($account){Get-IndependentIncidentStringHash $account}else{$null});defaultConfigMatchesAdcIdentity=(@($fields|Where-Object{$_.nonEmpty -and $_.valueSha256 -ceq (Get-IndependentIncidentStringHash $account)}).Count -gt 0);identityExternallyVerified=$false;grantedScopesExternallyVerified=$false;impersonatedTargetDoesNotBoundUnderlyingUserRefreshToken=$true;providerRequests=0;remoteMutations=0;rawIdentityOrSecretsReturned=0;protectedSourcesModified=0}
 $json=$out|ConvertTo-Json -Depth 8;Assert-IndependentIncidentOutput $json $bag
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/independent/google-local-scope-v1.json';$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$wire=[Text.Encoding]::UTF8.GetBytes($json);$stream.Write($wire)}finally{$stream.Dispose()};$json
}catch{@{kind='INCIDENT_GOOGLE_LOCAL_IDENTITY_SAFE_REJECTION';stage=$stage;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$adc=$null;$capsule=$null;$baseline=$null;$config=$null;$account=$null;$bag.Clear()}
