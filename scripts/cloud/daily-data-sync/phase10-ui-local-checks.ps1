param(
 [Parameter(Mandatory=$true)][string]$EvidencePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
# This is a local source/type/render check. It never supplies authentication,
# launches a fixture, calls a provider, or writes a remote application/DB.
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$destination=[IO.Path]::GetFullPath($EvidencePath)
if(Test-Path -LiteralPath $destination){throw 'PHASE10_UI_EVIDENCE_ALREADY_EXISTS'}
if(-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'PHASE10_UI_EVIDENCE_PARENT_REQUIRED'}
$sources=@(
 'apps/web/AGENTS.md','apps/web/package.json','apps/web/next.config.mjs',
 'apps/web/src/app/storefront/page.tsx','apps/web/src/components/storefront-overview.tsx',
 'apps/web/src/components/storefront-operations.tsx','apps/web/src/lib/storefront-display.ts',
 'apps/web/src/types/storefront.ts','apps/web/src/components/app-shell.tsx',
 'apps/web/src/app/uploads/page.tsx','apps/web/src/app/sales/page.tsx',
 'apps/web/src/app/login/page.tsx','apps/web/src/features/auth/auth-provider.ts',
 'apps/web/src/features/auth/auth-context.tsx','apps/web/src/features/auth/session-activity.ts',
 'apps/web/src/lib/api.ts','apps/web/src/components/storefront-overview.test.tsx',
 'apps/web/src/lib/storefront-display.test.ts','apps/web/tsconfig.storefront-test.json'
)
function Get-Phase10UiSourceManifest {
 return @($sources|ForEach-Object {
  $item=Get-Item -LiteralPath (Join-Path $repo $_)
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'PHASE10_UI_SOURCE_TYPE'}
  @{path=$_;sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
 })
}
$started=[DateTimeOffset]::UtcNow.ToString('o')
$checks=@()
Push-Location $repo
try {
 $head=(& git rev-parse HEAD).Trim()
 if($LASTEXITCODE -ne 0 -or $head -cnotmatch '^[a-f0-9]{40,64}$'){throw 'PHASE10_UI_HEAD_REQUIRED'}
 $before=Get-Phase10UiSourceManifest
 $lint=@(& npm.cmd --workspace '@meta-ads-performance/web' run lint 2>&1|ForEach-Object {$_.ToString()})
 $lintExit=$LASTEXITCODE
 $checks+=@{name='web-lint';command='npm.cmd --workspace @meta-ads-performance/web run lint';exitCode=$lintExit;status=$(if($lintExit -eq 0){'PASS'}else{'FAIL'});output=@($lint)}
 $tests=@(& node node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.storefront-test.json --test apps/web/src/lib/storefront-display.test.ts apps/web/src/components/storefront-overview.test.tsx 2>&1|ForEach-Object {$_.ToString()})
 $testExit=$LASTEXITCODE
 $checks+=@{name='storefront-source-render';command='node node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.storefront-test.json --test apps/web/src/lib/storefront-display.test.ts apps/web/src/components/storefront-overview.test.tsx';exitCode=$testExit;status=$(if($testExit -eq 0){'PASS'}else{'FAIL'});output=@($tests)}
 $after=Get-Phase10UiSourceManifest
 $sourceUnchanged=($before|ConvertTo-Json -Depth 5 -Compress) -ceq ($after|ConvertTo-Json -Depth 5 -Compress)
 $result=@{
  kind='PHASE10_UI_LOCAL_CHECKS';startedAt=$started;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');head=$head
  sourceFiles=$after;sourceUnchanged=$sourceUnchanged;checks=$checks
  classification='LOCAL_TYPES_AND_SYNTHETIC_RENDER';actualBrowser=$false;actualLogin=$false;actualServerStorage=$false;providerRequests=0;remoteWrites=0
  notVerified=@('fixed-candidate-image','actual-supabase-login','session-refresh-and-logout','real-role-matrix','invitation-flow','csv-cafe24-coupang-persistence','reports','mixed-collection-browser-load')
 }
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 10))
 $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try {$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 if(-not $sourceUnchanged -or $lintExit -ne 0 -or $testExit -ne 0){exit 1}
 Write-Output (@{kind=$result.kind;status='PASS';actualBrowser=$false;actualLogin=$false;sourceUnchanged=$sourceUnchanged;evidence=$destination}|ConvertTo-Json -Compress)
} finally {Pop-Location}
