Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/incident-storage-rotation.ps1"
$script:Observed=$null;$script:MockStatus=200;$script:MockThrow=$false
function Invoke-WebRequest {
 param($Uri,$Method,$Headers,$MaximumRedirection,$TimeoutSec,$SkipHttpErrorCheck,$Body,$ContentType)
 if($script:MockThrow){throw 'SYNTHETIC_SECRET_MUST_NOT_APPEAR'}
 $script:Observed=@{uri=$Uri;method=$Method;body=$Body;contentType=$ContentType;redirects=$MaximumRedirection}
 return @{StatusCode=$script:MockStatus;RawContentStream=[IO.MemoryStream]::new([Text.Encoding]::ASCII.GetBytes('synthetic-body'))}
}
$context=@{projectRef='ehnfrrmbkvlsbpvqcvkr';env=@{SUPABASE_URL='https://ehnfrrmbkvlsbpvqcvkr.supabase.co';SUPABASE_STORAGE_BUCKET='meta-ads-phase08-isolated';SUPABASE_PUBLISHABLE_KEY='synthetic-key'}}
$script:SnapshotPrincipal='postgres';$script:ObservedManagement=$null
function Invoke-Phase08Management {param($Action,$Query);$script:ObservedManagement=@{action=$Action;query=$Query};return [pscustomobject]@{database='postgres';principal=$script:SnapshotPrincipal;object_count=1;objects_md5='same';buckets_md5='same';grants_md5='same';unrelated_policy_md5='same';object_field_md5=[pscustomobject]@{id='same'}}}
$passed=0
try{
 $r=Invoke-IncidentStorageRequest $context 'synthetic-token' Delete 'uploads/incident-storage-own' $null
 if($script:Observed.uri -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/storage/v1/object/meta-ads-phase08-isolated' -or ($script:Observed.body|ConvertFrom-Json).prefixes[0] -cne 'uploads/incident-storage-own' -or $script:Observed.redirects -ne 0){throw 'DELETE_SHAPE'};$passed++
 $r=Invoke-IncidentStorageRequest $context 'synthetic-token' Get 'uploads/a b' $null
 if(-not $script:Observed.uri.EndsWith('/object/authenticated/meta-ads-phase08-isolated/uploads/a%20b') -or $r.bytes -ne 14 -or $r.sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'GET_SHAPE'};$passed++
 $script:Observed=$null;$rejected=$false;try{$null=Invoke-IncidentStorageRequest $context 'synthetic' Get '../outside' $null}catch{$rejected=$true};if(-not $rejected -or $null -ne $script:Observed){throw 'PATH_SCOPE'};$passed++
 $other=@{projectRef='iygjmosbelbosfxidqxv';env=$context.env};$rejected=$false;try{$null=Invoke-IncidentStorageRequest $other 'synthetic' Get 'uploads/a' $null}catch{$rejected=$true};if(-not $rejected -or $null -ne $script:Observed){throw 'PROJECT_SCOPE'};$passed++
 $script:MockThrow=$true;$caught=$null;try{$null=Invoke-IncidentStorageRequest $context 'synthetic' Get 'uploads/a' $null}catch{$caught=$_.Exception.Message};if($caught -cne 'STORAGE_HTTP_FAILED'){throw 'RAW_ERROR_LEAK'};$passed++
 $snapshot=Get-IncidentStorageSnapshot;if($script:ObservedManagement.action -cne 'Query' -or -not $script:ObservedManagement.query.StartsWith('BEGIN READ ONLY;') -or $snapshot -isnot [Collections.IDictionary]){throw 'SNAPSHOT_READONLY_PRINCIPAL_ROUTE'};Assert-IncidentStoragePreserved $snapshot $snapshot;$passed++
 $script:SnapshotPrincipal='synthetic_readonly_role';$caught=$null;try{$null=Get-IncidentStorageSnapshot}catch{$caught=$_.Exception.Message};if($caught -cne 'SNAPSHOT_PRINCIPAL_IDENTITY'){throw 'SNAPSHOT_PRINCIPAL_SAFE_CODE'};$passed++
 $before=@{objects_md5='a';object_field_md5=@{name='same';last_accessed_at='before'}};$after=@{objects_md5='b';object_field_md5=@{name='same';last_accessed_at='after'}};$caught=$null;try{Assert-IncidentStoragePreserved $before $after}catch{$caught=$_.Exception.Message};if($caught -cne 'PRESERVATION_OBJECTS_MD5' -or @($script:IncidentStorageChangedFields).Count -ne 1 -or $script:IncidentStorageChangedFields[0] -cne 'last_accessed_at'){throw 'COLUMN_ONLY_DIAGNOSTIC'};$passed++
 $script:MockThrow=$false;$script:MockStatus=200;$r=Invoke-IncidentStorageRequest $context 'synthetic' Get 'health/readiness-sentinel' $null -RouteKind Info -NoCache;if($r.bytes -ne 0 -or $script:Observed.uri -notmatch '/object/info/authenticated/meta-ads-phase08-isolated/health/readiness-sentinel\?incident=[a-f0-9]{32}$'){throw 'INFO_METADATA_ONLY'};$passed++
 $script:Observed=$null;$caught=$false;try{$null=Invoke-IncidentStorageRequest $context 'synthetic' Get 'uploads/customer-original' $null -RouteKind Info -NoCache}catch{$caught=$true};if(-not $caught -or $null -ne $script:Observed){throw 'INFO_SENTINEL_SCOPE'};$passed++
 function Invoke-Phase08Management {param($Action,$Query);$script:ObservedManagement=@{action=$Action;query=$Query};return [pscustomobject]@{identity_bound=$true;own_rows=1;original_rows=1;original_md5='baseline'}}
 $fixture=@{fixtureKey=('uploads/incident-storage-'+('a'*32));before=@{object_count=1;objects_md5='baseline'}};Assert-IncidentStorageOwnFixtureStillPresent $fixture;if($script:ObservedManagement.action -cne 'Query' -or -not $script:ObservedManagement.query.StartsWith('BEGIN READ ONLY;')){throw 'DELETE_EFFECT_RO_QUERY'};$passed++
 function Invoke-Phase08Management {param($Action,$Query);return [pscustomobject]@{identity_bound=$true;own_rows=0;original_rows=1;original_md5='baseline'}}
 $caught=$null;try{Assert-IncidentStorageOwnFixtureStillPresent $fixture}catch{$caught=$_.Exception.Message};if($caught -cne 'OLD_DELETE_EFFECT_NOT_DENIED'){throw 'DELETED_FIXTURE_MUST_FAIL'};$passed++
 @{kind='INCIDENT_STORAGE_LOCAL_PS_TEST';passed=$passed;remoteRequests=0;secretMaterialRead=0;rawErrorSuppressed=$true}|ConvertTo-Json
}catch{@{kind='INCIDENT_STORAGE_LOCAL_PS_TEST';passed=$passed;status='FAIL';rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
