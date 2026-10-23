param([ValidatePattern('^[a-z0-9-]+$')][string]$Label='user-preservation-20261019')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/source-connection-helpers.ps1"
$context=$null;$operator=$null;$stage='CONTEXT'
try {
 $context=Read-Phase08ProtectedJson;$operator=Read-Phase08Operator;Assert-Phase08SourceContext $context $operator
 $root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';$role=Get-Content -LiteralPath "$root/ui-role-candidate-v5.json" -Raw|ConvertFrom-Json
 $accounts=@($role.accounts);if($accounts.Count -ne 2 -or @($accounts|Where-Object {$_.appId -cnotmatch '^[a-f0-9-]{36}$' -or $_.authId -cnotmatch '^[a-f0-9-]{36}$' -or $_.role -cnotin @('USER','ADMIN')}).Count){throw 'fixture-ids'}
 $a=$accounts[0];$b=$accounts[1];$stage='READONLY'
 $sql=@"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL statement_timeout=10000;
SELECT current_database() AS database,current_user AS principal,
 (SELECT count(*)::int FROM pg_tables WHERE schemaname='phase08_meta_ads') AS tables,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'role',u.role,'isActive',u.is_active,'inviteStatus',u.invite_status,'authzVersion',u.authz_version,'deactivated',u.deactivated_at IS NOT NULL,'isOriginalOperator',u.id='$($operator.appId)'::uuid,'operatorIdentityMatches',CASE WHEN u.id='$($operator.appId)'::uuid THEN u.auth_user_id='$($operator.authId)'::uuid AND u.email='$($operator.email)' AND u.normalized_email='$($operator.email)' ELSE NULL END,'lastLoginAt',u.last_login_at,'updatedAt',u.updated_at,'createdAt',u.created_at,'stableFieldsHash',md5((to_jsonb(u)-'last_login_at'-'updated_at')::text)) ORDER BY u.id),'[]') FROM phase08_meta_ads.app_users u) AS users,
 (SELECT md5(coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.id)::text,'[]')) FROM phase08_meta_ads.app_users u WHERE u.id NOT IN ('$($a.appId)'::uuid,'$($b.appId)'::uuid)) AS originalFullRowHash,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('action',action,'result',result,'at',created_at,'roleAfter',CASE WHEN after_json->>'role' IN ('GUEST','USER','ADMIN','SUPER_ADMIN') THEN after_json->>'role' ELSE NULL END,'roleBefore',CASE WHEN before_json->>'role' IN ('GUEST','USER','ADMIN','SUPER_ADMIN') THEN before_json->>'role' ELSE NULL END) ORDER BY created_at),'[]') FROM phase08_meta_ads.security_audit_events WHERE target_id='$($operator.appId)' AND created_at>='2026-10-19T04:26:12Z') AS originalOperatorAudits;
ROLLBACK;
"@
 $state=@(Invoke-Phase08Management -Action Query -Query $sql)[0]
 if($state.database -cne 'postgres' -or $state.principal -cne 'postgres' -or $state.tables -ne 68){throw 'database-identity'}
 $original=@($state.users|Where-Object isOriginalOperator -EQ $true);if($original.Count -ne 1){throw 'original-operator-count'}
 $originalExpected=$original[0].operatorIdentityMatches -eq $true -and $original[0].role -ceq 'SUPER_ADMIN' -and $original[0].isActive -eq $true -and $original[0].inviteStatus -ceq 'ACTIVE' -and $original[0].deactivated -eq $false
 $newExpected=@($state.users).Count -eq 3
 foreach($account in $accounts){$row=@($state.users|Where-Object id -CEQ $account.appId);$version=if($account.role -ceq 'USER'){3}else{2};$expectedRole=if($account.role -ceq 'USER'){'GUEST'}else{'ADMIN'};if($row.Count -ne 1 -or $row[0].role -cne $expectedRole -or $row[0].isActive -ne $false -or $row[0].authzVersion -ne $version){$newExpected=$false}}
 $out=[ordered]@{kind='PHASE10_INDEPENDENT_APP_USER_PRESERVATION';observedAt=[DateTimeOffset]::UtcNow.ToString('o');classification='ACTUAL_ISOLATED_DATABASE_READ_ONLY_CURRENT_IDENTITY_CHECK';current=$state;originalOperatorExpectedIdentityAndAuthority=$originalExpected;newFixtureRowsExactlyTwoAndInactive=$newExpected;roleAttemptFullHashBefore=$role.before.existing_app_users_hash;roleAttemptFullHashAfter=$role.after.existing_app_users_hash;currentOriginalFullHash=$state.originalFullRowHash;originalRoleAttemptStatus=$role.status;originalRoleAttemptFailPreserved=$true;baseline1326HasStableFieldBeforeImage=$false;historicalStableFieldEqualityProven=$false;timestampOnlyChangeProven=$false;limitation='13:26 baseline retained one full-row table digest rather than per-field before-image; current authority and earlier real HTTP principal can be compared but timestamp-only cause cannot be proven from that digest';appHttpRequests=0;providerRequests=0;databaseWrites=0}
 $destination="$root/independent/$Label.json";$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($out|ConvertTo-Json -Depth 10));$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 @{kind=$out.kind;originalOperatorExpected=$originalExpected;newFixtureRowsExpected=$newExpected;historicalStableEqualityProven=$false;evidence=$destination;rawPrivateValuesReturned=0}|ConvertTo-Json -Compress
}catch{@{kind='PHASE10_INDEPENDENT_APP_USER_PRESERVATION';status='FAIL';stage=$stage;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{$context=$null;$operator=$null}
