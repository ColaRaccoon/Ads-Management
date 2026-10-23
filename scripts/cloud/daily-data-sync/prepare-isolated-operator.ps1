param([Parameter(Mandatory)][ValidateSet('Prepare','Auth','AppUser','Login')][string]$Mode)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/operator-session.ps1"
$phase08OperatorPath='C:\Users\seong\AppData\Local\MetaAdsPhase08Runtime\operator-context.dpapi'
$phase08Operator=$null;$phase08Context=$null;$phase08Headers=$null;$phase08Plain=$null;$phase08Encrypted=$null;$phase08All=$null
$phase08Stage='LOCAL_GUARD';$phase08HttpStatus=$null

function Assert-Phase08AuthOperator($user) {
  if($user.id -cne $phase08Operator.authId -or $user.email -cne $phase08Operator.email -or
    $user.role -cne 'authenticated' -or -not $user.email_confirmed_at -or
    $user.app_metadata.phase08_evaluation_id -cne $phase08Operator.authId){throw 'auth-identity'}
}
function Get-Phase08AuthAdminHeaders {
  $token=$null;$headers=$null;$keys=$null;$jwt=$null;$bytes=$null
  try {
    # Read an existing legacy server JWT for this isolated project. No key creation or rotation.
    $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
    $keys=Invoke-RestMethod -Uri 'https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr/api-keys?reveal=true' -Method Get -Headers $headers -MaximumRedirection 0 -TimeoutSec 30
    $selected=@($keys|Where-Object {$_.name -ceq 'service_role' -and $_.type -ceq 'legacy'})
    if($selected.Count -ne 1){throw 'existing-admin-key'}
    $jwt=[string]$selected[0].api_key;$segments=$jwt.Split('.')
    if($segments.Count -ne 3 -or $jwt.Length -gt 8192){throw 'jwt'}
    $encoded=$segments[1].Replace('-','+').Replace('_','/');$encoded=$encoded.PadRight($encoded.Length+((4-$encoded.Length%4)%4),'=')
    $bytes=[Convert]::FromBase64String($encoded);$claims=[Text.Encoding]::UTF8.GetString($bytes)|ConvertFrom-Json
    if($claims.ref -cne 'ehnfrrmbkvlsbpvqcvkr' -or $claims.role -cne 'service_role' -or
      ($claims.exp -isnot [int] -and $claims.exp -isnot [long]) -or $claims.exp -le [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+300){throw 'jwt-identity'}
    return @{apikey=$jwt;Authorization=('Bearer '+$jwt)}
  } finally {if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};if($headers){$headers.Clear()};$token=$null;$keys=$null;$jwt=$null;$claims=$null}
}

try {
  if($Mode -eq 'Prepare'){
    Assert-Phase08PrivatePath -Path (Split-Path $phase08OperatorPath) -Directory
    if(Test-Path -LiteralPath $phase08OperatorPath){throw 'no-overwrite'}
    $phase08AuthId=[Guid]::NewGuid().ToString()
    $phase08Random=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($phase08Random)
    $phase08Operator=@{version=1;projectRef='ehnfrrmbkvlsbpvqcvkr';schema='phase08_meta_ads';authId=$phase08AuthId;appId=[Guid]::NewGuid().ToString();email=('phase08-eval-'+$phase08AuthId+'@example.invalid');password=[Convert]::ToBase64String($phase08Random)}
    [Array]::Clear($phase08Random,0,$phase08Random.Length)
    $phase08Plain=[Text.Encoding]::UTF8.GetBytes(($phase08Operator|ConvertTo-Json -Compress))
    $phase08Encrypted=[Security.Cryptography.ProtectedData]::Protect($phase08Plain,[Text.Encoding]::ASCII.GetBytes('MetaAdsPhase08/operator/v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $phase08Magic=[Text.Encoding]::ASCII.GetBytes('PHASE08-OPERATOR-1');$phase08All=[byte[]]::new($phase08Magic.Length+$phase08Encrypted.Length)
    [Array]::Copy($phase08Magic,0,$phase08All,0,$phase08Magic.Length);[Array]::Copy($phase08Encrypted,0,$phase08All,$phase08Magic.Length,$phase08Encrypted.Length)
    $phase08File=[IO.File]::Open($phase08OperatorPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$phase08File.Write($phase08All,0,$phase08All.Length)}finally{$phase08File.Dispose()}
    Set-Phase08NewPrivateAcl -Path $phase08OperatorPath
    $phase08Roundtrip=Read-Phase08Operator
    if($phase08Roundtrip.password -cne $phase08Operator.password){throw 'roundtrip'}
    [ordered]@{state='PHASE08_OPERATOR_DPAPI_PREPARED';remoteChanges=0;plaintextFiles=0}|ConvertTo-Json
  } else {
    $phase08Operator=Read-Phase08Operator;$phase08Context=Read-Phase08ProtectedJson
    if($phase08Context.env.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $phase08Context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'runtime-identity'}
    $phase08AuthBase='https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1'
    # apikey-only modern-key GET succeeded, but POST returned 401. Use the existing
    # isolated legacy server JWT for admin endpoints; keep runtime keys unchanged.
    $phase08Headers=@{}
    if($Mode -eq 'Auth'){
      $phase08Stage='AUTH_FRESHNESS_READ';
      $phase08Before=Invoke-Phase08Management -Action ReadOnlyQuery -Query "SELECT count(*)::int AS existing FROM auth.users WHERE id='$($phase08Operator.authId)'::uuid OR email='$($phase08Operator.email)';"
      if($phase08Before.existing -ne 0){throw 'existing-auth-inspect-no-retry'}
      $phase08Stage='AUTH_ADMIN_KEY_READ';$phase08Headers=Get-Phase08AuthAdminHeaders
      $phase08Body=@{id=$phase08Operator.authId;email=$phase08Operator.email;password=$phase08Operator.password;email_confirm=$true;app_metadata=@{phase08_evaluation_id=$phase08Operator.authId}}|ConvertTo-Json -Compress
      $phase08Stage='AUTH_CREATE';
      $phase08Response=Invoke-WebRequest -Uri "$phase08AuthBase/admin/users" -Method Post -Headers $phase08Headers -ContentType 'application/json' -Body $phase08Body -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
      $phase08HttpStatus=[int]$phase08Response.StatusCode
      if([int]$phase08Response.StatusCode -notin @(200,201)){throw 'auth-create-outcome-inspect-no-retry'}
      $phase08User=$phase08Response.Content|ConvertFrom-Json
      Assert-Phase08AuthOperator $phase08User
      [ordered]@{state='PHASE08_FRESH_AUTH_OPERATOR_CREATED';authRole='authenticated';emailDelivery=0;oldUsersChanged=0;operatingChanges=0}|ConvertTo-Json
    } elseif($Mode -eq 'AppUser'){
      $phase08Stage='AUTH_ADMIN_KEY_READ';$phase08Headers=Get-Phase08AuthAdminHeaders
      $phase08Response=Invoke-WebRequest -Uri "$phase08AuthBase/admin/users/$($phase08Operator.authId)" -Method Get -Headers $phase08Headers -MaximumRedirection 0 -TimeoutSec 20 -SkipHttpErrorCheck
      if([int]$phase08Response.StatusCode -ne 200){throw 'auth-read'}
      $phase08User=$phase08Response.Content|ConvertFrom-Json;Assert-Phase08AuthOperator $phase08User
      $phase08Sql=@"
BEGIN;
DO `$`$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR
  (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68 OR
  EXISTS(SELECT 1 FROM phase08_meta_ads.app_users) OR
  NOT EXISTS(SELECT 1 FROM auth.users WHERE id='$($phase08Operator.authId)'::uuid AND email='$($phase08Operator.email)' AND email_confirmed_at IS NOT NULL AND role='authenticated' AND raw_app_meta_data->>'phase08_evaluation_id'='$($phase08Operator.authId)')
 THEN RAISE EXCEPTION 'PHASE08_FRESH_OPERATOR_REQUIRED'; END IF;
END `$`$;
INSERT INTO phase08_meta_ads.app_users(id,email,normalized_email,name,role,invite_status,auth_user_id,is_active,authz_version,updated_at)
 VALUES('$($phase08Operator.appId)'::uuid,'$($phase08Operator.email)','$($phase08Operator.email)','Phase08 isolated evaluator','SUPER_ADMIN','ACTIVE','$($phase08Operator.authId)'::uuid,true,1,now());
INSERT INTO phase08_meta_ads.security_audit_events(id,actor_type,action,target_type,target_id,result,after_json)
 VALUES(gen_random_uuid(),'SYSTEM','PHASE08_EVALUATION_OPERATOR_CREATED','APP_USER','$($phase08Operator.appId)','SUCCESS','{"role":"SUPER_ADMIN","isolatedEvaluation":true}'::jsonb);
COMMIT;
"@
      $phase08Discard=Invoke-Phase08Management -Action Query -Query $phase08Sql;$phase08Discard=$null
      [ordered]@{state='PHASE08_NEW_SCHEMA_OPERATOR_CREATED';role='SUPER_ADMIN';oldUsersChanged=0;operatingChanges=0}|ConvertTo-Json
    } else {
      $phase08Headers.Clear();$phase08Headers=@{Origin=$phase08Context.origin}
      $phase08Body=@{email=$phase08Operator.email;password=$phase08Operator.password}|ConvertTo-Json -Compress
      $phase08Session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
      $phase08Response=Invoke-WebRequest -Uri ($phase08Context.origin+'/backend-api/auth/login') -Method Post -Headers $phase08Headers -ContentType 'application/json' -Body $phase08Body -WebSession $phase08Session -MaximumRedirection 0 -TimeoutSec 45 -SkipHttpErrorCheck
      Assert-Phase08LoginResponse $phase08Response $phase08Session $phase08Operator $phase08Context.origin
      [ordered]@{state='PHASE08_NORMAL_LOGIN_CHECK';httpStatus=200;cookieCount=4;noStore=$true;bodySecretPresent=$false;role='SUPER_ADMIN';identityVerified=$true;settingsManage=$true;secureHostCookies=$true}|ConvertTo-Json
    }
  }
} catch {[ordered]@{state='PHASE08_OPERATOR_PREPARATION_FAILED';mode=$Mode;stage=$phase08Stage;httpStatus=$phase08HttpStatus;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1}
finally {
 foreach($bytes in @($phase08Plain,$phase08Encrypted,$phase08All)){if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
 if($phase08Headers){$phase08Headers.Clear()};$phase08Operator=$null;$phase08Context=$null;$phase08User=$null;$phase08Roundtrip=$null;$phase08Body=$null;$phase08Sql=$null;$phase08Payload=$null;$phase08Response=$null;$phase08Session=$null
}
