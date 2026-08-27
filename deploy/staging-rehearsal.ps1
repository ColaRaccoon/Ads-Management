[CmdletBinding()]
param(
  [ValidateSet("Plan", "Run")]
  [string]$Action = "Plan",
  [switch]$Approved
)

$ErrorActionPreference = "Stop"

$replacement = [ordered]@{
  result = "SUPERSEDED"
  databaseProvider = "supabase_postgresql"
  localPostgreSqlUsed = $false
  productionDatabaseMutationAllowed = $false
  restoreVerification = "deploy/windows/Restore-Verify.ps1"
  releaseCompatibility = "deploy/windows/Test-ReleaseCompatibility.ps1"
  integrationGuard = "apps/api/src/common/supabase-integration-target.ts"
  explanation = "The former step-8 loopback PostgreSQL rehearsal was retired after the explicit decision to retain the existing Supabase database."
}

if ($Action -eq "Plan") {
  $replacement | ConvertTo-Json -Depth 4
  exit 0
}

if (-not $Approved) {
  throw "EXPLICIT_APPROVAL_REQUIRED: a rehearsal that mutates an isolated Supabase test target requires approval immediately before execution."
}

throw "LEGACY_LOCAL_POSTGRES_REHEARSAL_RETIRED: use Restore-Verify.ps1 and Test-ReleaseCompatibility.ps1 against a separately approved, existing isolated Supabase test target."
