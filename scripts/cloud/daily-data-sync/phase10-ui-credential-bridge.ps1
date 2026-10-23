Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. "$PSScriptRoot/operator-session.ps1"
$operator=$null;$payload=$null
try {
 $operator=Read-Phase08Operator
 $payload=@{origin='https://phase08-daily-data-sync-production.up.railway.app';projectRef=$operator.projectRef;schema=$operator.schema;email=$operator.email;password=$operator.password}|ConvertTo-Json -Compress
 # Anonymous stdin pipe: never command arguments, clipboard, or plaintext disk.
 $payload|& node "$PSScriptRoot/phase10-ui-credential-bridge.mjs"
 if($LASTEXITCODE -ne 0){throw 'bridge-child'}
} catch {Write-Error 'PHASE10_UI_INPUT_FAILED';exit 1}
finally {$payload=$null;$operator=$null}
