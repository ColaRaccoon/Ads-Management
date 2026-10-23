param(
 [ValidateSet('Prepare','Execute','Inspect','Cleanup')][string]$Mode='Inspect',
 [string]$ProtectedPath,[string]$EvidencePath,[string]$ExpectedDeploymentId,[string]$ExpectedSourceSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"

function Assert-Phase10RoleFixture($Fixture) {
 if($Fixture.version -ne 1 -or $Fixture.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $Fixture.schema -cne 'phase08_meta_ads' -or $Fixture.fixtureId -cnotmatch '^[a-f0-9-]{36}$' -or @($Fixture.accounts).Count -ne 2){throw 'role-fixture-identity'}
 $allIds=@();foreach($account in $Fixture.accounts){
  if($account.role -cnotin @('USER','ADMIN') -or $account.authId -cnotmatch '^[a-f0-9-]{36}$' -or $account.appId -cnotmatch '^[a-f0-9-]{36}$' -or $account.email -cne ('phase10-role-'+$account.authId+'@example.invalid') -or $account.password -cnotmatch '^[A-Za-z0-9+/]{43}=$'){throw 'role-account-identity'}
  $allIds+=@($account.authId,$account.appId)
 }
 if(@($allIds|Select-Object -Unique).Count -ne 4 -or @($Fixture.accounts|Select-Object -ExpandProperty role -Unique).Count -ne 2){throw 'role-uniqueness'}
}
function Assert-Phase10RoleProtectedPath([string]$Path) {
 $resolved=[IO.Path]::GetFullPath($Path)
 if([IO.Path]::GetDirectoryName($resolved) -cne 'C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime' -or [IO.Path]::GetFileName($resolved) -cnotmatch '^phase10-role-[a-f0-9]{32}\.dpapi$'){throw 'role-protected-path'}
 Assert-Phase08PrivatePath -Path ([IO.Path]::GetDirectoryName($resolved)) -Directory
 return $resolved
}
function Read-Phase10RoleFixture([string]$Path) {
 $Path=Assert-Phase10RoleProtectedPath $Path;Assert-Phase08PrivatePath -Path $Path
 $all=$null;$plain=$null;$cipher=$null
 try {
  $all=[IO.File]::ReadAllBytes($Path);$magic=[Text.Encoding]::ASCII.GetBytes('PHASE10-ROLES-1')
  if($all.Length -lt 32 -or $all.Length -gt 16384){throw 'role-protected-size'}
  for($index=0;$index -lt $magic.Length;$index++){if($all[$index] -ne $magic[$index]){throw 'role-protected-magic'}}
  $cipher=$all[$magic.Length..($all.Length-1)];$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase10/Roles/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $fixture=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json;Assert-Phase10RoleFixture $fixture;return $fixture
 }finally{foreach($bytes in @($all,$plain,$cipher)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}}
}
function Write-Phase10RoleEvidence($Value,[string]$Path) {
 $destination=[IO.Path]::GetFullPath($Path);if((Test-Path -LiteralPath $destination) -or -not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'role-evidence-path'}
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12));$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
}
function Get-Phase10RoleStateSql($Fixture) {
 Assert-Phase10RoleFixture $Fixture;$a=$Fixture.accounts[0];$b=$Fixture.accounts[1]
 return @"
BEGIN READ ONLY; SET LOCAL statement_timeout=10000;
SELECT current_database() AS database,current_user AS principal,
 (SELECT count(*)::int FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads') AS table_count,
 (SELECT md5(coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.id)::text,'[]')) FROM phase08_meta_ads.app_users u WHERE u.id NOT IN ('$($a.appId)'::uuid,'$($b.appId)'::uuid)) AS existing_app_users_hash,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'authId',u.auth_user_id,'role',u.role,'isActive',u.is_active,'version',u.authz_version,'matched',u.email IN ('$($a.email)','$($b.email)')) ORDER BY u.id),'[]') FROM phase08_meta_ads.app_users u WHERE u.id IN ('$($a.appId)'::uuid,'$($b.appId)'::uuid)) AS app_users,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'authRole',u.role,'confirmed',u.email_confirmed_at IS NOT NULL,'preparedRole',u.raw_app_meta_data->>'phase10_role','fixtureMatched',u.raw_app_meta_data->>'phase10_role_evaluation_id'='$($Fixture.fixtureId)') ORDER BY u.id),'[]') FROM auth.users u WHERE u.id IN ('$($a.authId)'::uuid,'$($b.authId)'::uuid)) AS auth_users;
ROLLBACK;
"@
}
function Assert-Phase10RoleState($State) {
 if($State.database -cne 'postgres' -or $State.principal -cne 'postgres' -or $State.table_count -ne 68 -or $State.existing_app_users_hash -cnotmatch '^[a-f0-9]{32}$'){throw 'role-database-identity'}
}
function Get-Phase10RoleCreateSql($Fixture) {
 Assert-Phase10RoleFixture $Fixture;$statements=@()
 foreach($account in $Fixture.accounts){$statements+=@"
IF EXISTS(SELECT 1 FROM phase08_meta_ads.app_users WHERE id='$($account.appId)'::uuid OR auth_user_id='$($account.authId)'::uuid OR normalized_email='$($account.email)') OR
 NOT EXISTS(SELECT 1 FROM auth.users WHERE id='$($account.authId)'::uuid AND email='$($account.email)' AND email_confirmed_at IS NOT NULL AND role='authenticated' AND raw_app_meta_data->>'phase10_role_evaluation_id'='$($Fixture.fixtureId)' AND raw_app_meta_data->>'phase10_role'='$($account.role)') THEN RAISE EXCEPTION 'PHASE10_NEW_ROLE_REQUIRED'; END IF;
INSERT INTO phase08_meta_ads.app_users(id,email,normalized_email,name,role,invite_status,auth_user_id,is_active,authz_version,updated_at) VALUES('$($account.appId)'::uuid,'$($account.email)','$($account.email)','Phase10 isolated $($account.role)','$($account.role)','ACTIVE','$($account.authId)'::uuid,true,1,now());
INSERT INTO phase08_meta_ads.security_audit_events(id,actor_type,action,target_type,target_id,result,after_json) VALUES(gen_random_uuid(),'SYSTEM','PHASE10_EVALUATION_ROLE_CREATED','APP_USER','$($account.appId)','SUCCESS','{"role":"$($account.role)","isolatedEvaluation":true,"fixtureId":"$($Fixture.fixtureId)"}'::jsonb);
"@}
 return "BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='10s';DO `$`$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' OR (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68 THEN RAISE EXCEPTION 'PHASE10_ROLE_TARGET'; END IF;`n"+($statements -join "`n")+"`nEND `$`$;COMMIT;"
}
function Get-Phase10RoleCleanupSql($Fixture) {
 Assert-Phase10RoleFixture $Fixture;$statements=@()
 foreach($account in $Fixture.accounts){
  $finalVersion=if($account.role -ceq 'USER'){3}else{2}
  $roleCas=if($account.role -ceq 'USER'){"((role='USER' AND is_active=true AND authz_version=1) OR (role='GUEST' AND is_active=true AND authz_version=2) OR (role IN ('USER','GUEST') AND is_active=false AND authz_version=3))"}else{"role='ADMIN' AND ((is_active=true AND authz_version=1) OR (is_active=false AND authz_version=2))"}
  $activeCas=if($account.role -ceq 'USER'){"((role='USER' AND authz_version=1) OR (role='GUEST' AND authz_version=2))"}else{"role='ADMIN' AND authz_version=1"}
  $statements+=@"
IF EXISTS(SELECT 1 FROM phase08_meta_ads.app_users WHERE id='$($account.appId)'::uuid) THEN
 IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users WHERE id='$($account.appId)'::uuid AND auth_user_id='$($account.authId)'::uuid AND email='$($account.email)' AND invite_status='ACTIVE' AND $roleCas) THEN RAISE EXCEPTION 'PHASE10_ROLE_CAS'; END IF;
 UPDATE phase08_meta_ads.app_users SET is_active=false,authz_version=$finalVersion,updated_at=now() WHERE id='$($account.appId)'::uuid AND auth_user_id='$($account.authId)'::uuid AND email='$($account.email)' AND is_active=true AND $activeCas;
 IF FOUND THEN INSERT INTO phase08_meta_ads.security_audit_events(id,actor_type,action,target_type,target_id,result,after_json) VALUES(gen_random_uuid(),'SYSTEM','PHASE10_EVALUATION_ROLE_DISABLED','APP_USER','$($account.appId)','SUCCESS','{"isActive":false,"fixtureId":"$($Fixture.fixtureId)"}'::jsonb); END IF;
END IF;
"@}
 return "BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='10s';DO `$`$ BEGIN IF current_database()<>'postgres' OR current_user<>'postgres' THEN RAISE EXCEPTION 'PHASE10_ROLE_TARGET'; END IF;`n"+($statements -join "`n")+"`nEND `$`$;COMMIT;"
}
function Get-Phase10RoleDemoteSql($Fixture) {
 Assert-Phase10RoleFixture $Fixture;$account=@($Fixture.accounts|Where-Object role -CEQ 'USER')[0]
 return @"
BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='10s';DO `$`$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id='$($account.authId)'::uuid AND email='$($account.email)' AND raw_app_meta_data->>'phase10_role_evaluation_id'='$($Fixture.fixtureId)') THEN RAISE EXCEPTION 'PHASE10_ROLE_TARGET'; END IF;
 UPDATE phase08_meta_ads.app_users SET role='GUEST',authz_version=2,updated_at=now() WHERE id='$($account.appId)'::uuid AND auth_user_id='$($account.authId)'::uuid AND email='$($account.email)' AND role='USER' AND is_active=true AND authz_version=1;
 IF NOT FOUND THEN RAISE EXCEPTION 'PHASE10_ROLE_DEMOTE_CAS'; END IF;
 INSERT INTO phase08_meta_ads.security_audit_events(id,actor_type,action,target_type,target_id,result,after_json) VALUES(gen_random_uuid(),'SYSTEM','PHASE10_EVALUATION_ROLE_DEMOTED','APP_USER','$($account.appId)','SUCCESS','{"role":"GUEST","fixtureId":"$($Fixture.fixtureId)"}'::jsonb);
END `$`$;COMMIT;
"@
}
function Test-Phase10RoleCleanupState($Fixture,$State) {
 Assert-Phase10RoleFixture $Fixture
 foreach($row in @($State.app_users)){
  $expected=@($Fixture.accounts|Where-Object appId -CEQ $row.id);if($expected.Count -ne 1){return $false}
  $version=if($expected[0].role -ceq 'USER'){3}else{2};$roles=if($expected[0].role -ceq 'USER'){@('USER','GUEST')}else{@('ADMIN')}
  if($row.isActive -ne $false -or $row.version -ne $version -or $row.matched -ne $true -or $row.role -cnotin $roles -or $row.authId -cne $expected[0].authId){return $false}
 }
 return $true
}
function Get-Phase10RoleResidualState($Fixture,$State) {
 Assert-Phase10RoleFixture $Fixture;$authRows=@($State.auth_users);$appRows=@($State.app_users)
 $orphans=@($authRows|Where-Object {$authRow=$_;@($appRows|Where-Object authId -CEQ $authRow.id).Count -eq 0}|ForEach-Object {$_.id})
 $authIdentityValid=$true
 foreach($row in $authRows){$expected=@($Fixture.accounts|Where-Object authId -CEQ $row.id);if($expected.Count -ne 1 -or $row.fixtureMatched -ne $true -or $row.confirmed -ne $true -or $row.authRole -cne 'authenticated' -or $row.preparedRole -cne $expected[0].role){$authIdentityValid=$false}}
 return @{authRowCount=$authRows.Count;appRowCount=$appRows.Count;orphanAuthIds=$orphans;orphanAuthCount=$orphans.Count;authIdentityValid=$authIdentityValid;identitySetComplete=($authRows.Count -eq 2 -and $appRows.Count -eq 2 -and $orphans.Count -eq 0 -and $authIdentityValid);authRowsPreserved=$true;authRowsDeleted=0}
}
function Get-Phase10RoleAdminHeaders {
 $token=$null;$headers=$null;$keys=$null;$bytes=$null
 try {
  $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
  $keys=Invoke-RestMethod -Uri 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/api-keys?reveal=true' -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 30
  $selected=@($keys|Where-Object {$_.name -ceq 'service_role' -and $_.type -ceq 'legacy'});if($selected.Count -ne 1){throw 'role-existing-key'}
  $jwt=[string]$selected[0].api_key;$segments=$jwt.Split('.');if($segments.Count -ne 3 -or $jwt.Length -gt 8192){throw 'role-key-format'}
  $encoded=$segments[1].Replace('-','+').Replace('_','/');$encoded=$encoded.PadRight($encoded.Length+((4-$encoded.Length%4)%4),'=');$bytes=[Convert]::FromBase64String($encoded);$claims=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
  if($claims.ref -cne 'ehnfrrmbkvlsbpvqcvkr' -or $claims.role -cne 'service_role' -or $claims.exp -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+300){throw 'role-existing-key-identity'}
  return @{apikey=$jwt;Authorization=('Bearer '+$jwt)}
 }finally{if($headers){$headers.Clear()};if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};$token=$null;$keys=$null;$jwt=$null;$claims=$null}
}
function Assert-Phase10RoleDeployment([string]$Deployment,[string]$Source) {
 if($Deployment -cnotmatch '^[a-f0-9-]{36}$' -or $Source -cnotmatch '^[a-f0-9]{64}$'){throw 'role-candidate-required'}
 $state=Invoke-Phase08SchedulerGraph 'query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s) serviceInstance(environmentId:$e,serviceId:$s){serviceId environmentId latestDeployment{id status}}}' @{p='d72f4256-8632-437a-9dae-9b5d96736fc7';e='d261a432-a6a4-4031-b8ea-c619ac263cc3';s='4b30daa8-9333-46b7-ad89-cfd64ff5266c'}
 if($state.serviceInstance.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or $state.serviceInstance.environmentId -cne 'd261a432-a6a4-4031-b8ea-c619ac263cc3' -or $state.serviceInstance.latestDeployment.id -cne $Deployment -or $state.serviceInstance.latestDeployment.status -cnotin @('SUCCESS','SLEEPING') -or $state.variables.PHASE08_SOURCE_CONTENT_SHA256 -cne $Source -or $state.variables.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $state.variables.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $state.variables.AUTH_PROVIDER -cne 'supabase'){throw 'role-candidate-identity'}
}
function Get-Phase10RoleRoutes([string]$Role,[string]$ConnectionId) {
 if($Role -cnotin @('USER','ADMIN') -or $ConnectionId -cnotmatch '^[a-f0-9-]{36}$'){throw 'role-matrix-input'}
 return @(@{method='GET';path='/storefront/summary?from=2026-10-14&to=2026-10-14';expected=200},@{method='POST';path='/sync-runs';expected=$(if($Role -ceq 'USER'){403}else{400})},@{method='GET';path="/storefront/connections/$ConnectionId/runs";expected=$(if($Role -ceq 'USER'){403}else{200})},@{method='PATCH';path="/storefront/connections/$ConnectionId/enabled";expected=403},@{method='POST';path='/source-connections';expected=403})
}

if($MyInvocation.InvocationName -ceq '.'){return}
$fixture=$null;$context=$null;$adminHeaders=$null;$headers=$null;$session=$null;$response=$null;$body=$null;$plain=$null;$cipher=$null;$all=$null;$loggedIn=$false;$stage='INPUT';$passed=$false;$steps=[Collections.Generic.List[object]]::new();$before=$null;$after=$null;$cleanupVerified=$false;$lastHttp=$null;$residual=$null
try {
 $ProtectedPath=Assert-Phase10RoleProtectedPath $ProtectedPath
 if(-not $EvidencePath -or (Test-Path -LiteralPath $EvidencePath)){throw 'role-new-evidence-required'}
 if($Mode -ceq 'Prepare'){
  if(Test-Path -LiteralPath $ProtectedPath){throw 'role-protected-exists'}
  $accounts=@();foreach($role in @('USER','ADMIN')){$authId=[Guid]::NewGuid().ToString();$random=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($random);$accounts+=@{role=$role;authId=$authId;appId=[Guid]::NewGuid().ToString();email=('phase10-role-'+$authId+'@example.invalid');password=[Convert]::ToBase64String($random)};[Array]::Clear($random,0,$random.Length)}
  $fixture=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';schema='phase08_meta_ads';fixtureId=[Guid]::NewGuid().ToString();preparedAt=[DateTimeOffset]::UtcNow.ToString('o');accounts=$accounts};Assert-Phase10RoleFixture $fixture
  $plain=[Text.Encoding]::UTF8.GetBytes(($fixture|ConvertTo-Json -Depth 6 -Compress));$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase10/Roles/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser);$magic=[Text.Encoding]::ASCII.GetBytes('PHASE10-ROLES-1');$all=[byte[]]::new($magic.Length+$cipher.Length);[Array]::Copy($magic,0,$all,0,$magic.Length);[Array]::Copy($cipher,0,$all,$magic.Length,$cipher.Length)
  $stream=[IO.File]::Open($ProtectedPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($all,0,$all.Length)}finally{$stream.Dispose()};Set-Phase08NewPrivateAcl -Path $ProtectedPath;$null=Read-Phase10RoleFixture $ProtectedPath;$passed=$true;$stage='PREPARED_LOCAL_ONLY'
 }else{
  $fixture=Read-Phase10RoleFixture $ProtectedPath;$context=Read-Phase08ProtectedJson
  if($context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app' -or $context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.env.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or $context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c'){throw 'role-context-identity'}
  $before=@(Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleStateSql $fixture))[0];Assert-Phase10RoleState $before
  if($Mode -ceq 'Inspect'){$passed=$true;$stage='READ_ONLY_INSPECTION'}
  elseif($Mode -ceq 'Cleanup'){
   $stage='CLEANUP_ONLY';$null=Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleCleanupSql $fixture);$after=@(Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleStateSql $fixture))[0];Assert-Phase10RoleState $after;$cleanupVerified=Test-Phase10RoleCleanupState $fixture $after;$passed=$cleanupVerified -and $before.existing_app_users_hash -ceq $after.existing_app_users_hash
  }else{
   Assert-Phase10RoleDeployment $ExpectedDeploymentId $ExpectedSourceSha
   if(@($before.app_users).Count -ne 0 -or @($before.auth_users).Count -ne 0){throw 'role-fresh-identities-required'}
   Write-Phase10RoleEvidence @{kind='PHASE10_ROLE_MUTATION_ATTEMPT';fixtureId=$fixture.fixtureId;at=[DateTimeOffset]::UtcNow.ToString('o');deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;authIds=@($fixture.accounts.authId);appIds=@($fixture.accounts.appId);inspectBeforeAnyRetry=$true} ($EvidencePath+'.attempt.json')
   $adminHeaders=Get-Phase10RoleAdminHeaders
   foreach($account in $fixture.accounts){
    $stage='AUTH_CREATE_'+$account.role;$body=@{id=$account.authId;email=$account.email;password=$account.password;email_confirm=$true;app_metadata=@{phase10_role_evaluation_id=$fixture.fixtureId;phase10_role=$account.role}}|ConvertTo-Json -Compress
    try{$response=Invoke-WebRequest -Uri 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1/admin/users' -Method Post -Headers $adminHeaders -ContentType 'application/json' -Body $body -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck}finally{$body=$null}
    if([int]$response.StatusCode -notin @(200,201)){throw 'role-auth-create-inspect-no-retry'};$user=$response.Content|ConvertFrom-Json
    if($user.id -cne $account.authId -or $user.email -cne $account.email -or $user.role -cne 'authenticated' -or -not $user.email_confirmed_at -or $user.app_metadata.phase10_role_evaluation_id -cne $fixture.fixtureId -or $user.app_metadata.phase10_role -cne $account.role){throw 'role-auth-create-identity'};$steps.Add(@{stage=$stage;status='PASS';id=$account.authId;emailDelivery=0});$response=$null;$user=$null
   }
   $stage='APP_USERS_CREATE';$null=Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleCreateSql $fixture)
   foreach($account in $fixture.accounts){
    $headers=@{Origin=$context.origin};$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new();$stage='LOGIN_'+$account.role
    $response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/auth/login') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body (@{email=$account.email;password=$account.password}|ConvertTo-Json -Compress) -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o')
    if([int]$response.StatusCode -ne 200){throw 'role-login'};$loggedIn=$true;$me=$response.Content|ConvertFrom-Json
    if($me.user.id -cne $account.appId -or $me.user.role -cne $account.role -or $me.user.isActive -ne $true -or $me.permissions -cnotcontains 'data.read' -or $me.permissions -ccontains 'settings.manage' -or (($me.permissions -ccontains 'imports.manage') -ne ($account.role -ceq 'ADMIN')) -or $response.Content.Contains($account.password)){throw 'role-login-permissions'}
    $cookies=@($session.Cookies.GetCookies([Uri]$context.origin));if($cookies.Count -ne 4 -or @($cookies|Where-Object {-not $_.Secure -or $_.Path -cne '/' -or ($_.Name -cne '__Host-phase08-meta_csrf' -and -not $_.HttpOnly)}).Count -ne 0){throw 'role-login-cookies'}
    $previousAuthorizationVersion=$me.authorizationVersion;$steps.Add(@{stage='NORMAL_HTTP_LOGIN';role=$account.role;httpStatus=200;secureCookieCount=4;status='PASS'})
    $csrf=@($cookies|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'});if($csrf.Count -ne 1){throw 'role-csrf'};$headers['X-CSRF-Token']=$csrf[0].Value;$response=$null;$me=$null
    foreach($route in (Get-Phase10RoleRoutes $account.role $context.ids.metaConnectionId)){
     $stage=$account.role+'_'+$route.method+'_'+$route.path;$request=@{Uri=$context.origin+'/backend-api'+$route.path;Method=$route.method;Headers=$headers;WebSession=$session;MaximumRedirection=0;TimeoutSec=45;SkipHttpErrorCheck=$true};if($route.method -cne 'GET'){$request.ContentType='application/json';$request.Body='{}'}
     $response=Invoke-WebRequest @request;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');$http=[int]$response.StatusCode;$code=$null;if($http -ge 400){$errorBody=$response.Content|ConvertFrom-Json;if($errorBody.code -cin (Get-Phase08SourceSafeCodes)){$code=$errorBody.code};$errorBody=$null}
     $steps.Add(@{role=$account.role;method=$route.method;path=$route.path;httpStatus=$http;safeCode=$code;status=$(if($http -eq $route.expected){'PASS'}else{'FAIL'});mutationBody=$(if($route.method -ceq 'GET'){'NONE'}else{'EMPTY_OBJECT_ONLY'})});$response=$null
    }
    if($account.role -ceq 'USER'){
     $stage='USER_TO_GUEST_CAS';$null=Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleDemoteSql $fixture)
     $stage='GUEST_SAME_SESSION_ME';$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/auth/me') -Method Get -Headers $headers -WebSession $session -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 200){throw 'guest-live-me'};$guest=$response.Content|ConvertFrom-Json
     if($guest.user.id -cne $account.appId -or $guest.user.role -cne 'GUEST' -or $guest.permissions -cnotcontains 'data.read' -or $guest.permissions -ccontains 'reports.generate' -or $guest.authorizationVersion -ceq $previousAuthorizationVersion){throw 'guest-live-role'}
     $steps.Add(@{stage='DB_ROLE_DEMOTION_VERIFIED';role='GUEST';httpStatus=200;status='PASS';sameSession=$true;authorizationVersionChanged=$true});$guest=$null;$response=$null
     foreach($guestRoute in @(@{method='GET';path='/storefront/summary?from=2026-10-14&to=2026-10-14';expected=200},@{method='GET';path='/reports';expected=200},@{method='POST';path='/reports/export';expected=403})){
      $stage='GUEST_'+$guestRoute.method+'_'+$guestRoute.path;$guestRequest=@{Uri=$context.origin+'/backend-api'+$guestRoute.path;Method=$guestRoute.method;Headers=$headers;WebSession=$session;MaximumRedirection=0;TimeoutSec=45;SkipHttpErrorCheck=$true};if($guestRoute.method -ceq 'POST'){$guestRequest.ContentType='application/json';$guestRequest.Body='{}'}
      $response=Invoke-WebRequest @guestRequest;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');$http=[int]$response.StatusCode;$steps.Add(@{role='GUEST';method=$guestRoute.method;path=$guestRoute.path;httpStatus=$http;status=$(if($http -eq $guestRoute.expected){'PASS'}else{'FAIL'});sameSession=$true;mutationBody=$(if($guestRoute.method -ceq 'GET'){'NONE'}else{'EMPTY_OBJECT_ONLY'})});$response=$null
     }
    }
    $stage='LOGOUT_'+$account.role;$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');if([int]$response.StatusCode -ne 204){throw 'role-logout'};$loggedIn=$false;$headers.Clear();$headers=$null;$session=$null;$response=$null
   }
   Assert-Phase10RoleDeployment $ExpectedDeploymentId $ExpectedSourceSha;$passed=@($steps|Where-Object {$_.status -cne 'PASS'}).Count -eq 0;$stage='ROLE_MATRIX_COMPLETE'
  }
 }
}catch{$steps.Add(@{stage=$stage;status='FAIL';rawErrorSuppressed=$true;inspectBeforeRetry=$true})}
finally{
 if($loggedIn -and $headers -and $session){try{$response=Invoke-WebRequest -Uri ($context.origin+'/backend-api/auth/logout') -Method Post -Headers $headers -WebSession $session -ContentType 'application/json' -Body '{}' -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck;$lastHttp=[DateTimeOffset]::UtcNow.ToString('o');$loggedIn=([int]$response.StatusCode -ne 204)}catch{$passed=$false}}
 if($Mode -ceq 'Execute' -and $fixture -and $context){
  try{$inspection=@(Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleStateSql $fixture))[0];Assert-Phase10RoleState $inspection
   if(@($inspection.app_users).Count -gt 0){$null=Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleCleanupSql $fixture)}
   $after=@(Invoke-Phase08Management -Action Query -Query (Get-Phase10RoleStateSql $fixture))[0];Assert-Phase10RoleState $after
   $cleanupVerified=Test-Phase10RoleCleanupState $fixture $after
   $residual=Get-Phase10RoleResidualState $fixture $after
   if(-not $cleanupVerified -or -not $residual.identitySetComplete -or ($before -and $before.existing_app_users_hash -cne $after.existing_app_users_hash)){$passed=$false}
  }catch{$passed=$false;$steps.Add(@{stage='CLEANUP_INSPECT_REQUIRED';status='FAIL';rawErrorSuppressed=$true})}
 }
 if(-not $residual -and $fixture -and ($after -or $before)){$residual=Get-Phase10RoleResidualState $fixture $(if($after){$after}else{$before})}
 $receipt=@{kind='PHASE10_ROLE_MATRIX';mode=$Mode;classification=$(switch($Mode){'Prepare'{'LOCAL_DPAPI_PREPARED_NO_REMOTE'}'Inspect'{'ACTUAL_READ_ONLY_INSPECTION'}'Cleanup'{'ACTUAL_TEST_IDENTITY_CLEANUP'}default{'ACTUAL_HTTP_ROLE_MATRIX'}});observedAt=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($passed){'PASS'}else{'FAIL'});stage=$stage;protectedReference=$ProtectedPath;deploymentId=$ExpectedDeploymentId;sourceSha=$ExpectedSourceSha;fixtureId=$(if($fixture){$fixture.fixtureId}else{$null});accounts=$(if($fixture){@($fixture.accounts|Select-Object role,authId,appId)}else{@()});steps=$steps.ToArray();before=$before;after=$after;cleanupVerified=$cleanupVerified;cleanupScope='EXACT_NEW_APP_ROWS_INACTIVE_ONLY_AUTH_ROWS_PRESERVED';authResidual=$residual;sessionMayRemain=$loggedIn;lastAppHttpAt=$lastHttp;actualOriginBrowserLogin=$false;actualRolesVerified=@($steps|Where-Object {$_.ContainsKey('stage') -and $_.stage -cin @('NORMAL_HTTP_LOGIN','DB_ROLE_DEMOTION_VERIFIED') -and $_.status -ceq 'PASS'}|ForEach-Object {$_.role});newAuthUsersDeleted=0;emailRequests=0;validBusinessMutationBodiesSent=0;newTestIdentityWritesExpected=($Mode -cin @('Execute','Cleanup'));existingBusinessWrites=0;operatingChanges=0;rawResponsesSaved=0}
 if($EvidencePath){Write-Phase10RoleEvidence $receipt $EvidencePath}
 foreach($bytes in @($plain,$cipher,$all)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}};if($headers){$headers.Clear()};if($adminHeaders){$adminHeaders.Clear()};$fixture=$null;$accounts=$null;$account=$null;$context=$null;$headers=$null;$session=$null;$response=$null;$adminHeaders=$null;$body=$null;$csrf=$null;$cookies=$null;$user=$null;$me=$null
}
@{kind=$receipt.kind;mode=$Mode;status=$receipt.status;cleanupVerified=$cleanupVerified;evidence=$EvidencePath;rawValuesReturned=0}|ConvertTo-Json -Compress
if(-not $passed){exit 1}
