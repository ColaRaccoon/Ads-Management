# Definitions only; no credentials or network are accessed on import.
. "$PSScriptRoot/operator-session.ps1"
function Assert-Phase08SourceContext($context,$operator) {
  if($context.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app' -or
    $context.env.SUPABASE_URL -cne 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co' -or $context.env.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or
    $context.env.SUPABASE_DATABASE_PROJECT_REF -cne 'ehnfrrmbkvlsbpvqcvkr' -or $context.env.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime' -or
    $context.env.DEPLOYMENT_ENVIRONMENT_ID -cne 'phase08-daily-data-sync-08' -or $context.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or
    $operator.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $operator.schema -cne 'phase08_meta_ads' -or
    $operator.appId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'source-context'}
}
function Get-Phase08ConnectionInput([string]$provider) {
  switch -CaseSensitive ($provider) {
    'GOOGLE' {return @{provider='GOOGLE';externalAccountId='1391592099';shopKey='default';displayName='Phase08 isolated Google';currencyCode='KRW';timeZone='Asia/Seoul'}}
    'META' {return @{provider='META';externalAccountId='2138525300002203';shopKey='default';displayName='Phase08 isolated Meta';currencyCode='USD';timeZone='Asia/Seoul'}}
    'CAFE24' {return @{provider='CAFE24';externalAccountId='didadi0729';shopKey='shop1';displayName='Phase08 isolated Cafe24';currencyCode='KRW';timeZone='Asia/Seoul'}}
    default {throw 'provider'}
  }
}
function Assert-Phase08Connection($connection,[string]$provider,[switch]$Pending) {
  $expected=Get-Phase08ConnectionInput $provider
  foreach($key in @('provider','externalAccountId','shopKey','currencyCode','timeZone')){if($connection.$key -cne $expected[$key]){throw 'connection-identity'}}
  if($connection.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $connection.enabled -isnot [bool] -or
    $connection.accessState -cnotin @('PENDING','READY','REAUTH_REQUIRED','BLOCKED')){throw 'connection-state'}
  if($Pending -and ($connection.enabled -or $connection.accessState -cne 'PENDING')){throw 'pending-required'}
}
function Get-Phase08SourceSafeCodes {
  # sync-contract.ts SAFE_SYNC_CODES, auth.errors.ts and fixed API/filter fallback enums only.
  return @('SOURCE_SELECTION_REQUIRED','ACCOUNT_SCOPE_MISMATCH','CURRENCY_MISMATCH','TIMEZONE_MISMATCH','FIELD_UNSUPPORTED','ATTRIBUTION_MISMATCH',
    'PARTIAL_PAGE','RECONCILIATION_FAILED','LEASE_LOST','RUN_LIMIT_EXCEEDED','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','PROVIDER_VERSION_UNVERIFIED',
    'AUTHENTICATION_REQUIRED','SESSION_INVALID','ACCESS_TOKEN_EXPIRED','SESSION_REVOKED','INVALID_CREDENTIALS','ACCOUNT_NOT_PROVISIONED','ACCOUNT_INACTIVE',
    'ACCOUNT_ONBOARDING_REQUIRED','PERMISSION_DENIED','AUTH_PROVIDER_UNAVAILABLE','REFRESH_RACE_RETRY','ORIGIN_NOT_ALLOWED','CSRF_INVALID','RATE_LIMITED',
    'VALIDATION_FAILED','PAYLOAD_TOO_LARGE','INTERNAL_SERVER_ERROR','HTTP_400','HTTP_401','HTTP_403','HTTP_404','HTTP_405','HTTP_409','HTTP_413','HTTP_415','HTTP_422','HTTP_429','HTTP_500','HTTP_502','HTTP_503','HTTP_504',
    'SOURCE_HTTP_FAILED','SOURCE_RESPONSE_REJECTED','SOURCE_NETWORK_FAILED','SOURCE_CONTROL_REJECTED')
}
function New-Phase08SourceHttpException($response) {
  $failure=[Exception]::new('PHASE08_SOURCE_REQUEST_FAILED')
  $failure.Data['Phase08SafeCode']='SOURCE_NETWORK_FAILED'
  if($null -ne $response) {
    $status=[int]$response.StatusCode
    if($status -ge 100 -and $status -le 599){$failure.Data['Phase08HttpStatus']=$status}
    $failure.Data['Phase08SafeCode']='SOURCE_HTTP_FAILED'
    if($response.Content -is [string] -and $response.Content.Length -le 16384) {
      try {
        $payload=$response.Content|ConvertFrom-Json -ErrorAction Stop
        if($payload.PSObject.Properties['code'] -and $payload.code -is [string] -and $payload.code -cin (Get-Phase08SourceSafeCodes)) {
          $failure.Data['Phase08SafeCode']=$payload.code
        }
      } catch { # Never retain body, message, details or request ID in exception data.
      }
    } elseif($response.Content.Length -gt 1048576){$failure.Data['Phase08SafeCode']='SOURCE_RESPONSE_REJECTED'}
  }
  return $failure
}
function Get-Phase08SourceFailureDiagnostic([Exception]$exception) {
  $code='SOURCE_CONTROL_REJECTED';$status=$null
  if($exception.Data.Contains('Phase08SafeCode') -and $exception.Data['Phase08SafeCode'] -is [string] -and $exception.Data['Phase08SafeCode'] -cin (Get-Phase08SourceSafeCodes)){$code=$exception.Data['Phase08SafeCode']}
  if($exception.Data.Contains('Phase08HttpStatus')) {
    $value=$exception.Data['Phase08HttpStatus']
    if(($value -is [int] -or $value -is [long]) -and $value -ge 100 -and $value -le 599){$status=[int]$value}
  }
  return @{code=$code;httpStatus=$status}
}
function Invoke-Phase08SourceRequest([string]$method,[string]$path,$body,$context,$session,$headers) {
  if($context.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app'){throw 'request-origin'}
  if($method -cnotin @('GET','POST') -or $path -cnotmatch '^/backend-api/(auth/login|cafe24/connections/0c35defe-45fc-4a54-bc79-704df7bca5b1/authorize|source-connections/0c35defe-45fc-4a54-bc79-704df7bca5b1/cafe24-scheduled-bootstrap|source-connections(?:\?limit=200&page=1|/[a-f0-9-]{36}/(?:bind-(google|meta)-auth|verify-(google|meta)))?)$'){throw 'request-route'}
  $request=@{Uri=($context.origin+$path);Method=$method;Headers=$headers;WebSession=$session;MaximumRedirection=0;TimeoutSec=90;SkipHttpErrorCheck=$true}
  if($method -ceq 'POST'){$request.ContentType='application/json';$request.Body=($body|ConvertTo-Json -Depth 5 -Compress)}
  try {$response=Invoke-WebRequest @request} catch {throw (New-Phase08SourceHttpException $null)}
  if([int]$response.StatusCode -notin @(200,201) -or $response.Content.Length -gt 1048576){throw (New-Phase08SourceHttpException $response)}
  return $response
}
function New-Phase08VerificationDto([string]$provider,[string]$day,[string]$from,[string]$observed,[string]$decision) {
  $parsed=[DateTime]::MinValue;$start=[DateTime]::MinValue
  if(-not [DateTime]::TryParseExact($day,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed) -or
    -not [DateTime]::TryParseExact($from,'yyyy-MM-dd',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$start) -or $start -gt $parsed -or
    $parsed -ge [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow,'Asia/Seoul').Date){throw 'verification-dates'}
  if($provider -ceq 'GOOGLE') {
    if($observed -cnotmatch '^(0|[1-9]\d{0,14})$' -or ($parsed-$start).TotalDays -ge 30){throw 'google-verification'}
    return @{verificationDay=$day;fromDate=$from;observedAccountCostKrw=$observed}
  }
  if($provider -cne 'META' -or $observed -cnotmatch '^(0|[1-9]\d{0,9})(\.\d{1,4})?$' -or $decision -cnotin @('REQUIRE_VERIFIED_CONDITIONALS','ALLOW_UNAVAILABLE_WITH_REASONS')){throw 'meta-verification'}
  return @{verificationDay=$day;fromDate=$from;observedAccountSpendUsd=$observed;conditionalReviewDecision=$decision}
}
function New-Phase08MetaPendingSql($context,$operator) {
  Assert-Phase08SourceContext $context $operator
  $metaId=$context.ids.metaConnectionId
  if($metaId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or $operator.authId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
    $operator.email -cne ('phase08-eval-'+$operator.authId+'@example.invalid')){throw 'seed-identity'}
  # Exact project fingerprint must be independently checked by root's fixed Management API.
  # This exception preserves the already encrypted Meta AAD UUID; activation still uses normal HTTP.
  return @"
-- PHASE08 ONLY: ehnfrrmbkvlsbpvqcvkr; root must verify the project fingerprint before execution.
BEGIN;
DO `$`$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR
  (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')<>68 OR
  (SELECT count(*) FROM phase08_meta_ads.app_users)<>1 OR
  NOT EXISTS(SELECT 1 FROM phase08_meta_ads.app_users a JOIN auth.users u ON u.id=a.auth_user_id
    WHERE a.id='$($operator.appId)'::uuid AND a.auth_user_id='$($operator.authId)'::uuid
      AND a.email='$($operator.email)' AND a.role='SUPER_ADMIN' AND a.is_active AND a.invite_status='ACTIVE'
      AND u.email=a.email AND u.role='authenticated' AND u.email_confirmed_at IS NOT NULL
      AND u.raw_app_meta_data->>'phase08_evaluation_id'='$($operator.authId)') OR
  EXISTS(SELECT 1 FROM phase08_meta_ads.source_connections WHERE id='$metaId'::uuid OR provider='META')
 THEN RAISE EXCEPTION 'PHASE08_FRESH_META_PENDING_REQUIRED'; END IF;
END `$`$;
INSERT INTO phase08_meta_ads.source_connections(id,provider,external_account_id,shop_key,display_name,currency_code,time_zone,credential_ref,credential_expires_at,access_state,enabled,updated_at)
 VALUES('$metaId'::uuid,'META','2138525300002203','default','Phase08 isolated Meta','USD','Asia/Seoul',NULL,NULL,'PENDING',false,now());
INSERT INTO phase08_meta_ads.security_audit_events(id,actor_type,actor_user_id,action,target_type,target_id,result,after_json)
 VALUES(gen_random_uuid(),'USER','$($operator.appId)'::uuid,'SOURCE_CONNECTION_CREATED','SOURCE_CONNECTION','$metaId','SUCCESS',
 '{"provider":"META","externalAccountId":"2138525300002203","shopKey":"default","enabled":false,"purpose":"PHASE08_AAD_UUID_PENDING_SEED"}'::jsonb);
COMMIT;
"@
}
