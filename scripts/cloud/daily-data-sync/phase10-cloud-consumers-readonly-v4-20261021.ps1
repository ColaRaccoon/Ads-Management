Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
. "$PSScriptRoot/phase10-cafe-oneoff-controller-v6-20261021.ps1"
$root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/consumer-readonly-1343'
$dest=$root+'/cloud-consumers-v4.json'
$stage='INITIALIZE';$baseline=$null;$adc=$null;$mcp=$null;$inspector=$null;$raw=$null;$state=$null;$token=$null;$headers=$null
$secrets=[Collections.Generic.List[string]]::new();$needles=@{};$results=[Collections.Generic.List[object]]::new();$gaps=[Collections.Generic.List[object]]::new();$graphReads=0;$managementReads=0
function Add-Needle([string]$Class,[string]$Value){if($Value.Length -lt 8){throw 'NEEDLE_BOUND'};if(-not $needles.ContainsKey($Class)){$needles[$Class]=[Collections.Generic.List[string]]::new()};if(-not $needles[$Class].Contains($Value)){$needles[$Class].Add($Value);$secrets.Add($Value)}}
function Test-ConsumerValue([string]$Value){
 $texts=[Collections.Generic.List[string]]::new();$texts.Add($Value);$bytes=$null
 try{if($Value.Length -ge 24 -and $Value.Length -le 131072 -and $Value -cmatch '^[A-Za-z0-9+/]+={0,2}$'){$bytes=[Convert]::FromBase64String($Value);if($bytes.Length -le 98304){$decoded=[Text.UTF8Encoding]::new($false,$true).GetString($bytes);if($decoded.TrimStart().StartsWith('{') -or $decoded.TrimStart().StartsWith('[')){$texts.Add($decoded)}}}}catch{}finally{if($bytes){[Array]::Clear($bytes)}}
 $classes=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 foreach($class in $needles.Keys){foreach($v in $needles[$class]){foreach($text in $texts){if($text.Contains($v,[StringComparison]::Ordinal)){[void]$classes.Add($class)}}}}
 return @($classes|Sort-Object)
}
function Read-CloudMetadata([string]$Path){
 if($Path -cnotmatch '^/v1/(?:projects|projects/[a-z]{20}/(?:secrets|functions)|projects/ehnfrrmbkvlsbpvqcvkr/api-keys\?reveal=true)$'){throw 'MANAGEMENT_PATH'}
 $script:managementReads++;$r=$null
 try{$r=Invoke-WebRequest -Uri ('https://api.supabase.com'+$Path) -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 25 -SkipHttpErrorCheck
  if([int]$r.StatusCode -ne 200){return @{ok=$false;status=[int]$r.StatusCode}}
  if([Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 2097152){throw 'METADATA_BOUND'}
  return @{ok=$true;status=200;rows=@($r.Content|ConvertFrom-Json -AsHashtable -Depth 25 -DateKind String)}
 }finally{$r=$null}
}
function Get-CloudGraph([string]$Query,$Variables){if(-not $Query.StartsWith('query(') -or $Query.Contains('mutation')){throw 'READONLY_GRAPH_REQUIRED'};$script:graphReads++;return Invoke-Phase08SchedulerGraph $Query $Variables}
function Assert-CloudId([string]$Id){if($Id -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$'){throw 'RESOURCE_ID'}}
if($MyInvocation.InvocationName -ceq '.'){return}
try{
 if(Test-Path -LiteralPath $dest){throw 'CONSUMED'};[void][IO.Directory]::CreateDirectory($root)
 $stage='PROTECTED_NEEDLES';$baseline=Read-IncidentPrivate 'compromised-baseline'
 Add-Needle 'SUPABASE_SHARED_SECRET_KEY' $baseline.variables.SUPABASE_SECRET_KEY
 Add-Needle 'CAFE_SHARED_CLIENT_SECRET' $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_SECRET
 Add-Needle 'CAFE_CLIENT_ID_REFERENCE' $baseline.variables.DAILY_SYNC_CAFE24_CLIENT_ID
 $adc=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($baseline.variables.PHASE08_GOOGLE_ADC_JSON_B64))|ConvertFrom-Json -AsHashtable -Depth 20
 Add-Needle 'GOOGLE_OAUTH_REFRESH' $adc.source_credentials.refresh_token;Add-Needle 'GOOGLE_OAUTH_CLIENT_SECRET' $adc.source_credentials.client_secret;Add-Needle 'GOOGLE_ADC_CAPSULE' $baseline.variables.PHASE08_GOOGLE_ADC_JSON_B64
 $mcp=Read-IndependentIncidentMetaToken 'mcp-access-token.dpapi';$inspector=Read-IndependentIncidentMetaToken 'inspector-token.dpapi'
 Add-Needle 'META_MCP_TOKEN' $mcp;Add-Needle 'META_APP_INSPECTOR_TOKEN' $inspector;Add-Needle 'META_ENCRYPTED_RECORD' $baseline.variables.PHASE08_META_RECORD_B64;Add-Needle 'META_VAULT_WRAPPING_KEY' $baseline.variables.DAILY_SYNC_META_VAULT_KEY
 $stage='INITIAL_HOLD';$prepared=Read-OneoffPrepared 'cafe08-oneoff-20261021-prepared-d-armed';$state=Get-IncidentState;$envHash=Get-IncidentVariableHash $state.variables;$before=Invoke-OneoffSql 'Inspect' $prepared.plan;Assert-OneoffSnapshot $before 2
 $stage='RAILWAY_INVENTORY';$raw=& 'C:/Users/seong/AppData/Local/npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe' list --json 2>$null;if($LASTEXITCODE -ne 0){throw 'RAILWAY_LIST'};$projects=@(($raw|Out-String)|ConvertFrom-Json -AsHashtable -Depth 25);$raw=$null
 if($projects.Count -gt 50){throw 'PROJECT_BOUND'};$tuples=0;$variablesRead=0;$unresolvedEncrypted=0
 foreach($p in $projects){Assert-CloudId $p.id;$envs=@($p.environments.edges);$services=@($p.services.edges)
  if($envs.Count -gt 30 -or $services.Count -gt 50){throw 'RESOURCE_BOUND'}
  foreach($en in $envs){$eid=[string]$en.node.id;Assert-CloudId $eid
   foreach($sv in $services){$sid=[string]$sv.node.id;Assert-CloudId $sid;$tuples++;if($tuples -gt 500){throw 'TUPLE_BOUND'}
    $query='query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id deploymentStopped}}}'
    try{$reply=Get-CloudGraph $query @{p=$p.id;e=$eid;s=$sid};if($null -ne $reply.serviceInstance -and ($reply.serviceInstance.serviceId -cne $sid -or $reply.serviceInstance.environmentId -cne $eid)){throw 'RESOURCE_RESPONSE_BINDING'};$v=$reply.variables;if($v -isnot [Collections.IDictionary]){throw 'VARIABLES_SHAPE'};$hash=Get-IncidentVariableHash $v;$consumerMatches=[Collections.Generic.List[object]]::new()
     foreach($key in $v.Keys){$value=[string]$v[$key];$variablesRead++;$classes=@(Test-ConsumerValue $value);if($key -cmatch 'SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL|ADC|META_RECORD'){if($value.Length -ge 8){$secrets.Add($value)}}
      if($classes.Count){$consumerMatches.Add(@{setting=$(if($key -cmatch '^[A-Z][A-Z0-9_]{0,120}$'){$key}else{'OTHER_SETTING'});settingNameSha256=(Get-IndependentIncidentStringHash $key);classes=$classes})}
     }
     $meta=$null;if($v.Contains('PHASE08_META_RECORD_B64')){try{$meta=Get-IndependentIncidentMetaEquality $v $mcp $inspector}catch{$unresolvedEncrypted++;$meta=@{typedEnvelopeUnresolved=$true}}}
     $again=Get-CloudGraph $query @{p=$p.id;e=$eid;s=$sid};$unchanged=$hash -ceq (Get-IncidentVariableHash $again.variables)
     $label=if($sid -ceq '4b30daa8-9333-46b7-ad89-cfd64ff5266c'){'ISOLATED08_APP'}elseif($sid -ceq 'deaaeaf9-ee5c-42fa-b32f-600c7a90befc'){'CAFE06_CALLBACK'}else{'OTHER_ACCESSIBLE_SERVICE'}
     $results.Add(@{platform='RAILWAY';projectId=$p.id;environmentId=$eid;serviceId=$sid;resourceClass=$label;projectNameSha256=(Get-IndependentIncidentStringHash ([string]$p.name));environmentNameSha256=(Get-IndependentIncidentStringHash ([string]$en.node.name));variables=$v.Count;matchedSettings=$consumerMatches.ToArray();metaEnvelope=$meta;variablesBeforeAfterExact=$unchanged;deployed=($null -ne $reply.serviceInstance -and $null -ne $reply.serviceInstance.latestDeployment);stopped=$(if($null -ne $reply.serviceInstance -and $null -ne $reply.serviceInstance.latestDeployment){$reply.serviceInstance.latestDeployment.deploymentStopped}else{$null})})
     if(-not $unchanged){$gaps.Add(@{platform='RAILWAY';resource=$sid;reason='CONCURRENT_CONFIGURATION_CHANGE'})};$v=$null;$reply=$null;$again=$null
    }catch{$gaps.Add(@{platform='RAILWAY';projectId=$p.id;environmentId=$eid;serviceId=$sid;reason='QUERY_OR_PROJECTION_FAILED';safeLine=$_.InvocationInfo.ScriptLineNumber;safeScript=[IO.Path]::GetFileName($_.InvocationInfo.ScriptName);safeClass=$(if($_.FullyQualifiedErrorId.Split(',')[0] -cin @('PropertyNotFoundStrict','MethodNotFound','ArgumentTypesDoNotMatch','CannotIndex','RESOURCE_RESPONSE_BINDING','VARIABLES_SHAPE','PHASE08_SCHEDULER_GRAPH_FAILED')){$_.FullyQualifiedErrorId.Split(',')[0]}else{'OTHER_SUPPRESSED'});rawErrorSuppressed=$true})}
   }
  }
 }
 $stage='SUPABASE_INVENTORY';$token=Get-Phase08SupabaseCredential;$secrets.Add($token);$headers=@{Authorization=('Bearer '+$token)};$sp=Read-CloudMetadata '/v1/projects';if(-not $sp.ok){throw 'SUPABASE_PROJECTS'};if($sp.rows.Count -gt 50){throw 'SUPABASE_PROJECT_BOUND'}
 $keyMatches=0;$edgeSecrets=0;$functions=0;$edgeMatches=[Collections.Generic.List[object]]::new();$projectMeta=[Collections.Generic.List[object]]::new()
 foreach($p in $sp.rows){$ref=[string]$p.id;if($ref -cnotmatch '^[a-z]{20}$'){throw 'PROJECT_REF'}
  foreach($kind in @('secrets','functions')){$r=Read-CloudMetadata ('/v1/projects/'+$ref+'/'+$kind);if(-not $r.ok){$gaps.Add(@{platform='SUPABASE';projectRef=$ref;metadata=$kind;status=$r.status;reason='METADATA_DENIED'});continue}
   if($kind -ceq 'functions'){$functions+=$r.rows.Count;$projectMeta.Add(@{projectRef=$ref;functions=$r.rows.Count})}
   else{$edgeSecrets+=$r.rows.Count;foreach($row in $r.rows){$digest=$null;foreach($field in @('value','digest')){if($row.ContainsKey($field) -and $row[$field] -is [string]){if($row[$field].Length -ge 8){$secrets.Add($row[$field])};if($row[$field] -cmatch '^[a-fA-F0-9]{64}$'){$digest=$row[$field].ToLowerInvariant();break}}};if($null -eq $digest){$gaps.Add(@{platform='SUPABASE';projectRef=$ref;reason='EDGE_SECRET_DIGEST_UNAVAILABLE'});continue};$classes=[Collections.Generic.HashSet[string]]::new();foreach($class in $needles.Keys){foreach($needle in $needles[$class]){if($digest -ceq (Get-IndependentIncidentStringHash $needle)){[void]$classes.Add($class)}}};if($classes.Count){$edgeMatches.Add(@{projectRef=$ref;settingNameSha256=(Get-IndependentIncidentStringHash ([string]$row.name));classes=@($classes|Sort-Object)})}}}
  }
 }
 $keys=Read-CloudMetadata '/v1/projects/ehnfrrmbkvlsbpvqcvkr/api-keys?reveal=true';if($keys.ok){foreach($key in $keys.rows){if($key.Contains('api_key')){$secrets.Add([string]$key.api_key);if($key.api_key -ceq $baseline.variables.SUPABASE_SECRET_KEY){$keyMatches++}}}}else{$gaps.Add(@{platform='SUPABASE';metadata='TARGET_KEY';status=$keys.status;reason='KEY_METADATA_DENIED'})}
 $stage='FINAL_HOLD';$finalState=Get-IncidentState;$after=Invoke-OneoffSql 'Inspect' $prepared.plan;Assert-OneoffSnapshot $after 2
 $preserved=($envHash -ceq (Get-IncidentVariableHash $finalState.variables)) -and (Get-IncidentHash $before) -ceq (Get-IncidentHash $after)
 if(-not $preserved){throw 'READONLY_PRESERVATION'}
 $proof=@{kind='EXISTING_AUTHORITY_CLOUD_CONSUMER_READONLY_INVENTORY';status=$(if($gaps.Count -eq 0){'PASS_REACHABLE_SCOPE_COMPLETE'}else{'PARTIAL_REACHABLE_SCOPE_WITH_GAPS'});at=[DateTimeOffset]::UtcNow.ToString('o');railwayProjects=$projects.Count;railwayEnvironmentServicePairs=$tuples;railwayValuesCompared=$variablesRead;railway=$results.ToArray();unresolvedTypedEncryptedConfigurations=$unresolvedEncrypted;supabaseProjects=$sp.rows.Count;edgeSecretMetadataCompared=$edgeSecrets;edgeSecretExactFingerprintMatches=$edgeMatches.ToArray();functionMetadataCount=$functions;supabaseFunctionMetadata=$projectMeta.ToArray();targetExposedSupabaseKeyExactMetadataMatches=$keyMatches;gaps=$gaps.ToArray();known70TableSnapshotAndHeldEnvironmentExact=$preserved;graphQueryRequests=$graphReads;managementGetRequests=$managementReads;mutations=0;providerRefreshRequests=0;credentialChanges=0;apiKeyDisposal=0;rawSecretValuesReturned=0;operatingSettingsChanges=0;stages11And12Started=$false;coverage='All projects returned by existing Railway list and Supabase project list; current service environment values and custom Edge-secret digests. Not every external installation or unconnected account.';encryptedAndDynamicReferenceCoverage='Only exact literals, bounded base64 JSON and the known authenticated Meta envelope; unknown encrypted or dynamically fetched references cannot be excluded'}
 $json=$proof|ConvertTo-Json -Depth 35;Assert-IndependentIncidentOutput $json $secrets;$stream=[IO.File]::Open($dest,[IO.FileMode]::CreateNew);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($json);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 @{status=$proof.status;evidence=$dest;railwayProjects=$projects.Count;serviceEnvironmentPairs=$tuples;supabaseProjects=$sp.rows.Count;edgeSecrets=$edgeSecrets;gaps=$gaps.Count;mutations=0;rawValuesReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='CLOUD_CONSUMERS_SAFE_FAILURE';status='FAIL';stage=$stage;line=$_.InvocationInfo.ScriptLineNumber;scriptLeaf=[IO.Path]::GetFileName($_.InvocationInfo.ScriptName);rawErrorSuppressed=$true;mutations=0}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$baseline=$null;$adc=$null;$mcp=$null;$inspector=$null;$raw=$null;$state=$null;$finalState=$null;$prepared=$null;$v=$null;$token=$null;$headers=$null;$sp=$null;$keys=$null;$needles.Clear();$secrets.Clear()}
