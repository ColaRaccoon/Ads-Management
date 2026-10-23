Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/consumer-meta-readonly-20261021.ps1"
$text=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'consumer-meta-readonly-20261021.ps1'))
$checks=@(
 ($text.Contains("[switch]`$Execute")),
 ($text.Contains("'attempt.json'")),
 ($text.Contains("Get-IncidentState")),
 ($text.Contains("39c6b738-6d2f-4111-a97b-37f017b39886")),
 ($text.Contains("deploymentStopped -cne `$true")),
 ($text.Contains("Read-IndependentIncidentMetaToken 'mcp-access-token.dpapi'")),
 ($text.Contains("Read-IndependentIncidentMetaToken 'inspector-token.dpapi'")),
 ($text.Contains("Assert-IndependentIncidentOutput")),
 ($text.Contains("StandardInput.Write(`$wire)")),
 ($text.Contains("Get-MetaConsumerPins")),
 ($text.Contains("FileMode]::CreateNew")),
 ($text.Contains(".Kill(`$true)"))
)
if(@($checks|Where-Object {$_ -cne $true}).Count -ne 0){throw 'OFFLINE_SOURCE_GUARD'}
$pins=Get-MetaConsumerPins;if($pins.Count -ne 5 -or @($pins.Values|Where-Object {$_ -cnotmatch '^[a-f0-9]{64}$'}).Count -ne 0){throw 'OFFLINE_PIN_GUARD'}
$absent=Get-MetaCurrentComparison @{} ('A'*80) ('B'*80);if($absent.currentComparisonPerformed -cne $false -or $null -ne $absent.currentMcpMatchesLocal){throw 'ABSENT_CAPSULE'}
$partial=Get-MetaCurrentComparison @{PHASE08_META_RECORD_B64='SYNTHETIC'} ('A'*80) ('B'*80);if($partial.currentCapsulePresent -cne $true -or $partial.currentComparisonPerformed -cne $false){throw 'PARTIAL_CAPSULE'}
function Get-IndependentIncidentMetaEquality {return @{mcpTokenEqualsExistingProtectedSource=$true;inspectorTokenEqualsExistingProtectedSource=$false;exactBindingMatches=$true}}
$present=Get-MetaCurrentComparison @{PHASE08_META_RECORD_B64='SYNTHETIC';DAILY_SYNC_META_VAULT_KEY='SYNTHETIC';DAILY_SYNC_META_CREDENTIAL_REF='SYNTHETIC';PHASE08_META_CONNECTION_ID='SYNTHETIC';DAILY_SYNC_META_TRANSPORT='SYNTHETIC'} ('A'*80) ('B'*80);if($present.currentComparisonPerformed -cne $true -or $present.currentMcpMatchesLocal -cne $true -or $present.currentInspectorMatchesLocal -cne $false){throw 'PRESENT_CAPSULE'}
@{kind='META_CONSUMER_PS_OFFLINE';passed=16;providerRequests=0;protectedReads=0;remoteWrites=0}|ConvertTo-Json -Compress
