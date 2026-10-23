Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';$InformationPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
$stage='LOCAL_SOURCE_BINDING';$baseline=$null;$capsule=$null;$adc=$null;$payload=$null;$wire=$null;$child=$null;$bag=[Collections.Generic.List[string]]::new()
try {
 $baseline=Read-IncidentPrivate 'compromised-baseline'
 if($baseline.version -ne 1 -or $baseline.scope.e -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3'){throw 'BASELINE_BINDING'}
 $capsuleText=[string]$baseline.variables.PHASE08_GOOGLE_ADC_JSON_B64
 $capsule=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($capsuleText))|ConvertFrom-Json -AsHashtable -Depth 20
 $gcloud=Join-Path $env:APPDATA 'gcloud'
 $adc=(Read-IndependentIncidentFile (Join-Path $gcloud 'application_default_credentials.json') 65536)|ConvertFrom-Json -AsHashtable -Depth 20
 foreach($source in @($capsule,$adc)){if($source.type -cne 'impersonated_service_account' -or $source.source_credentials.type -cne 'authorized_user'){throw 'ADC_TYPE'};foreach($key in @('client_id','client_secret','refresh_token')){if([string]$source.source_credentials[$key] -eq ''){throw 'ADC_FIELD'};[void]$bag.Add([string]$source.source_credentials[$key])}}
 [void]$bag.Add($capsuleText)
 $expectedTarget='https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/daily-data-automation-ads-read@meta-ads-daily-automation.iam.gserviceaccount.com:generateAccessToken'
 $identity=@();foreach($name in @('account','email')){$present=$adc.source_credentials.ContainsKey($name) -and [string]$adc.source_credentials[$name] -ne '';if($present){[void]$bag.Add([string]$adc.source_credentials[$name])};$identity+=@{field=$name;nonEmpty=$present;identitySha256=$(if($present){Get-IndependentIncidentStringHash ([string]$adc.source_credentials[$name])}else{$null})}}
 $configAccount='';$configPath=Join-Path $gcloud 'configurations/config_default'
 if(Test-Path -LiteralPath $configPath){$config=Read-IndependentIncidentFile $configPath 65536;$m=[regex]::Match($config,'(?m)^account\s*=\s*([^\r\n]+)$');if($m.Success){$configAccount=$m.Groups[1].Value.Trim();[void]$bag.Add($configAccount)}}
 $sourceProof=@{capsuleAndAdcClientIdEqual=($capsule.source_credentials.client_id -ceq $adc.source_credentials.client_id);capsuleAndAdcClientSecretEqual=($capsule.source_credentials.client_secret -ceq $adc.source_credentials.client_secret);capsuleAndAdcRefreshEqual=($capsule.source_credentials.refresh_token -ceq $adc.source_credentials.refresh_token);expectedImpersonatedTargetBoth=($capsule.service_account_impersonation_url -ceq $expectedTarget -and $adc.service_account_impersonation_url -ceq $expectedTarget);sourceType='AUTHORIZED_USER';adcType='IMPERSONATED_SERVICE_ACCOUNT';sourceClientIdSha256=(Get-IndependentIncidentStringHash $adc.source_credentials.client_id);identityFields=$identity;configAccountNonEmpty=($configAccount.Length -gt 0);configAccountSha256=$(if($configAccount){Get-IndependentIncidentStringHash $configAccount}else{$null});configMatchesAdcIdentity=(@($identity|Where-Object {$_.nonEmpty -and $_.identitySha256 -ceq (Get-IndependentIncidentStringHash $configAccount)}).Count -gt 0);cloudsdkConfigOverridePresent=([string]$env:CLOUDSDK_CONFIG -ne '');googleApplicationCredentialsOverridePresent=([string]$env:GOOGLE_APPLICATION_CREDENTIALS -ne '')}
 foreach($key in @('capsuleAndAdcClientIdEqual','capsuleAndAdcClientSecretEqual','capsuleAndAdcRefreshEqual','expectedImpersonatedTargetBoth')){if(-not $sourceProof[$key]){throw 'SOURCE_DIFFERENCE'}}
 $roots=@(@{label='WORKSPACE';path='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance'},@{label='GCLOUD';path=$gcloud},@{label='STAGING_LOCAL_REFERENCE';path=(Join-Path $env:APPDATA 'MetaAdsSecurity/staging-app-runtime')},@{label='PHASE08_RUNTIME';path=(Join-Path $env:LOCALAPPDATA 'MetaAdsPhase08Runtime')},@{label='PHASE08_EVIDENCE';path=(Join-Path $env:LOCALAPPDATA 'MetaAdsPhase08Evaluation')},@{label='PHASE10_EVIDENCE';path=(Join-Path $env:LOCALAPPDATA 'MetaAdsPhase10Evaluation')},@{label='INCIDENT_EVIDENCE';path=(Join-Path $env:LOCALAPPDATA 'MetaAdsPhase10Incident20261019')})
 $payload=@{expected=$capsule.source_credentials;capsule=$capsuleText;roots=$roots;gcloud=$gcloud}
 $stage='BOUNDED_LOCAL_SCAN';$python='C:/Users/seong/AppData/Local/Programs/Python/Python313/python.exe'
 if(-not(Test-Path -LiteralPath $python)){throw 'PYTHON_MISSING'}
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$python;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 [void]$start.ArgumentList.Add('-B');[void]$start.ArgumentList.Add((Join-Path $PSScriptRoot 'phase10-independent-google-consumers-20261021.py'))
 $start.StandardInputEncoding=[Text.UTF8Encoding]::new($false)
 $child=[Diagnostics.Process]::new();$child.StartInfo=$start;if(-not $child.Start()){throw 'CHILD_START'}
 $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
 $wire=$payload|ConvertTo-Json -Depth 25 -Compress;$child.StandardInput.Write($wire);$child.StandardInput.Close();$wire=$null;$payload=$null
 if(-not $child.WaitForExit(90000)){try{$child.Kill($true)}catch{};throw 'CHILD_TIMEOUT'}
 $text=$stdout.GetAwaiter().GetResult();$discarded=$stderr.GetAwaiter().GetResult();if($child.ExitCode -ne 0 -or $discarded.Length -ne 0){throw 'CHILD_SAFE_REJECTION'}
 Assert-IndependentIncidentOutput $text $bag
 $proof=$text|ConvertFrom-Json -AsHashtable -Depth 30;$proof.sourceBinding=$sourceProof;$proof.at=[DateTimeOffset]::UtcNow.ToString('o');$proof.protectedBaselineReadOnly=$true;$proof.remoteMutations=0;$proof.oauthOrIamChanges=0;$proof.rawIdentityOrSecretsReturned=0
 $proof.toolPins=@{};foreach($name in @('phase10-independent-google-consumers-20261021.ps1','phase10-independent-google-consumers-20261021.py')){$proof.toolPins[$name]=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
 $json=$proof|ConvertTo-Json -Depth 35;Assert-IndependentIncidentOutput $json $bag
 $dir='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/consumer-readonly-1343';[void][IO.Directory]::CreateDirectory($dir);$destination=Join-Path $dir 'google-local-consumers-v1.json'
 $file=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.Encoding]::UTF8.GetBytes($json);$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
 @{status=$proof.status;path=$destination;sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant();filesRead=$proof.counters.filesRead;bytesRead=$proof.counters.bytesRead;matchingFiles=$proof.matches.Count;providerRequests=0;rawIdentityOrSecretsReturned=0}|ConvertTo-Json -Compress
} catch {@{status='SAFE_REJECTION';stage=$stage;rawErrorSuppressed=$true;providerRequests=0;rawIdentityOrSecretsReturned=0}|ConvertTo-Json -Compress;exit 1}
finally {if($child){$child.Dispose()};$baseline=$null;$capsule=$null;$capsuleText=$null;$adc=$null;$payload=$null;$wire=$null;$text=$null;$discarded=$null;$config=$null;$configAccount=$null;$bag.Clear()}
