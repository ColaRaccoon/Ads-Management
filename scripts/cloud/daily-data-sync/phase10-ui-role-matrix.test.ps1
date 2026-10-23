Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-ui-role-matrix.ps1"
$fixture=[pscustomobject]@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';schema='phase08_meta_ads';fixtureId='a0000000-0000-4000-8000-000000000001';accounts=@(
 [pscustomobject]@{role='USER';authId='a0000000-0000-4000-8000-000000000002';appId='a0000000-0000-4000-8000-000000000003';email='phase10-role-a0000000-0000-4000-8000-000000000002@example.invalid';password=('A'*43)+'='},
 [pscustomobject]@{role='ADMIN';authId='a0000000-0000-4000-8000-000000000004';appId='a0000000-0000-4000-8000-000000000005';email='phase10-role-a0000000-0000-4000-8000-000000000004@example.invalid';password=('B'*43)+'='}
)}
Assert-Phase10RoleFixture $fixture
$read=Get-Phase10RoleStateSql $fixture;if($read -notmatch 'BEGIN READ ONLY' -or $read -match '(?i)\b(INSERT|UPDATE|DELETE)\b'){throw 'read-only-sql'}
$create=Get-Phase10RoleCreateSql $fixture
if(([regex]::Matches($create,'INSERT INTO phase08_meta_ads.app_users')).Count -ne 2 -or $create -notmatch "email_confirmed_at IS NOT NULL" -or $create -notmatch 'PHASE10_NEW_ROLE_REQUIRED' -or $create.Contains($fixture.accounts[0].password) -or $create -match '(?i)\b(UPDATE|DELETE)\b'){throw 'create-sql-scope'}
$cleanup=Get-Phase10RoleCleanupSql $fixture
if(([regex]::Matches($cleanup,'UPDATE phase08_meta_ads.app_users')).Count -ne 2 -or $cleanup -notmatch 'is_active=true AND authz_version=1' -or $cleanup -notmatch 'SET is_active=false,authz_version=2' -or $cleanup -match '(?i)\bDELETE\b' -or $cleanup -match 'UPDATE auth.users'){throw 'cleanup-cas-scope'}
$demote=Get-Phase10RoleDemoteSql $fixture
if($demote -notmatch "SET role='GUEST',authz_version=2" -or $demote -notmatch "role='USER' AND is_active=true AND authz_version=1" -or $demote.Contains($fixture.accounts[1].appId) -or $cleanup -notmatch "role IN \('USER','GUEST'\) AND is_active=false AND authz_version=3"){throw 'guest-cas-scope'}
$empty=[pscustomobject]@{app_users=@();auth_users=@()};$emptyResidual=Get-Phase10RoleResidualState $fixture $empty
if(-not (Test-Phase10RoleCleanupState $fixture $empty) -or $emptyResidual.identitySetComplete -or $emptyResidual.authRowCount -ne 0){throw 'empty-cleanup-not-matrix-success'}
$orphan=[pscustomobject]@{app_users=@();auth_users=@([pscustomobject]@{id=$fixture.accounts[0].authId;authRole='authenticated';confirmed=$true;preparedRole='USER';fixtureMatched=$true})};$orphanResidual=Get-Phase10RoleResidualState $fixture $orphan
if($orphanResidual.identitySetComplete -or $orphanResidual.orphanAuthCount -ne 1 -or $orphanResidual.authRowCount -ne 1){throw 'partial-auth-orphan-explicit'}
$finalState=[pscustomobject]@{app_users=@([pscustomobject]@{id=$fixture.accounts[0].appId;authId=$fixture.accounts[0].authId;role='GUEST';isActive=$false;version=3;matched=$true},[pscustomobject]@{id=$fixture.accounts[1].appId;authId=$fixture.accounts[1].authId;role='ADMIN';isActive=$false;version=2;matched=$true});auth_users=@($fixture.accounts|ForEach-Object {[pscustomobject]@{id=$_.authId;authRole='authenticated';confirmed=$true;preparedRole=$_.role;fixtureMatched=$true}})}
if(-not (Test-Phase10RoleCleanupState $fixture $finalState) -or -not (Get-Phase10RoleResidualState $fixture $finalState).identitySetComplete){throw 'guest-final-cleanup-state'}
$finalState.app_users[1].role='GUEST';if(Test-Phase10RoleCleanupState $fixture $finalState){throw 'admin-id-never-guest-cleanup'}
$connection='b0000000-0000-4000-8000-000000000001';$userRoutes=Get-Phase10RoleRoutes 'USER' $connection;$adminRoutes=Get-Phase10RoleRoutes 'ADMIN' $connection
if(@($userRoutes|Where-Object {$_.method -ceq 'POST' -and $_.path -ceq '/sync-runs' -and $_.expected -eq 403}).Count -ne 1 -or @($adminRoutes|Where-Object {$_.method -ceq 'POST' -and $_.path -ceq '/sync-runs' -and $_.expected -eq 400}).Count -ne 1 -or @($adminRoutes|Where-Object {$_.method -ceq 'PATCH' -and $_.expected -eq 403}).Count -ne 1){throw 'role-matrix-contract'}
$fixture.projectRef='iygjmosbelbosfxidqxv';$rejected=$false;try{Assert-Phase10RoleFixture $fixture}catch{$rejected=$true};if(-not $rejected){throw 'prod-rejected'}
$fixture.projectRef='ehnfrrmbkvlsbpvqcvkr';$fixture.accounts[0].role='SUPER_ADMIN';$rejected=$false;try{Assert-Phase10RoleFixture $fixture}catch{$rejected=$true};if(-not $rejected){throw 'expanded-role-rejected'}
@{kind='PHASE10_ROLE_HELPER_SYNTHETIC_TESTS';checks=11;status='PASS';remoteCalls=0;credentialReads=0}|ConvertTo-Json -Compress
