param([Parameter(Mandatory)][ValidateSet('Login','List','CreateGoogle','CreateCafe24','BindGoogle','BindMeta','PrepareVerifyGoogle','PrepareVerifyMeta','ExecuteVerifyGoogle','ExecuteVerifyMeta')][string]$Mode,
  [switch]$ActivationVerified,[switch]$IndependentObservationVerified,[string]$ConnectionId,[string]$VerificationDay,[string]$FromDate,[string]$ObservedAccountCostKrw,[string]$ObservedAccountSpendUsd,
  [ValidateSet('REQUIRE_VERIFIED_CONDITIONALS','ALLOW_UNAVAILABLE_WITH_REASONS')][string]$ConditionalReviewDecision)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/source-connection-helpers.ps1"
$phase08Context=$null;$phase08Operator=$null;$phase08Headers=$null;$phase08Session=$null;$phase08Body=$null;$phase08Response=$null
try {
  $phase08Context=Read-Phase08ProtectedJson;$phase08Operator=Read-Phase08Operator
  Assert-Phase08SourceContext $phase08Context $phase08Operator
  if($Mode -cne 'Login' -and -not $ActivationVerified){throw 'root-activation-proof-required'}
  if($Mode.StartsWith('ExecuteVerify') -and -not $IndependentObservationVerified){throw 'manual-observation-proof-required'}
  if($Mode.StartsWith('PrepareVerify')) {
    if($ConnectionId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'verification-id'}
    $provider=if($Mode -ceq 'PrepareVerifyGoogle'){'GOOGLE'}else{'META'}
    if($provider -ceq 'META' -and $ConnectionId -cne $phase08Context.ids.metaConnectionId){throw 'meta-aad-id'}
    $observed=if($provider -ceq 'GOOGLE'){$ObservedAccountCostKrw}else{$ObservedAccountSpendUsd}
    $phase08Body=New-Phase08VerificationDto $provider $VerificationDay $FromDate $observed $ConditionalReviewDecision
    @{state='PHASE08_VERIFICATION_DTO_PREPARED';endpoint=('/backend-api/source-connections/'+$ConnectionId+'/verify-'+$provider.ToLowerInvariant());body=$phase08Body;
      requiresIndependentManualObservation=$true;requiresReviewedExecution=$true;providerRequests=0;remoteChanges=0}|ConvertTo-Json -Depth 5
  } else {
    $phase08Headers=@{Origin=$phase08Context.origin};$phase08Session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $phase08Body=@{email=$phase08Operator.email;password=$phase08Operator.password}
    $phase08Response=Invoke-Phase08SourceRequest 'POST' '/backend-api/auth/login' $phase08Body $phase08Context $phase08Session $phase08Headers
    Assert-Phase08LoginResponse $phase08Response $phase08Session $phase08Operator $phase08Context.origin
    $phase08Body=$null;$phase08Response=$null
    $phase08Csrf=@($phase08Session.Cookies.GetCookies([Uri]$phase08Context.origin)|Where-Object {$_.Name -ceq '__Host-phase08-meta_csrf'})
    if($phase08Csrf.Count -ne 1){throw 'csrf'};$phase08Headers['X-CSRF-Token']=$phase08Csrf[0].Value
    if($Mode -ceq 'Login') {
      @{state='PHASE08_SOURCE_NORMAL_LOGIN_VERIFIED';cookieCount=4;settingsManage=$true;providerRequests=0}|ConvertTo-Json
    } else {
      $phase08Response=Invoke-Phase08SourceRequest 'GET' '/backend-api/source-connections?limit=200&page=1' $null $phase08Context $phase08Session $phase08Headers
      $list=$phase08Response.Content|ConvertFrom-Json
      if($null -ne $list.nextPage -or @($list.items).Count -gt 3){throw 'fresh-scope-list'}
      foreach($row in $list.items){Assert-Phase08Connection $row $row.provider}
      if($Mode -cin @('CreateGoogle','CreateCafe24')) {
        $provider=if($Mode -ceq 'CreateGoogle'){'GOOGLE'}else{'CAFE24'}
        if(@($list.items|Where-Object {$_.provider -ceq $provider}).Count -ne 0){throw 'existing-inspect-no-retry'}
        $phase08Body=Get-Phase08ConnectionInput $provider
        $phase08Response=Invoke-Phase08SourceRequest 'POST' '/backend-api/source-connections' $phase08Body $phase08Context $phase08Session $phase08Headers
        $created=$phase08Response.Content|ConvertFrom-Json;Assert-Phase08Connection $created $provider -Pending
        @{state='PHASE08_SOURCE_CREATED';connectionId=$created.id;provider=$provider;enabled=$false;accessState='PENDING';providerRequests=0}|ConvertTo-Json
      } elseif($Mode -cin @('BindGoogle','BindMeta')) {
        $provider=if($Mode -ceq 'BindGoogle'){'GOOGLE'}else{'META'}
        if($ConnectionId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'bind-id'}
        if($provider -ceq 'META' -and $ConnectionId -cne $phase08Context.ids.metaConnectionId){throw 'meta-aad-id'}
        $matches=@($list.items|Where-Object {$_.id -ceq $ConnectionId})
        if($matches.Count -ne 1){throw 'bind-existing'};Assert-Phase08Connection $matches[0] $provider -Pending
        $phase08Response=Invoke-Phase08SourceRequest 'POST' ('/backend-api/source-connections/'+$ConnectionId+'/bind-'+$provider.ToLowerInvariant()+'-auth') @{} $phase08Context $phase08Session $phase08Headers
        $bound=$phase08Response.Content|ConvertFrom-Json
        if($bound.enabled -isnot [bool] -or $bound.enabled -ne $false -or $bound.accessState -cne 'PENDING'){throw 'bound-state'}
        @{state='PHASE08_SOURCE_BOUND';connectionId=$ConnectionId;provider=$provider;enabled=$false;accessState='PENDING';expectedProviderMetadataRequests=if($provider -ceq 'META'){3}else{0};providerRequestCountObserved=$false;datedStatsRequests=0}|ConvertTo-Json
      } elseif($Mode.StartsWith('ExecuteVerify')) {
        $provider=if($Mode -ceq 'ExecuteVerifyGoogle'){'GOOGLE'}else{'META'}
        if($ConnectionId -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'){throw 'verification-id'}
        if($provider -ceq 'META' -and $ConnectionId -cne $phase08Context.ids.metaConnectionId){throw 'meta-aad-id'}
        $phase08Rows=@($list.items|Where-Object {$_.id -ceq $ConnectionId})
        if($phase08Rows.Count -ne 1){throw 'verification-existing'};Assert-Phase08Connection $phase08Rows[0] $provider -Pending
        $observed=if($provider -ceq 'GOOGLE'){$ObservedAccountCostKrw}else{$ObservedAccountSpendUsd}
        $phase08Body=New-Phase08VerificationDto $provider $VerificationDay $FromDate $observed $ConditionalReviewDecision
        $phase08Response=Invoke-Phase08SourceRequest 'POST' ('/backend-api/source-connections/'+$ConnectionId+'/verify-'+$provider.ToLowerInvariant()) $phase08Body $phase08Context $phase08Session $phase08Headers
        $verified=$phase08Response.Content|ConvertFrom-Json
        if($verified.enabled -isnot [bool] -or -not $verified.enabled -or $verified.accessState -cne 'READY' -or $verified.verifiedDay -cne $VerificationDay){throw 'verification-outcome'}
        @{state='PHASE08_SOURCE_NORMAL_VERIFICATION_SUCCEEDED';connectionId=$ConnectionId;provider=$provider;verifiedDay=$VerificationDay;accessState='READY';enabled=$true;
          manualObservationAcknowledged=$true;providerRequestCountObserved=$false;coveragePublished=0;rawResponsesSuppressed=$true}|ConvertTo-Json
      } else {
        $summary=@(foreach($row in $list.items){@{connectionId=$row.id;provider=$row.provider;enabled=$row.enabled;accessState=$row.accessState;currencyCode=$row.currencyCode;timeZone=$row.timeZone}})
        @{state='PHASE08_SOURCE_STATE';connections=$summary;providerRequests=0;rawResponsesSuppressed=$true}|ConvertTo-Json -Depth 5
      }
    }
  }
} catch {
  $diagnostic=Get-Phase08SourceFailureDiagnostic $_.Exception
  @{state='PHASE08_SOURCE_CONTROL_FAILED';mode=$Mode;code=$diagnostic.code;httpStatus=$diagnostic.httpStatus;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1
}
finally {
  if($phase08Headers){$phase08Headers.Clear()};$phase08Headers=$null;$phase08Context=$null;$phase08Operator=$null;$phase08Session=$null;$phase08Body=$null;$phase08Response=$null;
  $phase08Csrf=$null;$list=$null;$matches=$null;$bound=$null;$created=$null;$verified=$null;$phase08Rows=$null
}
