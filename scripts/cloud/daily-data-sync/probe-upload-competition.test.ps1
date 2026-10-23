Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
# AST only: never import credential readers or invoke the entry point.
$tok=$null;$err=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'probe-upload-competition.ps1'),[ref]$tok,[ref]$err)
if($err.Count){throw 'parse'}
foreach($fn in @($ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst]})){. ([scriptblock]::Create($fn.Extent.Text))}
$main=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.TryStatementAst]},$true))[0].Extent.Text.Replace('exit 1','')
function Assert-Phase08SchedulerOutputPath($Path){return $Path}
function Import-Phase08SchedulerChildDefinitions {}
function Get-Phase08SchedulerPins {return @{sourceSha='a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097'}}
function Read-Phase08ProtectedJson {return @{origin='https://phase08-daily-data-sync-production.up.railway.app'}}
function Read-Phase08Operator {return @{email='synthetic@example.invalid';password='SYNTHETIC_PRIVATE_PASSWORD_12345678901234567890'}}
function Assert-Phase08SchedulerContext($Context,$Pins){}
function Assert-Phase08SourceContext($Context,$Operator){}
function Get-Phase08SchedulerGraphState($Context,$Pins){return @{}}
function Invoke-Phase08Management($Action,$Query){
 $script:reads++;if($Action -cne 'Query' -or -not $Query.StartsWith('BEGIN READ ONLY;') -or -not $Query.Contains("source='CSV'") -or -not $Query.Contains("u.status='RUNNING'") -or -not $Query.EndsWith('ROLLBACK;')){throw 'readonly-query'}
 $active=if($script:mode -eq 'inactive' -or ($script:mode -eq 'lost' -and $script:reads -eq 2)){$false}else{$script:reads -lt 3}
 return @(@{database='postgres';principal='postgres';tables=[long]68;upload_batches=0;upload_rows=0;upload_errors=0;cafe_batches=0;cafe_errors=0;cafe_csv_lines=$(if($script:mode -eq 'changed' -and $script:reads -eq 3){1}else{0});active_match=$active;checkpoint_revision=$(if($ActiveProvider -ceq 'CAFE24'){1}else{0})})
}
function Invoke-Phase08SourceRequest($Method,$Path,$Body,$Context,$Session,$Headers){
 $script:logins++;if($Method -cne 'POST' -or $Path -cne '/backend-api/auth/login' -or $Body.email -cne 'synthetic@example.invalid'){throw 'login'}
 foreach($name in @('__Host-phase08-meta_access','__Host-phase08-meta_refresh','__Host-phase08-meta_session','__Host-phase08-meta_csrf')){$cookie=[Net.Cookie]::new($name,'SYNTHETIC_PRIVATE_COOKIE_'+$name,'/','phase08-daily-data-sync-production.up.railway.app');$cookie.Secure=$true;$Session.Cookies.Add($cookie)}
 return @{StatusCode=200;Content='{}'}
}
function Assert-Phase08LoginResponse($Response,$Session,$Operator,$Origin){if($Session.Cookies.Count -ne 4){throw 'login-cookies'}}
function Invoke-WebRequest {
 param($Uri,$Method,$Headers,$WebSession,$ContentType,$Body,$MaximumRedirection,$TimeoutSec,[switch]$SkipHttpErrorCheck)
 $script:uploads++;if($Uri -cne 'https://phase08-daily-data-sync-production.up.railway.app/backend-api/sales/cafe24/uploads' -or $Method -cne 'Post' -or $Body -cne '{}' -or $ContentType -cne 'application/json' -or $MaximumRedirection -ne 0 -or $TimeoutSec -ne 20 -or $WebSession.Cookies.Count -ne 4 -or -not $Headers.ContainsKey('X-CSRF-Token')){throw 'upload-boundary'}
 if($script:mode -eq 'network'){throw 'SYNTHETIC_PRIVATE_PASSWORD_12345678901234567890'}
 $status=if($script:mode -eq 'race'){400}elseif($script:mode -eq 'unauth'){401}else{503}
 $content=if($script:mode -eq 'race'){'{"code":"FILE_REQUIRED"}'}elseif($script:mode -eq 'array'){'{"code":["HEAVY_OPERATION_BUSY"]}'}elseif($script:mode -eq 'echo'){'{"code":"HEAVY_OPERATION_BUSY","message":"SYNTHETIC_PRIVATE_PASSWORD_12345678901234567890"}'}elseif($script:mode -eq 'huge'){'X'*8193}else{'{"code":"HEAVY_OPERATION_BUSY"}'}
 return @{StatusCode=$status;Content=$content;Headers=@{'Cache-Control'=$(if($script:mode -eq 'cache'){'public'}else{'private, no-store'});'Retry-After'=$(if($script:mode -eq 'retry'){'0'}else{'2'})}}
}
function Write-Phase08SchedulerPublicEvidence($Value,$Path){$script:outputs++}
$cases=0
foreach($script:mode in @('busy','race','meta','inactive','lost','changed','array','echo','huge','cache','retry','network','unauth')){
 $ActiveProvider=if($script:mode -eq 'meta'){'META'}else{'CAFE24'};$OutputName='upload-competition-20261015-mock.json';$script:reads=0;$script:logins=0;$script:uploads=0;$script:outputs=0
 $stage='IDENTITY';$context=$null;$operator=$null;$headers=$null;$session=$null;$response=$null;$body=$null;$uploadRequests=0
 $out=& ([scriptblock]::Create($main));$value=$out|ConvertFrom-Json -AsHashtable -DateKind String
 if($script:mode -in @('busy','race','meta')){if($value.state -cne 'PHASE08_UPLOAD_COMPETITION_OBSERVED' -or $script:uploads -ne 1 -or $script:outputs -ne 1 -or $script:logins -ne 1){throw ('normal-'+$script:mode)};if($value.competitionVerified -ne ($script:mode -cne 'race')){throw 'race'}}
 elseif($value.state -cne 'PHASE08_UPLOAD_COMPETITION_FAILED' -or $script:outputs -ne 0){throw ('failure-'+$script:mode)}
 if($script:uploads -gt 1 -or $script:logins -gt 1 -or ($script:mode -in @('inactive','lost') -and $script:uploads -ne 0)){throw 'retry-or-inactive'}
 if(($out|Out-String).Contains('SYNTHETIC_PRIVATE')){throw 'raw-leak'};$cases++
}
@{classification='SYNTHETIC_ORIGINAL_EMPTY_UPLOAD_PROBE_AST';cases=$cases;actualNetworkCalls=0;actualProtectedReads=0;maximumUploadRequests=1}|ConvertTo-Json -Compress
