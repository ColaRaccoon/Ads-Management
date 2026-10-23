param(
  [ValidateSet('Precheck','Setup','Seed','Publish','Inspect','Activate','Failure','Rotate','Revoke','Recover','StatusEvidence','RepairConfigurationDates','OptionCapacityPrecheck','ExpandOptionCapacity')]
  [string]$Mode = 'Precheck',
  [string]$CsvPath,
  [string]$ExpectedSnapshotDigest,
  [string]$ExpectedSchemaDigest,
  [string]$ExpectedConfigurationDigest,
  [string]$ExpectedInputDifferencesJson,
  [string]$RegisteredRedirectVerifiedAt,
  [string]$SingleInstanceVerifiedAt,
  [string]$ApprovedStatusCodesJson,
  [string]$ProjectionVerifiedAt,
  [switch]$AcknowledgeSetup,
  [switch]$AcknowledgeOptionCapacity,
  [switch]$AcknowledgeSourceChoice,
  [switch]$AcknowledgeTokenRotation,
  [switch]$AcknowledgeTokenRevocation,
  [switch]$AcknowledgeEnableRecovery,
  [switch]$AcknowledgeV1Projection,
  [switch]$AcknowledgeConfigurationDateRepair,
  [switch]$PassThru,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$origin = 'https://cafe24-callback-test-production.up.railway.app'
$day = '2026-10-01'
$failureCode = 'LIVE_LOCAL_INPUT_INVALID'
$activationGuards=@('CAFE24_ACTIVATION_SNAPSHOT_CHANGED','CAFE24_ACTIVATION_POLICY_STATE','CAFE24_ACTIVATION_COVERAGE_STATE','CAFE24_ACTIVATION_RUN_STATE','CAFE24_ACTIVATION_UNDATED_CSV_UNREVIEWED','CAFE24_ACTIVATION_ROW_CARDINALITY','CAFE24_ACTIVATION_API_MAPPING_STATE','CAFE24_ACTIVATION_CSV_MAPPING_STATE','CAFE24_ACTIVATION_CSV_RAW_INPUT','CAFE24_ACTIVATION_CSV_PRODUCT_NAME','CAFE24_ACTIVATION_CSV_QUANTITY','CAFE24_ACTIVATION_CSV_SALE_PRICE','CAFE24_ACTIVATION_CSV_LINK','CAFE24_ACTIVATION_API_VERSION_LINK','CAFE24_ACTIVATION_INPUT_DIFFERENCE_REVIEW')
$providerFailureDiagnosticCodes = @('CAFE24_EVIDENCE_APP_VERSION','CAFE24_EVIDENCE_SELLER_OPTIONS','CAFE24_EVIDENCE_RAW_ALL_ITEMS','CAFE24_EVIDENCE_STATUS_SET','CAFE24_EVIDENCE_PAYMENT_MAP','CAFE24_STATUS_APPROVAL_MISMATCH','CAFE24_PROVIDER_TIME_FUTURE','CAFE24_FIELD_ORDER_SHAPE','CAFE24_FIELD_ORDER_ID','CAFE24_FIELD_ORDER_DATE','CAFE24_FIELD_UPDATED_DATE','CAFE24_FIELD_ORDER_STATUS','CAFE24_FIELD_TOP_ORDER_PRICE','CAFE24_FIELD_PAYMENT_AMOUNT','CAFE24_FIELD_ACTUAL_AMOUNT','CAFE24_FIELD_INITIAL_AMOUNT','CAFE24_FIELD_PAYMENT_METHOD','CAFE24_FIELD_ITEM_SHAPE','CAFE24_FIELD_ITEM_ID','CAFE24_FIELD_PRODUCT_NO','CAFE24_FIELD_PRODUCT_NAME','CAFE24_FIELD_OPTION_VALUE','CAFE24_FIELD_OPTION_COMPOSITION','CAFE24_FIELD_QUANTITY','CAFE24_FIELD_PRODUCT_PRICE','CAFE24_FIELD_ITEM_STATUS','CAFE24_FIELD_PROJECTION')

function Read-AllowlistedCsv([string]$path) {
  if (-not [IO.File]::Exists($path)) { throw 'CSV_MISSING' }
  $expectedHash = '97DE5128EBA52B4C3CBE77EC43EF85F3363A1E6BEB4629D7D22ABA628092F36D'
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $expectedHash) { throw 'CSV_FINGERPRINT_CHANGED' }
  $columns = @('주문번호','품목별 주문번호','상품번호','주문상품명','주문상품명(옵션포함)',
    '수량','판매가','총 주문금액','총 결제금액','결제수단','발주일')
  $parser = [Microsoft.VisualBasic.FileIO.TextFieldParser]::new($path,[Text.Encoding]::UTF8)
  $parser.SetDelimiters(',')
  $parser.HasFieldsEnclosedInQuotes = $true
  $parser.TrimWhiteSpace = $false
  $rows = [Collections.Generic.List[object]]::new()
  try {
    $header = $parser.ReadFields()
    $indexes = [Collections.Generic.List[int]]::new()
    foreach ($column in $columns) {
      $found = @(0..($header.Length-1) | Where-Object { $header[$_] -ceq $column })
      if ($found.Count -ne 1) { throw 'CSV_HEADER_INVALID' }
      $indexes.Add($found[0])
    }
    while (-not $parser.EndOfData) {
      $raw = $parser.ReadFields()
      if ($raw.Length -ne $header.Length -or $rows.Count -ge 477) { throw 'CSV_ROW_SHAPE_INVALID' }
      $safe = [string[]]::new(11)
      for ($index=0; $index -lt 11; $index++) { $safe[$index] = $raw[$indexes[$index]] }
      if ($safe[10] -ne '' -and $safe[10] -cnotmatch '^2026-10-01(?: [0-9]{2}:[0-9]{2}:[0-9]{2})?$') {
        throw 'CSV_ORDER_DAY_INVALID'
      }
      $rows.Add($safe)
      [Array]::Clear($raw,0,$raw.Length)
    }
    if ($rows.Count -ne 477) { throw 'CSV_ROW_COUNT_CHANGED' }
    return ,$rows.ToArray()
  } finally { $parser.Dispose() }
}

function Read-CurrentBusinessConfiguration {
  $scriptPath = Join-Path $env:LOCALAPPDATA 'MetaAdsCafe24Phase06Harness/phase06-read-business-config.cjs'
  if (-not [IO.File]::Exists($scriptPath)) { throw 'CONFIGURATION_EXPORT_HELPER_MISSING' }
  # Capture stdout in memory. Never print the export or a provider error.
  $railwayPath=Join-Path $env:LOCALAPPDATA 'npm-cache/_npx/79fa66f96c8fdacf/node_modules/@railway/cli/bin/railway.exe'
  if (-not [IO.File]::Exists($railwayPath)) { throw 'RAILWAY_READONLY_CLI_MISSING' }
  $variablesRaw = & $railwayPath variable list -p '6fe72710-1fc8-445a-a77f-da2da8fee200' -e '01ab3d5a-1036-45b0-aa9c-47179339c9be' -s 'b0835b08-7799-4c1c-8bcd-90746b9d4248' --json 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'CONFIGURATION_VARIABLE_READ_FAILED' }
  try {
    $variables=($variablesRaw -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable
    $configurationTarget=[ordered]@{
      databaseUrl=$variables.DATABASE_URL; projectRef=$variables.SUPABASE_DATABASE_PROJECT_REF
      host=$variables.SUPABASE_DATABASE_HOST; runtimeUser=$variables.SUPABASE_DATABASE_RUNTIME_USER
      databaseName=$variables.SUPABASE_DATABASE_NAME; schema=$variables.SUPABASE_DATABASE_SCHEMA
    }
    if (@($configurationTarget.Values | Where-Object { $_ -isnot [string] -or -not $_ }).Count -gt 0) {
      throw 'CONFIGURATION_TARGET_INVALID'
    }
    $raw = ($configurationTarget | ConvertTo-Json -Compress) | & node $scriptPath --export 2>$null
  } finally { $variablesRaw=$null; $variables=$null; $configurationTarget=$null }
  if ($LASTEXITCODE -ne 0 -or @($raw).Count -ne 1) { throw 'CONFIGURATION_EXPORT_FAILED' }
  try {
    $export = $raw | ConvertFrom-Json -AsHashtable -DateKind String
    if (-not $export.ContainsKey('observedAt') -or -not $export.ContainsKey('fingerprint') -or
        -not $export.ContainsKey('configuration')) { throw 'CONFIGURATION_EXPORT_SHAPE_INVALID' }
    $configuration = [ordered]@{ observedAt=$export.observedAt; hash=$export.fingerprint }
    foreach ($field in @('products','costRules','productRules','couponRules')) {
      $configuration[$field]=$export.configuration[$field]
    }
    return $configuration
  } finally { $raw=$null; $export=$null }
}

function New-CanonicalRequest {
  $request = [ordered]@{ mode=$Mode.ToLowerInvariant(); day=$day }
  if ($ApprovedStatusCodesJson -or $ProjectionVerifiedAt -or $AcknowledgeV1Projection) {
    if (-not $ApprovedStatusCodesJson -or -not $ProjectionVerifiedAt -or -not $AcknowledgeV1Projection) { throw 'V1_PROJECTION_REVIEW_REQUIRED' }
    $request.approvedStatusCodes=ConvertFrom-Json -InputObject $ApprovedStatusCodesJson -NoEnumerate
    if($request.approvedStatusCodes -isnot [Array] -or $request.approvedStatusCodes.Count -lt 1 -or
      $request.approvedStatusCodes.Count -gt 32 -or @($request.approvedStatusCodes|Where-Object {$_ -isnot [string] -or $_ -cnotmatch '^(?:[NCR][0-9]{2}|E00)$'}).Count) {throw 'V1_PROJECTION_REVIEW_REQUIRED'}
    $request.projectionAcknowledgement='INCLUDE_ALL_REVIEWED_V1_ITEMS_FOR_06_DAY'
    $request.projectionVerifiedAt=$ProjectionVerifiedAt
  }
  switch ($Mode) {
    'RepairConfigurationDates' {
      if(-not $AcknowledgeConfigurationDateRepair -or $ExpectedConfigurationDigest -cnotmatch '^[a-f0-9]{64}$') {throw 'CONFIGURATION_DATE_REPAIR_ACK_REQUIRED'}
      $request.mode='repair-configuration-dates'
      $request.configuration=Read-CurrentBusinessConfiguration
      $request.acknowledgement='CORRECT_CONFIRMED_06_CONFIGURATION_DATE_EXPORT_ONLY'
      $request.expectedConfigurationDigest=$ExpectedConfigurationDigest
    }
    'Seed' { $request.csvRows=Read-AllowlistedCsv $CsvPath
      $request.configuration=Read-CurrentBusinessConfiguration }
    'Activate' {
      if (-not $AcknowledgeSourceChoice -or $ExpectedSnapshotDigest -cnotmatch '^[a-f0-9]{64}$' -or
          -not $ExpectedInputDifferencesJson) { throw 'REVIEWED_ACTIVATION_EVIDENCE_REQUIRED' }
      $request.acknowledgement='CHOOSE_RECORDED_API_INPUTS_FOR_REVIEWED_06_DAY'
      $request.couponInputSource='API_ACTUAL_PRODUCT_PLUS_SHIPPING'
      $request.expectedSnapshotDigest=$ExpectedSnapshotDigest
      $request.expectedInputDifferences=$ExpectedInputDifferencesJson | ConvertFrom-Json -AsHashtable
    }
    'Rotate' { if (-not $AcknowledgeTokenRotation) { throw 'TOKEN_ROTATION_ACK_REQUIRED' }
      $request.acknowledgement='ROTATE_EXISTING_ISOLATED_06_TOKEN_PAIR' }
    'Revoke' { if (-not $AcknowledgeTokenRevocation -or -not $RegisteredRedirectVerifiedAt) { throw 'TOKEN_REVOCATION_ACK_REQUIRED' }
      $request.acknowledgement='REVOKE_EXISTING_ISOLATED_06_TOKEN_PAIR_AND_RECONNECT'
      $request.registeredRedirectVerifiedAt=$RegisteredRedirectVerifiedAt }
  }
  return $request
}

function Post-Action([Net.Http.HttpClient]$client,[string]$operator,[string]$path,[Collections.IDictionary]$fields) {
  $form=[Collections.Generic.Dictionary[string,string]]::new()
  $form.Add('operator',$operator)
  foreach ($field in $fields.Keys) { $form.Add([string]$field,[string]$fields[$field]) }
  $body=[Net.Http.FormUrlEncodedContent]::new($form)
  try {
    $response=$client.PostAsync("$origin/$path",$body).GetAwaiter().GetResult()
    try {
      $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 32768) { throw 'LIVE_REMOTE_RESPONSE_LIMIT' }
      if ([int]$response.StatusCode -notin @(200,202)) {
        $safeFailure=[ordered]@{failure='LIVE_REMOTE_ACTION_FAILED';httpStatus=[int]$response.StatusCode;code=$null}
        try {
          $errorBody=$text | ConvertFrom-Json -AsHashtable -DateKind String
          $codes=@('SOURCE_SELECTION_REQUIRED','ACCOUNT_SCOPE_MISMATCH','CURRENCY_MISMATCH','TIMEZONE_MISMATCH',
            'FIELD_UNSUPPORTED','ATTRIBUTION_MISMATCH','PARTIAL_PAGE','RECONCILIATION_FAILED','LEASE_LOST',
            'RUN_LIMIT_EXCEEDED','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','PROVIDER_VERSION_UNVERIFIED')
          if ($errorBody -is [Collections.IDictionary] -and $errorBody.code -is [string] -and $errorBody.code -cin $codes) {
            $safeFailure.code=$errorBody.code
            if ($errorBody.Contains('diagnostic')) {
              $safeFailure.diagnostic=Read-SafeSetupFailureDiagnostic $errorBody.diagnostic
              if($safeFailure.diagnostic.guard -cin $activationGuards -and $safeFailure.code -cne 'SOURCE_SELECTION_REQUIRED'){throw 'LIVE_FAILURE_DIAGNOSTIC_INVALID'}
            }
            if($errorBody.Contains('mappingReviewEvidence')) { $safeFailure.mappingReviewEvidence=Read-SafeMappingReviewEvidence $errorBody.mappingReviewEvidence }
            if($errorBody.Contains('processEvidence')) { $safeFailure.processEvidence=Read-SafeProcessEvidence $errorBody.processEvidence }
          }
        } catch { $safeFailure=[ordered]@{failure='LIVE_REMOTE_ACTION_FAILED';httpStatus=[int]$response.StatusCode;code=$null} }
        $safeException=[Exception]::new('LIVE_REMOTE_ACTION_FAILED')
        $safeException.Data['safeRemoteFailure']=$safeFailure
        throw $safeException
      }
      try { $parsed=$text | ConvertFrom-Json -AsHashtable -DateKind String }
      catch { throw [Exception]::new('LIVE_REMOTE_JSON_INVALID') }
      if ($parsed -isnot [Collections.IDictionary]) { throw [Exception]::new('LIVE_REMOTE_JSON_INVALID') }
      return @{ status=[int]$response.StatusCode; result=$parsed }
    } finally { $response.Dispose() }
  } finally { $body.Dispose(); $form.Clear() }
}
function Read-SafeSetupFailureDiagnostic($value) {
  $categories=@('SETUP_BASELINE','SETUP_LOCKED_BASELINE','SETUP_DDL','SETUP_POSTCHECK','SETUP_PRESERVATION','SETUP_TRANSACTION',
    'CHILD_INPUT','CHILD_DATABASE','CHILD_SEED_CONFIGURATION','CHILD_SEED_POLICY','CHILD_SEED_CSV',
    'CHILD_PUBLISH','CHILD_ACTIVATE','CHILD_AUTH','CHILD_RESULT_READ','CHILD_RESULT_CALCULATION',
    'CHILD_PROCESS','PARENT_INPUT','PARENT_CONNECTION','PARENT_ENABLE','PARENT_RESTORE','PARENT_OPTION_CAPACITY')
  $states=@('42601','42710','42P07','42701','42703','42P01','42804','42883','23503','23514','23505','55P03','57014','25P02','40001','40P01')
  $guards=@($activationGuards)+@('ISOLATED_REVIEWED_INPUT_EVIDENCE_REQUIRED','ISOLATED_REVIEWED_INPUT_EVIDENCE_CHANGED','ISOLATED_OPTION_CAPACITY_SHAPE_MISMATCH','ISOLATED_OPTION_CAPACITY_INVENTORY_MISMATCH','ISOLATED_OPTION_CAPACITY_SCOPE_MISMATCH','ISOLATED_OPTION_CAPACITY_ACK_REQUIRED','ISOLATED_OPTION_CAPACITY_SCHEMA_CHANGED','ISOLATED_OPTION_CAPACITY_PRESERVATION_FAILED','ISOLATED_ADDED_TABLE_INVENTORY_MISMATCH','ISOLATED_ADDED_TABLE_RLS_MISMATCH',
    'ISOLATED_ADDED_CHECK_MISMATCH','ISOLATED_ADDED_CURRENT_INDEX_MISMATCH','ISOLATED_ADDED_FOREIGN_KEY_MISMATCH',
    'ISOLATED_ADDED_POLICY_TRIGGER_MISMATCH','ISOLATED_EXISTING_AUDIT_ACTOR_CHECK_MISMATCH',
    'ISOLATED_AUDIT_ACTOR_FOREIGN_KEY_MISMATCH','ISOLATED_EXISTING_STATE_CHANGED','ISOLATED_EXISTING_STATE_NOT_PRESERVED',
    'CONFIGURATION_REQUIRED','CONFIGURATION_INVALID','CONFIGURATION_INVENTORY_MISMATCH','CONFIGURATION_FINGERPRINT_MISMATCH',
    'CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED','CANONICAL_CSV_INPUT_INVALID','CANONICAL_CSV_SCOPE_MISMATCH',
    'ISOLATED_CSV_API_IDENTITY_MISMATCH','ISOLATED_CONNECTION_MISMATCH','ISOLATED_CREDENTIAL_OWNER_MISMATCH',
    'ISOLATED_SCHEMA_INVENTORY_MISMATCH','ISOLATED_SUCCESS_REQUIRED','ISOLATED_SUCCESS_NOT_PRESERVED',
    'CONFIGURATION_DATE_REPAIR_ACK_REQUIRED','CONFIGURATION_DATE_REPAIR_SOURCE_INVALID','CONFIGURATION_DATE_REPAIR_TARGET_INVALID',
    'CONFIGURATION_DATE_REPAIR_STATE_CHANGED','CONFIGURATION_DATE_REPAIR_LEGACY_MISMATCH','CONFIGURATION_DATE_REPAIR_NONDATE_CHANGED',
    'CONFIGURATION_DATE_REPAIR_PRESERVATION_FAILED','CONFIGURATION_DATE_REPAIR_EXPECTED_COUNTS_MISMATCH','CONFIGURATION_DATE_REPAIR_POSTCHECK_FAILED',
    'CONFIGURATION_MAPPING_REVIEW_SCOPE_INVALID','CONFIGURATION_MAPPING_UNDATED_CHANGE_REVIEW_REQUIRED','CONFIGURATION_MAPPING_REVIEW_PRESERVATION_FAILED',
    'CONFIGURATION_MAPPING_REVIEW_METADATA_CHANGED','CONFIGURATION_MAPPING_REVIEW_METADATA_INVALID',
    'ISOLATED_REVIEWED_PROJECTION_REQUIRED','ISOLATED_CHILD_INPUT_INVALID','ISOLATED_CHILD_INPUT_LIMIT',
    'ISOLATED_CHILD_CONNECTION_NOT_READY','ISOLATED_CHILD_CONNECTION_CHANGED','ISOLATED_CHILD_CONNECTION_MISSING','ISOLATED_CHILD_DISABLE_NOT_CONFIRMED',
    'CHILD_TIMEOUT','CHILD_SPAWN_FAILED','CHILD_STDIN_FAILED','CHILD_OUTPUT_LIMIT','CHILD_OUTPUT_EMPTY','CHILD_OUTPUT_INVALID_JSON','CHILD_OUTPUT_INVALID_FAILURE','CHILD_OUTPUT_INVALID_RESULT')
  if ($value -isnot [Collections.IDictionary] -or $value.Count -ne 4 -or
      @($value.Keys | Where-Object { $_ -cnotin @('category','sqlState','guard','statementIndex') }).Count -or
      $value.category -cnotin $categories -or ($null -ne $value.sqlState -and $value.sqlState -cnotin $states) -or
      ($null -ne $value.guard -and $value.guard -cnotin $guards) -or
      ($null -ne $value.statementIndex -and ($value.statementIndex -isnot [int] -and $value.statementIndex -isnot [long] -or
       $value.statementIndex -lt 0 -or $value.statementIndex -gt 1000))) { throw 'LIVE_FAILURE_DIAGNOSTIC_INVALID' }
  if($value.guard -cin $activationGuards -and $value.category -cne 'CHILD_ACTIVATE'){throw 'LIVE_FAILURE_DIAGNOSTIC_INVALID'}
  return [ordered]@{category=$value.category;sqlState=$value.sqlState;guard=$value.guard;statementIndex=$value.statementIndex}
}
function Read-SafeMappingReviewEvidence($value) {
  if($value -isnot [Collections.IDictionary] -or $value.Count -ne 3 -or
    @($value.Keys|Where-Object {$_ -cnotin @('csvMappingChangedLineCount','csvMappingStateDigest','configurationStateDigest')}).Count -or
    ($null -ne $value.csvMappingChangedLineCount -and ($value.csvMappingChangedLineCount -isnot [int] -and $value.csvMappingChangedLineCount -isnot [long] -or $value.csvMappingChangedLineCount -lt 10 -or $value.csvMappingChangedLineCount -gt 477 -or
      ((477-$value.csvMappingChangedLineCount) -gt 0 -and (477-$value.csvMappingChangedLineCount) -lt 10))) -or
    $value.csvMappingStateDigest -isnot [string] -or $value.csvMappingStateDigest -cnotmatch '^[a-f0-9]{64}$' -or
    $value.configurationStateDigest -isnot [string] -or $value.configurationStateDigest -cnotmatch '^[a-f0-9]{64}$') {throw 'LIVE_MAPPING_EVIDENCE_INVALID'}
  return [ordered]@{csvMappingChangedLineCount=$value.csvMappingChangedLineCount;csvMappingStateDigest=$value.csvMappingStateDigest;configurationStateDigest=$value.configurationStateDigest}
}
function Read-SafeProcessEvidence($value) {
  if($value -isnot [Collections.IDictionary] -or $value.Count -ne 2 -or
    @($value.Keys|Where-Object {$_ -cnotin @('exitCode','signal')}).Count -or
    ($null -ne $value.exitCode -and ($value.exitCode -isnot [int] -and $value.exitCode -isnot [long] -or $value.exitCode -lt 0 -or $value.exitCode -gt 255)) -or
    ($null -ne $value.signal -and $value.signal -cnotin @('SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGBUS','SIGINT','SIGHUP'))) {throw 'LIVE_PROCESS_EVIDENCE_INVALID'}
  return [ordered]@{exitCode=$value.exitCode;signal=$value.signal}
}

function Assert-SafeRemoteResult([Collections.IDictionary]$value) {
  if($value.Contains('optionCapacitySchemaDigest')) {
    $shape=(@($value.Keys)|Sort-Object)-join ','
    if($shape -ceq 'currentOptionNameCapacity,optionCapacitySchemaDigest,optionCapacityTransitionReady') {
      if($value.currentOptionNameCapacity -isnot [int] -and $value.currentOptionNameCapacity -isnot [long] -or $value.currentOptionNameCapacity -ne 256 -or $value.optionCapacityTransitionReady -isnot [bool] -or $value.optionCapacityTransitionReady -ne $true){throw 'LIVE_OPTION_CAPACITY_RESPONSE_INVALID'}
    }elseif($shape -ceq 'credentialAndCsvPreserved,currentOptionNameCapacity,existingRowsPreserved,optionCapacityExpanded,optionCapacitySchemaDigest,previousOptionNameCapacity') {
      if($value.currentOptionNameCapacity -isnot [int] -and $value.currentOptionNameCapacity -isnot [long] -or $value.previousOptionNameCapacity -isnot [int] -and $value.previousOptionNameCapacity -isnot [long] -or $value.currentOptionNameCapacity -ne 514 -or $value.previousOptionNameCapacity -ne 256){throw 'LIVE_OPTION_CAPACITY_RESPONSE_INVALID'}
      foreach($flag in @('optionCapacityExpanded','existingRowsPreserved','credentialAndCsvPreserved')){if($value[$flag] -isnot [bool] -or $value[$flag] -ne $true){throw 'LIVE_OPTION_CAPACITY_RESPONSE_INVALID'}}
    }else{throw 'LIVE_OPTION_CAPACITY_RESPONSE_INVALID'}
  }

  $allowed=@('databaseIdentityVerified','existingTableCount','existingRowCounts','columnShapeVerified',
    'enumShapeVerified','uniqueIndexShapeVerified','auditActorCheckVerified','credentialOwnerSingle',
    'credentialRevisions','connectionEnabled','additiveTableCount','existingSixPreserved',
    'existingAuditActorCheckExtended','existingAuditActorForeignKeyAdded','tokenCopied',
    'fullApplicationMigrationsApplied','mode','day','runStatus','failurePreserved',
    'configurationObservedAt','configurationFingerprint','configurationCounts','configurationStateDigest',
    'configurationDateRepairApplied','repairedDateFieldCount','repairedTimestampFieldCount','configurationRepairDataPreserved',
    'csvMappingReviewedLineCount','csvMappingChangedLineCount','csvMappingEquivalent','csvOriginalContentPreserved','csvUndatedMappingPreserved','csvRematchPerformed','currentApiLines',
    'apiVersionRows','currentApiVersions','currentApiLinks','nullProviderUpdatedLines','csvUndatedLines',
    'visibleCsvLines','visibleApiLines','coverageState','inputDifferences','activationSnapshotDigest',
    'lastSuccessPreserved','primarySource','providerCacheFreshnessVerified','providerModificationTimeInvented','allProviderOrderStatusesAbsent',
    'authenticationEvidence','calculationEvidence','syncExecutionEvidence','connectionAccessState','providerFailureDiagnosticCode','recoveryApplied','credentialAndAccessStatePreserved',
    'lastSuccessAndCurrentPreserved','readonlyNoop','checkedInSchemaDigest','optionCapacitySchemaDigest','currentOptionNameCapacity','previousOptionNameCapacity','optionCapacityTransitionReady','optionCapacityExpanded','existingRowsPreserved','credentialAndCsvPreserved')
  if (@($value.Keys | Where-Object { $_ -notin $allowed }).Count -gt 0) { throw 'LIVE_RESPONSE_FIELDS_INVALID' }
  $nestedKeys=@{
    existingRowCounts=@('cafe24_oauth_attempts','cafe24_observed_day_checkpoints','cafe24_observed_order_revisions',
      'security_audit_events','source_connections','source_credentials')
    configurationCounts=@('products','costRules','productRules','couponRules')
    inputDifferences=@('totalOrderOrders','paidOrders','paymentMethodOrders','couponSignalOrders','productNameOrders')
    authenticationEvidence=@('tokenPairRotated','priorRevisions','currentRevisions','tokenCopied',
      'providerRevocationSucceeded','realReadAuthenticationFailure','reauthRequired',
      'lastSuccessAndCurrentPreserved','oldPairRestored')
  }
  $strings=@('mode','day','runStatus','configurationObservedAt','configurationFingerprint','coverageState',
    'primarySource','activationSnapshotDigest','checkedInSchemaDigest','configurationStateDigest','connectionAccessState','providerFailureDiagnosticCode','optionCapacitySchemaDigest')
  foreach ($field in $value.Keys) {
    $cell=$value[$field]
    if($field -eq 'allProviderOrderStatusesAbsent') {if($null -ne $cell -and $cell -isnot [bool]){throw 'LIVE_RESPONSE_TYPE_INVALID'}} elseif ($field -in @('currentOptionNameCapacity','previousOptionNameCapacity')) { if($cell -isnot [int] -and $cell -isnot [long] -or $cell -notin @(256,514)){throw 'LIVE_RESPONSE_TYPE_INVALID'} } elseif ($field -in $strings) {
      if ($null -eq $cell) { continue }
      if ($cell -isnot [string]) { throw 'LIVE_RESPONSE_TYPE_INVALID' }
      switch ($field) {
        'mode' { if ($cell -cnotmatch '^(seed|publish|failure|inspect|activate|rotate|revoke|repair-configuration-dates)$') { throw 'LIVE_RESPONSE_TYPE_INVALID' } }
        'day' { if ($cell -cne $day) { throw 'LIVE_RESPONSE_TYPE_INVALID' } }
        'configurationObservedAt' { $date=[DateTimeOffset]::MinValue; if (-not [DateTimeOffset]::TryParse($cell,[ref]$date)) { throw 'LIVE_RESPONSE_TYPE_INVALID' } }
        'providerFailureDiagnosticCode' {if($cell -cnotin $providerFailureDiagnosticCodes){throw 'LIVE_RESPONSE_TYPE_INVALID'}}
        'connectionAccessState' {if($cell -cnotin @('PENDING','READY','REAUTH_REQUIRED','BLOCKED')){throw 'LIVE_RESPONSE_TYPE_INVALID'}}
        { $_ -in @('configurationFingerprint','activationSnapshotDigest','checkedInSchemaDigest','configurationStateDigest','optionCapacitySchemaDigest') } { if ($cell -cnotmatch '^[a-f0-9]{64}$') { throw 'LIVE_RESPONSE_TYPE_INVALID' } }
        default { if ($cell -cnotmatch '^[A-Z_]{1,64}$') { throw 'LIVE_RESPONSE_TYPE_INVALID' } }
      }
    } elseif ($field -eq 'credentialRevisions') {
      if ($cell -isnot [Array] -or $cell.Count -ne 2 -or @($cell | Where-Object { $_ -isnot [int] -and $_ -isnot [long] -or $_ -lt 1 }).Count) { throw 'LIVE_RESPONSE_TYPE_INVALID' }
    } elseif ($field -notin @($nestedKeys.Keys) -and $field -notin @('calculationEvidence','syncExecutionEvidence') -and $null -ne $cell -and
        $cell -isnot [bool] -and $cell -isnot [int] -and $cell -isnot [long]) { throw 'LIVE_RESPONSE_TYPE_INVALID' }
  }
  if($value.Contains('syncExecutionEvidence')) {
    $evidence=$value.syncExecutionEvidence
    $codes=@('SOURCE_SELECTION_REQUIRED','ACCOUNT_SCOPE_MISMATCH','CURRENCY_MISMATCH','TIMEZONE_MISMATCH','FIELD_UNSUPPORTED','ATTRIBUTION_MISMATCH',
      'PARTIAL_PAGE','RECONCILIATION_FAILED','LEASE_LOST','RUN_LIMIT_EXCEEDED','PROVIDER_AUTH_REQUIRED','PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE','PROVIDER_VERSION_UNVERIFIED')
    if($evidence -isnot [Collections.IDictionary] -or $evidence.Count -ne 10 -or
      @($evidence.Keys|Where-Object {$_ -cnotin @('runPresent','runCount','runStatuses','selection','lastRunStatus','lastSafeCode','unitStatuses','unitCount','leasePresent','leaseActive')}).Count -or
      $evidence.runPresent -isnot [bool] -or $evidence.leasePresent -isnot [bool] -or $evidence.leaseActive -isnot [bool] -or
      ($evidence.leaseActive -and -not $evidence.leasePresent) -or $evidence.unitCount -isnot [int] -and $evidence.unitCount -isnot [long] -or
      $evidence.runCount -isnot [int] -and $evidence.runCount -isnot [long] -or $evidence.runCount -lt 0 -or $evidence.runCount -gt 100000 -or
      $evidence.runStatuses -isnot [Array] -or $evidence.runStatuses.Count -gt 7 -or
      @($evidence.runStatuses|Where-Object {$_ -cnotin @('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','ACTION_REQUIRED','CANCELLED')}).Count -or
      @($evidence.runStatuses|Select-Object -Unique).Count -ne $evidence.runStatuses.Count -or
      $evidence.selection -cnotin @('NONE','ONLY_DAY_RUN','LATEST_STARTED_RUN','AMBIGUOUS_RUN_ORDER') -or
      $evidence.unitCount -lt 0 -or $evidence.unitCount -gt 32 -or $evidence.unitStatuses -isnot [Array] -or $evidence.unitStatuses.Count -gt 5 -or
      @($evidence.unitStatuses|Where-Object {$_ -cnotin @('QUEUED','RUNNING','SUCCEEDED','FAILED','ACTION_REQUIRED')}).Count -or
      @($evidence.unitStatuses|Select-Object -Unique).Count -ne $evidence.unitStatuses.Count -or
      ($null -ne $evidence.lastRunStatus -and $evidence.lastRunStatus -cnotin @('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','ACTION_REQUIRED','CANCELLED')) -or
      ($null -ne $evidence.lastSafeCode -and $evidence.lastSafeCode -cnotin $codes) -or
      (-not $evidence.runPresent -and ($evidence.runCount -ne 0 -or $evidence.runStatuses.Count -ne 0 -or $evidence.selection -cne 'NONE' -or $null -ne $evidence.lastRunStatus -or $null -ne $evidence.lastSafeCode -or $evidence.unitCount -ne 0 -or $evidence.unitStatuses.Count -ne 0)) -or
      ($evidence.runPresent -and ($evidence.runCount -lt 1 -or $evidence.runStatuses.Count -lt 1 -or $evidence.selection -ceq 'NONE')) -or
      ($evidence.selection -ceq 'AMBIGUOUS_RUN_ORDER' -and ($null -ne $evidence.lastRunStatus -or $null -ne $evidence.lastSafeCode -or $evidence.unitCount -ne 0 -or $evidence.unitStatuses.Count -ne 0))) {throw 'LIVE_EXECUTION_EVIDENCE_INVALID'}
  }
  # Fixed nested keys reject provider payloads even under an allowed parent.
  foreach ($field in @('existingRowCounts','configurationCounts','inputDifferences','authenticationEvidence')) {
    if (-not $value.Contains($field) -or $null -eq $value[$field]) { continue }
    $nested=$value[$field]
    if ($nested -isnot [Collections.IDictionary]) { throw 'LIVE_RESPONSE_NESTED_INVALID' }
    if (@($nested.Keys | Where-Object { $_ -notin $nestedKeys[$field] }).Count -gt 0 -or
        ($field -ne 'authenticationEvidence' -and $nested.Count -ne $nestedKeys[$field].Count)) { throw 'LIVE_RESPONSE_NESTED_INVALID' }
    if($field -eq 'inputDifferences') {
      foreach($countField in @('couponSignalOrders','paidOrders','paymentMethodOrders','productNameOrders','totalOrderOrders')) {
        $count=$nested[$countField]
        if($null -eq $count -and $countField -notin @('couponSignalOrders','productNameOrders')){throw 'LIVE_RESPONSE_NESTED_INVALID'}
        if($null -ne $count -and ($count -isnot [int] -and $count -isnot [long] -or $count -lt 0 -or $count -gt 422)){throw 'LIVE_RESPONSE_NESTED_INVALID'}
        if($countField -in @('couponSignalOrders','productNameOrders') -and $null -ne $count -and $count -gt 0 -and $count -lt 10){throw 'LIVE_RESPONSE_NESTED_INVALID'}
      }
    }
    foreach ($cell in $nested.Values) {
      if ($null -eq $cell -or $cell -is [bool]) { continue }
      if ($cell -is [Array]) {
        if (@($cell | Where-Object { $_ -isnot [int] -and $_ -isnot [long] }).Count -gt 0) { throw 'LIVE_RESPONSE_NESTED_INVALID' }
      } elseif ($cell -isnot [int] -and $cell -isnot [long]) { throw 'LIVE_RESPONSE_NESTED_INVALID' }
    }
  }
  if ($value.Contains('calculationEvidence') -and $null -ne $value.calculationEvidence) {
    $calculation=$value.calculationEvidence
    $counts=@('matchedLineCount','unmatchedLineCount','missingCostProductCount','couponRuleFitOrderCount',
      'couponEstimatedOrderCount','couponUnmatchedOrderCount','couponUnknownOrderCount',
      'paymentComponentMismatchOrders','paymentComponentUnavailableOrders')
    $amounts=@('revenueKrw','grossCostKrw','couponDeductionKrw','marginBeforeAdSpendKrw')
    $keys=@('day','projectionScope','completeProjection','warningCodes','sourceLineCounts','adSpendKrw','fullMarginKrw')+$counts+$amounts
    if ($calculation -isnot [Collections.IDictionary] -or $calculation.Count -ne $keys.Count -or
        @($calculation.Keys | Where-Object { $_ -notin $keys }).Count -gt 0 -or
        $calculation.day -cne $day -or $null -ne $calculation.adSpendKrw -or $null -ne $calculation.fullMarginKrw -or
        $calculation.completeProjection -isnot [bool] -or $calculation.projectionScope -cnotin @('COMPLETE_API_DAY','DATED_CSV_ROWS') -or
        $calculation.warningCodes -isnot [Array] -or @($calculation.warningCodes | Where-Object { $_ -cnotin @(
          'CAFE24_DIAGNOSTIC_SCOPE_UNVERIFIED','CAFE24_PAYMENT_COMPONENTS_DIFFER','CAFE24_PAYMENT_COMPONENTS_UNAVAILABLE',
          'CAFE24_COUPON_SIGNAL_UNKNOWN','CAFE24_DIAGNOSTIC_SMALL_UNMATCHED_COHORT','CAFE24_MATCHED_ONLY_CALCULATION') }).Count) { throw 'LIVE_CALCULATION_INVALID' }
    foreach ($field in $counts+$amounts) {
      $cell=$calculation[$field]
      if ($null -eq $cell) { continue }
      if ($cell -isnot [ValueType] -or $cell -is [bool] -or -not [double]::IsFinite([double]$cell) -or
          [Math]::Abs([double]$cell) -gt 1e12 -or ($field -in $counts -and ($cell -lt 0 -or $cell -ne [Math]::Truncate($cell)))) { throw 'LIVE_CALCULATION_INVALID' }
    }
    $source=$calculation.sourceLineCounts
    if ($source -isnot [Collections.IDictionary] -or $source.Count -ne 2 -or
        @($source.Keys | Where-Object { $_ -notin @('csv','api') }).Count -or
        @($source.Values | Where-Object { $null -ne $_ -and ($_ -isnot [int] -and $_ -isnot [long] -or $_ -lt 0 -or $_ -gt 100000) }).Count) { throw 'LIVE_CALCULATION_INVALID' }
    $coupon=@('couponRuleFitOrderCount','couponEstimatedOrderCount','couponUnmatchedOrderCount','couponUnknownOrderCount')
    $couponNull=@($coupon | Where-Object { $null -eq $calculation[$_] }).Count
    if (($couponNull -gt 0 -and $couponNull -ne 4) -or
        @($coupon | Where-Object { $null -ne $calculation[$_] -and $calculation[$_] -gt 0 -and $calculation[$_] -lt 10 }).Count) { throw 'LIVE_CALCULATION_PRIVACY_INVALID' }
    $sourceNull=@($source.Values | Where-Object { $null -eq $_ }).Count
    if (($sourceNull -gt 0 -and ($sourceNull -ne 2 -or $null -ne $calculation.matchedLineCount -or $null -ne $calculation.unmatchedLineCount -or
        @($amounts | Where-Object { $null -ne $calculation[$_] }).Count)) -or
        (-not $calculation.completeProjection -and (@($counts+$amounts | Where-Object { $null -ne $calculation[$_] }).Count -or $sourceNull -ne 2)) -or
        ($calculation.completeProjection -and $sourceNull -eq 0 -and ($source.api+$source.csv) -lt 10)) { throw 'LIVE_CALCULATION_PRIVACY_INVALID' }
  }
}

try {
  if ($PSVersionTable.PSVersion.Major -lt 7 -or -not (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { throw 'POWERSHELL_DATE_STRING_SUPPORT_REQUIRED' }
  if ($SelfTest) {
    $sample=[ordered]@{ mode='inspect'; day='2026-10-01' }
    $roundtrip=($sample | ConvertTo-Json -Compress) | ConvertFrom-Json -AsHashtable
    if ($roundtrip.mode -cne 'inspect' -or $roundtrip.day -cne $day) { throw 'LOCAL_SERIALIZATION_FAILED' }
    Assert-SafeRemoteResult @{ mode='inspect'; day=$day; currentApiLines=477;allProviderOrderStatusesAbsent=$true }
    Assert-SafeRemoteResult @{ mode='inspect'; day=$day; allProviderOrderStatusesAbsent=$null }
    Assert-SafeRemoteResult @{optionCapacitySchemaDigest=('a'*64);currentOptionNameCapacity=256;optionCapacityTransitionReady=$true}
    Assert-SafeRemoteResult @{optionCapacityExpanded=$true;previousOptionNameCapacity=256;currentOptionNameCapacity=514;optionCapacitySchemaDigest=('a'*64);existingRowsPreserved=$true;credentialAndCsvPreserved=$true}
    foreach($bad in @(@{optionCapacitySchemaDigest=('a'*64);currentOptionNameCapacity='256';optionCapacityTransitionReady=$true},@{optionCapacitySchemaDigest=('a'*64);currentOptionNameCapacity=514;optionCapacityTransitionReady=$true},@{optionCapacitySchemaDigest=('a'*64);currentOptionNameCapacity=256;optionCapacityTransitionReady=1})) {
      $rejected=$false;try{Assert-SafeRemoteResult $bad}catch{$rejected=$true};if(-not $rejected){throw 'LOCAL_OPTION_CAPACITY_BOUNDARY_FAILED'}
    }
    $differences=@{totalOrderOrders=422;paidOrders=4;paymentMethodOrders=422;couponSignalOrders=$null;productNameOrders=$null}
    Assert-SafeRemoteResult @{mode='inspect';day=$day;inputDifferences=$differences}
    foreach($field in @('couponSignalOrders','productNameOrders','paidOrders','totalOrderOrders','paymentMethodOrders')) {
      $bad=$differences.Clone();if($field -in @('couponSignalOrders','productNameOrders')){$bad[$field]=1}else{$bad[$field]=$null}
      $rejected=$false;try{Assert-SafeRemoteResult @{mode='inspect';day=$day;inputDifferences=$bad}}catch{$rejected=$true};if(-not $rejected){throw 'LOCAL_INPUT_DIFFERENCE_PRIVACY_FAILED'}
    }
    $datedSample=@{mode='seed';day=$day;configurationObservedAt='2026-10-07T00:00:00.000Z';configurationFingerprint=('a'*64)}
    $datedRoundtrip=($datedSample | ConvertTo-Json -Compress) | ConvertFrom-Json -AsHashtable -DateKind String
    Assert-SafeRemoteResult $datedRoundtrip
    Assert-SafeRemoteResult @{mode='repair-configuration-dates';day=$day;configurationStateDigest=('a'*64);
      configurationDateRepairApplied=$true;configurationRepairDataPreserved=$true;repairedDateFieldCount=65;repairedTimestampFieldCount=37}
    foreach ($canary in @(@{mode='arbitrary-payload';day=$day},@{mode='inspect';day=$day;configurationCounts=@{secret=1}})) {
      $rejected=$false; try { Assert-SafeRemoteResult $canary } catch { $rejected=$true }
      if (-not $rejected) { throw 'LOCAL_RESPONSE_BOUNDARY_FAILED' }
    }
    $safeDiagnostic=Read-SafeSetupFailureDiagnostic @{category='SETUP_POSTCHECK';sqlState=$null;guard='ISOLATED_ADDED_FOREIGN_KEY_MISMATCH';statementIndex=$null}
    if ($safeDiagnostic.guard -cne 'ISOLATED_ADDED_FOREIGN_KEY_MISMATCH') { throw 'LOCAL_FAILURE_DIAGNOSTIC_FAILED' }
    $null=Read-SafeSetupFailureDiagnostic @{category='CHILD_ACTIVATE';sqlState=$null;guard='CAFE24_ACTIVATION_CSV_MAPPING_STATE';statementIndex=$null}
    foreach($guard in @('CAFE24_ACTIVATION_CSV_PRODUCT_NAME','CAFE24_ACTIVATION_CSV_QUANTITY','CAFE24_ACTIVATION_CSV_SALE_PRICE')){$null=Read-SafeSetupFailureDiagnostic @{category='CHILD_ACTIVATE';sqlState=$null;guard=$guard;statementIndex=$null}}
    $null=Read-SafeSetupFailureDiagnostic @{category='CHILD_SEED_CONFIGURATION';sqlState=$null;guard='CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED';statementIndex=$null}
    foreach($count in @(1,9,468,476)) {
      $rejected=$false;try {$null=Read-SafeMappingReviewEvidence @{csvMappingChangedLineCount=$count;csvMappingStateDigest=('a'*64);configurationStateDigest=('b'*64)}}catch{$rejected=$true}
      if(-not $rejected){throw 'LOCAL_MAPPING_COHORT_BOUNDARY_FAILED'}
    }
    foreach ($canary in @(
      @{category='CHILD_PUBLISH';sqlState=$null;guard='CAFE24_ACTIVATION_CSV_MAPPING_STATE';statementIndex=$null},
      @{category='SYNTHETIC-SECRET-CANARY';sqlState=$null;guard=$null;statementIndex=$null},
      @{category='SETUP_DDL';sqlState='SYNTHETIC-SECRET-CANARY';guard=$null;statementIndex=0},
      @{category='SETUP_DDL';sqlState=$null;guard='SYNTHETIC-SECRET-CANARY';statementIndex=0},
      @{category='SETUP_DDL';sqlState=$null;guard=$null;statementIndex=1001},
      @{category='SETUP_DDL';sqlState=$null;guard=$null;statementIndex=0;message='SYNTHETIC-SECRET-CANARY'})) {
      $rejected=$false;try { $null=Read-SafeSetupFailureDiagnostic $canary } catch {$rejected=$true}
      if(-not $rejected) { throw 'LOCAL_FAILURE_DIAGNOSTIC_BOUNDARY_FAILED' }
    }
    $process=Read-SafeProcessEvidence @{exitCode=$null;signal='SIGKILL'}
    if($process.signal -cne 'SIGKILL'){throw 'LOCAL_PROCESS_EVIDENCE_FAILED'}
    foreach($bad in @(@{exitCode=999;signal=$null},@{exitCode=1;signal='SYNTHETIC-SECRET-CANARY'},@{exitCode=1;signal=$null;stderr='SYNTHETIC-SECRET-CANARY'})) {
      $rejected=$false;try{$null=Read-SafeProcessEvidence $bad}catch{$rejected=$true};if(-not $rejected){throw 'LOCAL_PROCESS_BOUNDARY_FAILED'}
    }
    $execution=@{runPresent=$true;runCount=1;runStatuses=@('ACTION_REQUIRED');selection='ONLY_DAY_RUN';lastRunStatus='ACTION_REQUIRED';lastSafeCode='FIELD_UNSUPPORTED';unitStatuses=@('ACTION_REQUIRED');unitCount=1;leasePresent=$false;leaseActive=$false}
    Assert-SafeRemoteResult @{mode='inspect';day=$day;syncExecutionEvidence=$execution;connectionAccessState='READY';connectionEnabled=$false;credentialRevisions=@(9,9);providerFailureDiagnosticCode='CAFE24_FIELD_ITEM_STATUS'}
    foreach($bad in @(@{mode='inspect';day=$day;providerFailureDiagnosticCode='CAFE24_FIELD_RAW_SECRET'},@{mode='inspect';day=$day;credentialRevisions=@(9)},@{mode='inspect';day=$day;connectionAccessState='SYNTHETIC-SECRET-CANARY'})) {
      $rejected=$false;try{Assert-SafeRemoteResult $bad}catch{$rejected=$true};if(-not $rejected){throw 'LOCAL_EXECUTION_BOUNDARY_FAILED'}
    }
    Write-Output '{"selfTest":"PASS","networkCalls":0,"csvRead":false,"secretRead":false}'
    return
  }
  $action=[ordered]@{}
  if ($Mode -eq 'OptionCapacityPrecheck') { $action.mode='live-option-precheck' }
  elseif($Mode -eq 'ExpandOptionCapacity') {
    if(-not $AcknowledgeOptionCapacity -or $ExpectedSchemaDigest -cnotmatch '^[a-f0-9]{64}$' -or -not $SingleInstanceVerifiedAt){throw 'OPTION_CAPACITY_ACK_REQUIRED'}
    $action.mode='live-option-expand';$action.acknowledgement='EXPAND_ISOLATED_06_DERIVED_OPTION_NAME_256_TO_514_ONLY'
    $action.expectedSchemaDigest=$ExpectedSchemaDigest;$action.singleInstanceVerifiedAt=$SingleInstanceVerifiedAt
  }
  elseif ($Mode -eq 'Precheck') { $action.mode='live-precheck' }
  elseif ($Mode -eq 'Setup') {
    if (-not $AcknowledgeSetup -or $ExpectedSchemaDigest -cnotmatch '^[a-f0-9]{64}$') { throw 'SETUP_ACK_REQUIRED' }
    $sqlPath=Join-Path $PSScriptRoot 'live-additive.sql'
    if ((Get-FileHash -LiteralPath $sqlPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSchemaDigest) { throw 'SETUP_LOCAL_SCHEMA_DIGEST_CHANGED' }
    $action.mode='live-setup'
    $action.acknowledgement='ADD_06_TABLES_AND_EXTEND_AUDIT_ACTOR_CHECK'
    $action.expectedSchemaDigest=$ExpectedSchemaDigest
  } elseif ($Mode -eq 'Recover') {
    if (-not $AcknowledgeEnableRecovery -or -not $SingleInstanceVerifiedAt) { throw 'RECOVERY_ACK_REQUIRED' }
    $action.mode='live-recover'
    $action.acknowledgement='RESTORE_ISOLATED_06_CHILD_ENABLED_FALSE_ONLY'
    $action.singleInstanceVerifiedAt=$SingleInstanceVerifiedAt
  } elseif ($Mode -eq 'StatusEvidence') {
    $action.mode='business-aggregate'; $action.day=$day
  } else {
    $request=New-CanonicalRequest
    $payload=$request | ConvertTo-Json -Compress -Depth 20
    if ([Text.Encoding]::UTF8.GetByteCount($payload) -gt 524288) { throw 'CANONICAL_INPUT_LIMIT' }
    $action.mode='live-canonical'; $action.payload=$payload
  }
  $failureCode='LIVE_OPERATOR_UNAVAILABLE'
  $secretPath=Join-Path $env:LOCALAPPDATA 'MetaAdsCafe24Isolated/operator-secret.dpapi'
  $secure=ConvertTo-SecureString -String ([IO.File]::ReadAllText($secretPath).Trim())
  $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $operator=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $handler=[Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect=$false
  $client=[Net.Http.HttpClient]::new($handler)
  $client.Timeout=[TimeSpan]::FromSeconds(45); $client.MaxResponseContentBufferSize=32768
  $client.DefaultRequestHeaders.Add('Origin',$origin)
  try {
    $failureCode='LIVE_REMOTE_ACTION_FAILED'
    $reply=Post-Action $client $operator 'action' $action
    $limit=[DateTime]::UtcNow.AddMinutes(12)
    $jobId=$null
    while ($reply.status -eq 202) {
      if ([DateTime]::UtcNow -gt $limit) { throw 'LIVE_JOB_TIMEOUT' }
      if ($reply.result.ContainsKey('jobId')) { $jobId=$reply.result.jobId }
      if (-not $jobId -or $jobId -cnotmatch '^[a-f0-9-]{36}$') { throw 'LIVE_JOB_SHAPE_INVALID' }
      Start-Sleep -Seconds 6
      $reply=Post-Action $client $operator 'action-status' @{jobId=$jobId}
    }
    $safe=$reply.result
    if ($Mode -eq 'StatusEvidence') {
      if ($safe.day -cne $day -or $safe.orderCount -ne 422 -or $safe.itemCount -ne 477 -or
          $safe.readComplete -ne $true -or $safe.observedItemStatusCodes -isnot [Array] -or
          $safe.observedItemStatusCodes.Count -lt 1 -or $safe.observedItemStatusCodes.Count -gt 32 -or
          @($safe.observedItemStatusCodes | Where-Object { $_ -isnot [string] -or $_ -cnotmatch '^[A-Z][0-9]{2}$' }).Count -or
          @($safe.observedItemStatusCodes | Select-Object -Unique).Count -ne $safe.observedItemStatusCodes.Count) { throw 'LIVE_STATUS_EVIDENCE_INVALID' }
      # Project code set only; discard the aggregate's monetary and cohort fields.
      $safe=[ordered]@{mode='status-evidence';day=$day;orderCount=422;itemCount=477;readComplete=$true;
        observedItemStatusCodes=@($safe.observedItemStatusCodes | Sort-Object)}
      $reply=$null
    } else { $failureCode='LIVE_LOCAL_RESPONSE_INVALID'; Assert-SafeRemoteResult $safe }
    if ($PassThru) { return $safe }
    Write-Output ($safe | ConvertTo-Json -Compress -Depth 8)
  } finally { $client.Dispose(); $handler.Dispose(); $operator=$null; $request=$null; $payload=$null; $action=$null }
} catch {
  $safeRemoteFailure=$null
  $failureException=$_.Exception
  for($depth=0;$depth -lt 4 -and $null -ne $failureException;$depth++) {
    if($failureException.Data.Contains('safeRemoteFailure')) { $safeRemoteFailure=$failureException.Data['safeRemoteFailure'];break }
    if($failureException.Message -ceq 'LIVE_REMOTE_JSON_INVALID') { $failureCode='LIVE_REMOTE_JSON_INVALID' }
    $failureException=$failureException.InnerException
  }
  if($null -ne $safeRemoteFailure) {
    Write-Output ($safeRemoteFailure | ConvertTo-Json -Compress -Depth 5)
  } else { Write-Output $failureCode }
  exit 1
}
