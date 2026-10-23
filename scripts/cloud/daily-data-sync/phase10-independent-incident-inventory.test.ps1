Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-independent-incident-inventory.ps1"
$checks=0
if((Get-IndependentIncidentKeyClass ('sb_secret_'+'SYNTHETIC_PRIVATE_CANARY_123456')).kind -cne 'OPAQUE_SECRET_API_KEY'){throw 'KEY_CLASS'};$checks++
if((Get-IndependentIncidentKeyClass ('sb_publishable_'+'SYNTHETIC_PUBLIC_123456')).kind -cne 'PUBLISHABLE_API_KEY'){throw 'PUBLIC_CLASS'};$checks++
$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"ref":"ehnfrrmbkvlsbpvqcvkr","role":"service_role"}')).TrimEnd('=').Replace('+','-').Replace('/','_')
$jwt='eyJhbGciOiJIUzI1NiJ9.'+$payload+'.SYNTHETIC_SIGNATURE';$class=Get-IndependentIncidentKeyClass $jwt
if($class.kind -cne 'LEGACY_JWT' -or $class.roleClass -cne 'service_role' -or -not $class.projectClaimMatches){throw 'JWT_CLASS'};$checks++
$canary='SYNTHETIC_OUTPUT_CANARY_NEVER_RETURNED_987654';$rejected=$false;try{Assert-IndependentIncidentOutput ('{"oops":"'+$canary+'"}') @($canary)}catch{$rejected=$true};if(-not $rejected){throw 'CANARY_OUTPUT'};$checks++
$rejected=$false;try{Assert-IndependentIncidentOutput ('{"oops":"'+$jwt+'"}') @($jwt)}catch{$rejected=$true};if(-not $rejected){throw 'JWT_OUTPUT'};$checks++
Assert-IndependentIncidentOutput '{"kind":"METADATA_ONLY","equal":true,"hash":"0000000000000000000000000000000000000000000000000000000000000000"}' @($canary);$checks++
$mcp='SYNTHETIC_MCP_'+('A'*64);$inspector='SYNTHETIC_INSPECTOR_'+('B'*64);$ref='vault://meta/11111111-1111-4111-8111-111111111111';$conn='22222222-2222-4222-8222-222222222222'
$key=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($key);$iv=[byte[]]::new(12);[Security.Cryptography.RandomNumberGenerator]::Fill($iv)
$plain=[Text.Encoding]::UTF8.GetBytes((@{credentialRef=$ref;connectionId=$conn;accountId='2138525300002203';transport='MCP';token=$mcp;inspectorToken=$inspector}|ConvertTo-Json -Compress));$cipher=[byte[]]::new($plain.Length);$tag=[byte[]]::new(16)
$aad=[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @('META_VAULT',1,'4474691502806219',$ref,$conn,'2138525300002203','MCP') -Compress));$aes=[Security.Cryptography.AesGcm]::new($key,16)
try{$aes.Encrypt($iv,$plain,$cipher,$tag,$aad)}finally{$aes.Dispose()}
$envelope=@{version=1;iv=[Convert]::ToBase64String($iv);authTag=[Convert]::ToBase64String($tag);ciphertext=[Convert]::ToBase64String($cipher)}|ConvertTo-Json -Compress
$vars=@{DAILY_SYNC_META_CREDENTIAL_REF=$ref;PHASE08_META_CONNECTION_ID=$conn;DAILY_SYNC_META_TRANSPORT='MCP';DAILY_SYNC_META_VAULT_KEY=[Convert]::ToBase64String($key);PHASE08_META_RECORD_B64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($envelope))}
$equal=Get-IndependentIncidentMetaEquality $vars $mcp $inspector
if(-not $equal.offlineAuthenticatedDecryption -or -not $equal.exactBindingMatches -or -not $equal.mcpTokenEqualsExistingProtectedSource -or -not $equal.inspectorTokenEqualsExistingProtectedSource){throw 'META_EQUALITY'};$checks++
Assert-IndependentIncidentOutput ($equal|ConvertTo-Json -Compress) @($mcp,$inspector,$vars.DAILY_SYNC_META_VAULT_KEY,$vars.PHASE08_META_RECORD_B64);$checks++
$different=Get-IndependentIncidentMetaEquality $vars ($mcp+'DIFFERENT') $inspector;if($different.mcpTokenEqualsExistingProtectedSource -ne $false){throw 'META_INEQUALITY'};$checks++
$vars.PHASE08_META_CONNECTION_ID='33333333-3333-4333-8333-333333333333';$rejected=$false;try{$null=Get-IndependentIncidentMetaEquality $vars $mcp $inspector}catch{$rejected=$true};if(-not $rejected){throw 'META_AAD_TAMPER'};$checks++
foreach($bytes in @($key,$iv,$plain,$cipher,$tag,$aad)){[Array]::Clear($bytes,0,$bytes.Length)}
@{kind='INCIDENT_INDEPENDENT_SHARED_INVENTORY_SYNTHETIC';checks=$checks;status='PASS';credentialReads=0;networkCalls=0;rawSecretValuesReturned=0}|ConvertTo-Json -Compress
