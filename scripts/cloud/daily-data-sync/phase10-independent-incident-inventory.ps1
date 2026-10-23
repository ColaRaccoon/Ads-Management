param([ValidatePattern('^[a-z0-9-]+$')][string]$Label='shared-scope-v1')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$WarningPreference='SilentlyContinue';$InformationPreference='SilentlyContinue';$VerbosePreference='SilentlyContinue';$DebugPreference='SilentlyContinue'
. "$PSScriptRoot/incident-common.ps1"
function Get-IndependentIncidentStringHash([string]$Value){return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()}
function Assert-IndependentIncidentOutput([string]$Text,$Secrets){
 if($Text.Length -gt 131072){throw 'SAFE_OUTPUT_SIZE'}
 foreach($value in $Secrets){if($value -is [string] -and $value.Length -ge 8 -and $Text.Contains($value,[StringComparison]::Ordinal)){throw 'SAFE_OUTPUT_SECRET_MATCH'}}
 if($Text -match 'sb_secret_[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|postgres(?:ql)?://'){throw 'SAFE_OUTPUT_SECRET_PATTERN'}
}
function Read-IndependentIncidentFile([string]$Path,[int]$Limit=65536,[switch]$Private){
 $full=[IO.Path]::GetFullPath($Path);$current=$full
 while($current){$item=Get-Item -LiteralPath $current;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'LOCAL_REPARSE'};$current=[IO.Path]::GetDirectoryName($current)}
 if($Private){Assert-Phase08PrivatePath -Path $full}
 $info=Get-Item -LiteralPath $full;if($info.PSIsContainer -or $info.Length -lt 1 -or $info.Length -gt $Limit){throw 'LOCAL_SIZE'}
 return [IO.File]::ReadAllText($full)
}
function Read-IndependentIncidentMetaToken([string]$Name){
 if($Name -cnotin @('mcp-access-token.dpapi','inspector-token.dpapi')){throw 'META_NAME'}
 $path=Join-Path 'C:/Users/seong/AppData/Local/MetaAdsMetaIsolated' $Name;Assert-Phase08PrivatePath -Path $path
 $all=$null;$cipher=$null;$plain=$null
 try{$all=[IO.File]::ReadAllBytes($path);if($all.Length -lt 32 -or $all.Length -gt 16384){throw 'META_SIZE'};$magic=[Text.Encoding]::ASCII.GetBytes('META-DPAPI-1');for($i=0;$i -lt $magic.Length;$i++){if($all[$i] -ne $magic[$i]){throw 'META_MAGIC'}};$cipher=$all[$magic.Length..($all.Length-1)];$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::ASCII.GetBytes('MetaAdsMetaIsolated/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);if($plain.Length -lt 40 -or $plain.Length -gt 4096){throw 'META_TOKEN_SIZE'};foreach($byte in $plain){if($byte -lt 33 -or $byte -gt 126){throw 'META_FORMAT'}};return [Text.Encoding]::ASCII.GetString($plain)}
 finally{foreach($bytes in @($all,$cipher,$plain)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}}
}
function Get-IndependentIncidentKeyClass([string]$Value){
 if($Value -cmatch '^sb_secret_[A-Za-z0-9_-]+$'){return @{kind='OPAQUE_SECRET_API_KEY';roleClass='PRIVILEGED_PROJECT_KEY';projectClaimMatches=$null}}
 if($Value -cmatch '^sb_publishable_[A-Za-z0-9_-]+$'){return @{kind='PUBLISHABLE_API_KEY';roleClass='PUBLIC';projectClaimMatches=$null}}
 if($Value -cmatch '^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'){
  $part=$Value.Split('.')[1].Replace('-','+').Replace('_','/');$bytes=$null;$c=$null
  try{$bytes=[Convert]::FromBase64String($part.PadRight($part.Length+(4-$part.Length%4)%4,'='));$c=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json -AsHashtable -Depth 8;$role=if($c.ContainsKey('role') -and $c.role -cin @('anon','authenticated','service_role','phase08_storage_app')){$c.role}else{'UNKNOWN'};return @{kind='LEGACY_JWT';roleClass=$role;projectClaimMatches=($c.ContainsKey('ref') -and $c.ref -ceq 'ehnfrrmbkvlsbpvqcvkr')}}finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};$c=$null}
 }
 return @{kind='UNKNOWN';roleClass='UNKNOWN';projectClaimMatches=$null}
}
function Invoke-IndependentIncidentMetadata([ValidateSet('keys','edge-secrets','functions','postgrest')][string]$Kind){
 $token=$null;$headers=$null;$response=$null
 try{$token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)};$path=switch($Kind){'keys'{'/api-keys?reveal=true'}'edge-secrets'{'/secrets'}'functions'{'/functions'}'postgrest'{'/postgrest'}};$response=Invoke-WebRequest -Uri ('https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'+$path) -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck;if([int]$response.StatusCode -ne 200 -or $response.Content.Length -gt 2097152){throw 'METADATA_REPLY'};return ($response.Content|ConvertFrom-Json -AsHashtable -Depth 20 -DateKind String)}
 finally{if($headers){$headers.Clear()};$token=$null;$response=$null}
}
function Get-IndependentIncidentMetaEquality($Variables,[string]$McpToken,[string]$InspectorToken){
 $key=$null;$iv=$null;$tag=$null;$cipher=$null;$plain=$null;$aad=$null;$aes=$null;$envelope=$null;$material=$null
 try{
  $ref=$Variables.DAILY_SYNC_META_CREDENTIAL_REF;$conn=$Variables.PHASE08_META_CONNECTION_ID
  if($ref -cnotmatch '^vault://meta/[a-f0-9-]{36}$' -or $conn -cnotmatch '^[a-f0-9-]{36}$' -or $Variables.DAILY_SYNC_META_TRANSPORT -cne 'MCP'){throw 'META_BINDING'}
  $envelope=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Variables.PHASE08_META_RECORD_B64))|ConvertFrom-Json -AsHashtable -Depth 8
  if($envelope.version -ne 1){throw 'META_VERSION'};$key=[Convert]::FromBase64String($Variables.DAILY_SYNC_META_VAULT_KEY);$iv=[Convert]::FromBase64String($envelope.iv);$tag=[Convert]::FromBase64String($envelope.authTag);$cipher=[Convert]::FromBase64String($envelope.ciphertext)
  if($key.Length -ne 32 -or $iv.Length -ne 12 -or $tag.Length -ne 16 -or $cipher.Length -lt 1 -or $cipher.Length -gt 32768){throw 'META_ENVELOPE'}
  $aad=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @('META_VAULT',1,'4474691502806219',$ref,$conn,'2138525300002203','MCP') -Compress));$plain=[byte[]]::new($cipher.Length);$aes=[Security.Cryptography.AesGcm]::new($key,16);$aes.Decrypt($iv,$cipher,$tag,$plain,$aad)
  $material=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json -AsHashtable -Depth 8
  $bound=$material.credentialRef -ceq $ref -and $material.connectionId -ceq $conn -and $material.accountId -ceq '2138525300002203' -and $material.transport -ceq 'MCP'
  if(-not $bound){throw 'META_MATERIAL_BINDING'}
  return @{offlineAuthenticatedDecryption=$true;exactBindingMatches=$true;mcpTokenEqualsExistingProtectedSource=($material.token -ceq $McpToken);inspectorTokenEqualsExistingProtectedSource=($material.inspectorToken -ceq $InspectorToken);sourceArtifactsAlsoAffected=$true;providerIntrospectionPerformed=$false;externalTokenRevocationVerified=$false}
 }finally{if($aes){$aes.Dispose()};foreach($bytes in @($key,$iv,$tag,$cipher,$plain,$aad)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};$envelope=$null;$material=$null}
}
if($MyInvocation.InvocationName -ceq '.'){return}
$stage='INITIALIZE';$secrets=[Collections.Generic.List[string]]::new();$out=[ordered]@{};$baseline=$null;$app=$null;$callback=$null;$source=$null;$adc=$null;$capsule=$null;$mcp=$null;$inspector=$null;$keys=$null
try{
 $stage='PROTECTED_BASELINE';$baseline=Read-IncidentPrivate 'compromised-baseline'
 if($baseline.version -ne 1 -or $baseline.scope.p -cne $script:IncidentScope.p -or $baseline.scope.e -cne $script:IncidentScope.e -or $baseline.scope.s -cne $script:IncidentScope.s -or $baseline.variables.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $baseline.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads'){throw 'BASELINE_BINDING'}
 foreach($name in @('AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','INTERNAL_PROBE_TOKEN','DAILY_SYNC_MACHINE_TOKEN','DATABASE_URL','DAILY_SYNC_CREDENTIAL_KEY_V1','DAILY_SYNC_CHECKPOINT_KEY_B64','SUPABASE_SECRET_KEY','SUPABASE_STORAGE_ACCESS_TOKEN','PHASE08_GOOGLE_ADC_JSON_B64','PHASE08_META_RECORD_B64','DAILY_SYNC_META_VAULT_KEY','DAILY_SYNC_CAFE24_CLIENT_SECRET')){if($baseline.variables.ContainsKey($name)){[void]$secrets.Add([string]$baseline.variables[$name])}}
 $stage='APP_MANAGEMENT_READ';$app=Get-IncidentState
 $out.scope=@{project='ehnfrrmbkvlsbpvqcvkr';appServiceId=$script:IncidentScope.s;appDeploymentId=$app.serviceInstance.latestDeployment.id;operatingServiceVariablesRead=$false;crossPlatformAtomicSnapshot=$false}
 $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}} project(id:$p){id services{edges{node{id}}}}}'
 $stage='CALLBACK_MANAGEMENT_READ';$callback=Invoke-Phase08SchedulerGraph $query @{p=$script:IncidentScope.p;e=$script:IncidentScope.e;s='deaaeaf9-ee5c-42fa-b32f-600c7a90befc'}
 if($callback.project.id -cne $script:IncidentScope.p -or $callback.serviceInstance.serviceId -cne 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc' -or $callback.serviceInstance.environmentId -cne $script:IncidentScope.e -or $callback.variables.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN -cne 'https://cafe24-callback-test-production.up.railway.app'){throw 'CALLBACK_BINDING'}
 foreach($name in @('DAILY_SYNC_CAFE24_CLIENT_SECRET','DATABASE_URL')){if($callback.variables.ContainsKey($name)){[void]$secrets.Add([string]$callback.variables[$name])}}
 $out.cafe=@{existingCallbackSameClientId=($callback.variables.DAILY_SYNC_CAFE24_CLIENT_ID -ceq $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_ID);existingCallbackSecretEqualsExposed=($callback.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET -ceq $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET);currentAppSecretPresent=$app.variables.ContainsKey('DAILY_SYNC_CAFE24_CLIENT_SECRET');currentAppSecretEqualsExposed=($app.variables.ContainsKey('DAILY_SYNC_CAFE24_CLIENT_SECRET') -and $app.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET -ceq $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET);callbackFeatureEnabled=($callback.variables.DAILY_SYNC_FEATURE_ENABLED -ceq 'true');externalSharedApplicationSecret=$true;providerReadOrWriteRequests=0}
 $stage='LOCAL_STAGING_REFERENCE';$path=Join-Path $env:APPDATA 'MetaAdsSecurity/staging-app-runtime/railway-runtime.dpapi';$cipherText=Read-IndependentIncidentFile $path 1048576 -Private;$cipherBytes=[Convert]::FromBase64String($cipherText);$plainBytes=$null
 try{$plainBytes=[Security.Cryptography.ProtectedData]::Unprotect($cipherBytes,[Text.Encoding]::UTF8.GetBytes('meta-ads-security-r2a-staging-role-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$source=[Text.Encoding]::UTF8.GetString($plainBytes)|ConvertFrom-Json -AsHashtable -Depth 30}finally{[Array]::Clear($cipherBytes,0,$cipherBytes.Length);if($plainBytes){[Array]::Clear($plainBytes,0,$plainBytes.Length)};$cipherText=$null}
 if($source.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $source.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co'){throw 'STAGING_REFERENCE_PROJECT'}
 [void]$secrets.Add([string]$source.SUPABASE_SECRET_KEY)
 $out.supabase=@{exposedKeyClass=(Get-IndependentIncidentKeyClass $baseline.variables.SUPABASE_SECRET_KEY);currentAppKeyPresent=$app.variables.ContainsKey('SUPABASE_SECRET_KEY');currentAppKeyEqualsExposed=($app.variables.ContainsKey('SUPABASE_SECRET_KEY') -and $app.variables.SUPABASE_SECRET_KEY -ceq $baseline.variables.SUPABASE_SECRET_KEY);localStagingRuntimeSameProject=$true;localStagingRuntimeKeyEqualsExposed=($source.SUPABASE_SECRET_KEY -ceq $baseline.variables.SUPABASE_SECRET_KEY);callbackCarriesSameSupabaseKey=($callback.variables.ContainsKey('SUPABASE_SECRET_KEY') -and $callback.variables.SUPABASE_SECRET_KEY -ceq $baseline.variables.SUPABASE_SECRET_KEY);consumerCoverage='FIXED_ISOLATED_APP_CALLBACK_AND_LOCAL_STAGING_REFERENCE_NOT_EXHAUSTIVE';otherConsumerChanges=0}
 $source=$null
 $stage='SUPABASE_APIKEY_CLASSIFICATION';$keys=@(Invoke-IndependentIncidentMetadata keys);$matches=@()
 foreach($key in $keys){if($key.ContainsKey('api_key') -and $key.api_key -is [string]){[void]$secrets.Add($key.api_key);if($key.api_key -ceq $baseline.variables.SUPABASE_SECRET_KEY){$type=if($key.ContainsKey('type') -and $key.type -cin @('legacy','secret','publishable')){$key.type}else{'UNKNOWN'};$matches+=@{managementType=$type;keyNameClass=$(if($key.name -cin @('service_role','anon','publishable','secret')){$key.name}else{'OTHER_CUSTOM_NAME'});keyMetadataIdHash=$(if($key.ContainsKey('id')){Get-IndependentIncidentStringHash ([string]$key.id)}else{$null})}}}}
 $out.supabase.managementKeyExactMatchCount=$matches.Count;$out.supabase.managementKeyMatches=$matches;$keys=$null
 $stage='GOOGLE_LOCAL_EQUALITY';$adcPath=Join-Path $env:APPDATA 'gcloud/application_default_credentials.json';$adc=(Read-IndependentIncidentFile $adcPath 65536)|ConvertFrom-Json -AsHashtable -Depth 20;$capsule=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($baseline.variables.PHASE08_GOOGLE_ADC_JSON_B64))|ConvertFrom-Json -AsHashtable -Depth 20
 foreach($data in @($adc,$capsule)){if($data.type -cne 'impersonated_service_account' -or $data.source_credentials.type -cne 'authorized_user'){throw 'ADC_TYPE'};foreach($key in @('client_secret','refresh_token')){[void]$secrets.Add([string]$data.source_credentials[$key])}}
 $expectedUrl='https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/daily-data-automation-ads-read@meta-ads-daily-automation.iam.gserviceaccount.com:generateAccessToken'
 $out.google=@{capsuleEqualsOriginalClientId=($capsule.source_credentials.client_id -ceq $adc.source_credentials.client_id);capsuleEqualsOriginalClientSecret=($capsule.source_credentials.client_secret -ceq $adc.source_credentials.client_secret);capsuleEqualsOriginalRefreshToken=($capsule.source_credentials.refresh_token -ceq $adc.source_credentials.refresh_token);originalAndCapsuleUseExpectedTargetPrincipal=($adc.service_account_impersonation_url -ceq $expectedUrl -and $capsule.service_account_impersonation_url -ceq $expectedUrl);sourceCredentialType='authorized_user';impersonatedCredentialType='impersonated_service_account';sourceClientIdSha256=(Get-IndependentIncidentStringHash $adc.source_credentials.client_id);sourceUserIdentityPresentInAdc=($adc.source_credentials.ContainsKey('account') -or $adc.source_credentials.ContainsKey('email'));sourceUserIdentityExternallyVerified=$false;sourceUserCredentialGrantPotentiallyBroaderThanTarget=$true;defaultGcloudCredentialDatabaseExists=(Test-Path -LiteralPath (Join-Path $env:APPDATA 'gcloud/credentials.db'));providerRequests=0}
 $adc=$null;$capsule=$null
 $stage='META_OFFLINE_EQUALITY';$mcp=Read-IndependentIncidentMetaToken 'mcp-access-token.dpapi';$inspector=Read-IndependentIncidentMetaToken 'inspector-token.dpapi';[void]$secrets.Add($mcp);[void]$secrets.Add($inspector);$out.meta=Get-IndependentIncidentMetaEquality $baseline.variables $mcp $inspector;$mcp=$null;$inspector=$null
 $stage='EDGE_SECRET_LINK_METADATA';$edge=@(Invoke-IndependentIncidentMetadata edge-secrets);$machine=@($edge|Where-Object {$_.name -ceq 'PHASE08_RELAY_MACHINE_TOKEN'});$digest=$null;if($machine.Count -eq 1){foreach($field in @('value','digest')){if($machine[0].ContainsKey($field) -and $machine[0][$field] -is [string] -and $machine[0][$field] -cmatch '^[a-fA-F0-9]{64}$'){$digest=$machine[0][$field].ToLowerInvariant();break}}};$digestAvailable=$null -ne $digest;$out.edge=@{machineSecretNamePresent=($machine.Count -eq 1);digestAvailable=$digestAvailable;machineDigestEqualsExposed=$(if($digestAvailable){$digest -ceq (Get-IndependentIncidentStringHash $baseline.variables.DAILY_SYNC_MACHINE_TOKEN)}else{$null});basicPasswordDistinctNamePresent=(@($edge|Where-Object {$_.name -ceq 'PHASE08_RELAY_BASIC_PASSWORD'}).Count -eq 1);secretValuesReturnedByMetadataRequest=$false};$edge=$null;$machine=$null;$digest=$null
 $stage='READONLY_GRANTS_AND_SCHEDULER'
 $sql=@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout=15000;
SELECT current_database() AS database,current_user AS principal,
(SELECT coalesce(jsonb_agg(jsonb_build_object('role',rolname,'login',rolcanlogin,'super',rolsuper,'bypassRls',rolbypassrls,'createDb',rolcreatedb,'createRole',rolcreaterole,'replication',rolreplication,'configHash',md5(coalesce(rolconfig::text,''))) ORDER BY rolname),'[]') FROM pg_roles WHERE rolname IN ('phase08_runtime','phase08_storage_app')) AS roles,
(SELECT coalesce(jsonb_agg(jsonb_build_object('member',m.rolname,'grantedRoleHash',md5(r.rolname),'adminOption',a.admin_option)),'[]') FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE m.rolname IN ('phase08_runtime','phase08_storage_app')) AS memberships,
(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',table_schema,'privilege',privilege_type,'tables',n) ORDER BY table_schema,privilege_type),'[]') FROM (SELECT table_schema,privilege_type,count(*)::int n FROM information_schema.role_table_grants WHERE grantee='phase08_runtime' AND table_schema IN ('phase08_meta_ads','auth','storage','public') GROUP BY table_schema,privilege_type) x) AS runtime_table_grants,
has_schema_privilege('phase08_runtime','phase08_meta_ads','USAGE') AS runtime_schema_usage,
has_schema_privilege('phase08_runtime','auth','USAGE') AS runtime_auth_schema_usage,
(SELECT count(*)::int FROM pg_tables WHERE schemaname='phase08_meta_ads') AS business_tables,
(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS force_rls,
(SELECT jsonb_build_object('stopped',stopped,'targetMatches',target_id='phase08-full-app','originMatches',origin='https://phase08-daily-data-sync-production.up.railway.app') FROM daily_data_sync_ops.settings WHERE singleton) AS scheduler,
(SELECT count(*)::int FROM daily_data_sync_ops.schedules WHERE paused) AS paused_schedules,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%') AS jobs,
(SELECT count(*)::int FROM cron.job WHERE jobname LIKE 'daily-data-sync-08-%' AND active) AS active_jobs,
md5(pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure)) AS scheduler_call_hash,
position('daily_data_sync_08_relay_userpwd' IN pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure))>0 AS scheduler_references_relay_basic_vault,
position('phase08-scheduled-relay' IN pg_get_functiondef('daily_data_sync_ops.call(text,boolean)'::regprocedure))>0 AS scheduler_references_fixed_relay,
(SELECT count(*)::int FROM phase08_meta_ads.sync_leases WHERE expires_at>clock_timestamp()) AS leases;
ROLLBACK;
'@
 $db=@(Invoke-Phase08Management -Action Query -Query $sql);if($db.Count -ne 1 -or $db[0].database -cne 'postgres' -or $db[0].principal -cne 'postgres' -or $db[0].business_tables -ne 68 -or $db[0].force_rls -ne 68){throw 'DB_IDENTITY'};$out.database=$db[0]
 $stage='SAFE_OUTPUT';$receipt=[ordered]@{kind='INCIDENT_INDEPENDENT_SHARED_SCOPE_ACTUAL_INVENTORY';observedAt=[DateTimeOffset]::UtcNow.ToString('o');status='OBSERVED_SHARED_SCOPE_EXTERNAL_RETIREMENT_UNRESOLVED';results=$out;publicValuesAreMetadataOrEqualityOnly=$true;rawSecretValuesReturned=0;plaintextFilesWritten=0;providerRequests=0;operatingSecretValuesRead=0;remoteMutations=0;protectedSourcesModified=0}
 $text=$receipt|ConvertTo-Json -Depth 35;Assert-IndependentIncidentOutput $text $secrets
 $destination='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/independent';[void][IO.Directory]::CreateDirectory($destination);[void](Read-IndependentIncidentFile $PSCommandPath 65536)
 $parent=$destination;while($parent){$item=Get-Item -LiteralPath $parent;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'OUTPUT_REPARSE'};$parent=[IO.Path]::GetDirectoryName($parent)}
 $path=Join-Path $destination ($Label+'.json');$bytes=[Text.UTF8Encoding]::new($false).GetBytes($text);$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 @{kind=$receipt.kind;status=$receipt.status;evidence=$path;rawSecretValuesReturned=0;providerRequests=0;remoteMutations=0}|ConvertTo-Json -Compress
}catch{@{kind='INCIDENT_INDEPENDENT_SHARED_SCOPE_SAFE_REJECTION';stage=$stage;rawErrorSuppressed=$true;rawSecretValuesReturned=0;providerRequests=0;remoteMutations=0}|ConvertTo-Json -Compress;exit 1}
finally{$baseline=$null;$app=$null;$callback=$null;$source=$null;$adc=$null;$capsule=$null;$mcp=$null;$inspector=$null;$keys=$null;$db=$null;$text=$null;$receipt=$null;$secrets.Clear()}
