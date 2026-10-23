param([Parameter(Mandatory)][switch]$FreshVerified,[switch]$TargetReadOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
. 'C:/Users/seong/Desktop/workspace/Meta-Ads-Performance-security-rbac/보안단계별적용/증거/0908-staging-db-roles/phase2-secret-lib.ps1'
$runtime=$null;$source=$null;$export=$null;$configuration=$null;$seedInput=$null;$phase08Stage='PRECHECK'
function Test-Phase08BusinessDiagnostic($stage,$code) {
  return ($stage -is [string] -and $stage.Length -le 32 -and $stage -cin @('INPUT','TARGET','CONFIGURATION','RUNTIME_IDENTITY','FRESH_COUNTS','SEED','READBACK') -and
    $code -is [string] -and $code.Length -le 64 -and ($code -cmatch '^P\d{4}$' -or $code -cin @('UNCLASSIFIED','TARGET','TARGET_CERTIFICATE_REJECTED','IDENTITY','INPUT_BOUND',
      'FRESH_CONFIGURATION_REQUIRED','READBACK','CONFIGURATION_REQUIRED','CONFIGURATION_INVALID','CONFIGURATION_INVENTORY_MISMATCH',
      'CONFIGURATION_FINGERPRINT_MISMATCH','CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED','CONFIGURATION_SEED_STATE_MISMATCH')))
}
function Get-Phase08BusinessSafeErrorType($value) {
  if($value -is [string] -and $value.Length -le 64 -and $value -cin @('Error','TypeError','SyntaxError','PrismaClientInitializationError',
    'PrismaClientKnownRequestError','PrismaClientValidationError','PrismaClientUnknownRequestError','PrismaClientRustPanicError')){return $value}
  return 'UNCLASSIFIED'
}
function Invoke-Phase08ConfigurationChild([string]$script,$material,[string[]]$extra=@()) {
  $child=$null;$body=$null;$raw=$null;$discard=$null
  try {
    $body=$material|ConvertTo-Json -Depth 24 -Compress
    if([Text.Encoding]::UTF8.GetByteCount($body) -gt 1048576){throw 'input-bound'}
    if(-not ('Phase08BoundedConfigurationIo' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public static class Phase08BoundedConfigurationIo {
 public static async Task<string> ReadAsync(StreamReader reader, int maximum) {
  var buffer=new char[8192]; var value=new StringBuilder();
  while(true) {
   int count=await reader.ReadAsync(buffer,0,buffer.Length);
   if(count==0) return value.ToString();
   if(value.Length+count>maximum) throw new InvalidOperationException("OUTPUT_BOUND");
   value.Append(buffer,0,count);
  }
 }
}
'@
    }
    $psi=[Diagnostics.ProcessStartInfo]::new('C:/Program Files/nodejs/node.exe')
    $psi.WorkingDirectory='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance'
    $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
    $psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
    # The exporter fingerprints UTF-8 JSON. Windows process stream defaults can
    # decode Korean rule text with a legacy code page and silently change it.
    $phase08Utf8=[Text.UTF8Encoding]::new($false,$true)
    $psi.StandardInputEncoding=$phase08Utf8;$psi.StandardOutputEncoding=$phase08Utf8;$psi.StandardErrorEncoding=$phase08Utf8
    $psi.Environment.Clear()
    foreach($key in @('PATH','SystemRoot','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA')){if([Environment]::GetEnvironmentVariable($key)){$psi.Environment[$key]=[Environment]::GetEnvironmentVariable($key)}}
    $psi.Environment['TSX_TSCONFIG_PATH']='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/apps/api/tsconfig.json'
    if($script.EndsWith('.mjs')){$psi.ArgumentList.Add('--import');$psi.ArgumentList.Add('tsx')}
    $psi.ArgumentList.Add($script);foreach($argument in $extra){$psi.ArgumentList.Add($argument)}
    $watch=[Diagnostics.Stopwatch]::StartNew()
    $child=[Diagnostics.Process]::Start($psi)
    $outTask=[Phase08BoundedConfigurationIo]::ReadAsync($child.StandardOutput,1048576)
    $errorTask=[Phase08BoundedConfigurationIo]::ReadAsync($child.StandardError,16384)
    $writeTask=$child.StandardInput.WriteAsync($body)
    $remaining=[Math]::Max(0,60000-[int]$watch.ElapsedMilliseconds)
    if(-not $writeTask.Wait($remaining)){$child.Kill($true);throw 'bounded-input'}
    $flushTask=$child.StandardInput.FlushAsync()
    $remaining=[Math]::Max(0,60000-[int]$watch.ElapsedMilliseconds)
    if(-not $flushTask.Wait($remaining)){$child.Kill($true);throw 'bounded-input-flush'}
    $child.StandardInput.Close();$body=$null
    $remaining=[Math]::Max(0,60000-[int]$watch.ElapsedMilliseconds)
    if(-not $child.WaitForExit($remaining)){$child.Kill($true);throw 'bounded-child'}
    $raw=$outTask.GetAwaiter().GetResult();$discard=$errorTask.GetAwaiter().GetResult();$discard=$null
    if($child.ExitCode -ne 0 -or $raw.Length -gt 1048576){
      $failure=[Exception]::new('PHASE08_CONFIGURATION_CHILD_FAILED')
      try {
        $diagnostic=$raw|ConvertFrom-Json -ErrorAction Stop
        if($diagnostic.state -is [string] -and $diagnostic.state -ceq 'PHASE08_BUSINESS_CONFIGURATION_FAILED' -and
          (Test-Phase08BusinessDiagnostic $diagnostic.stage $diagnostic.code)) {
          $failure.Data['Stage']=$diagnostic.stage;$failure.Data['Code']=$diagnostic.code
          $failure.Data['ErrorType']=if($diagnostic.PSObject.Properties['errorType']){Get-Phase08BusinessSafeErrorType $diagnostic.errorType}else{'UNCLASSIFIED'}
        }
      } catch {}
      throw $failure
    }
    return ($raw|ConvertFrom-Json -AsHashtable -Depth 24 -DateKind String)
  } finally {
    $body=$null;$raw=$null;$discard=$null;$material=$null
    if($child){if(-not $child.HasExited){$child.Kill($true)};$child.Dispose()}
  }
}
try {
  if(-not $FreshVerified){throw 'fresh-proof'}
  $phase08Stage='PROTECTED_CONTEXT';$runtime=Read-Phase08ProtectedJson
  if($runtime.projectRef -cne 'ehnfrrmbkvlsbpvqcvkr' -or $runtime.serviceId -cne '4b30daa8-9333-46b7-ad89-cfd64ff5266c' -or
     $runtime.origin -cne 'https://phase08-daily-data-sync-production.up.railway.app' -or $runtime.env.SUPABASE_DATABASE_SCHEMA -cne 'phase08_meta_ads' -or
     $runtime.env.SUPABASE_DATABASE_RUNTIME_USER -cne 'phase08_runtime'){throw 'target'}
  if($TargetReadOnly) {
    $phase08Stage='READONLY_TARGET_DIAGNOSTIC'
    $result=Invoke-Phase08ConfigurationChild "$PSScriptRoot/seed-isolated-business-config.mjs" @{projectRef='ehnfrrmbkvlsbpvqcvkr';freshVerified=$true;databaseUrl=$runtime.env.DATABASE_URL} @('--diagnose-target')
    if($result.state -cne 'PHASE08_BUSINESS_TARGET_READONLY_VERIFIED'){throw 'diagnostic-outcome'}
    $result|ConvertTo-Json -Depth 5
    return
  }
  $proof=Invoke-Phase08Management -Action ReadOnlyQuery -Query "SELECT (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads')::int AS tables, (SELECT count(*) FROM phase08_meta_ads.products)::int AS products, (SELECT count(*) FROM phase08_meta_ads.product_cost_rules)::int AS costs, (SELECT count(*) FROM phase08_meta_ads.cafe24_product_rules)::int AS rules, (SELECT count(*) FROM phase08_meta_ads.cafe24_coupon_rules)::int AS coupons, (SELECT count(*) FROM phase08_meta_ads.source_connections)::int AS sources, (SELECT count(*) FROM phase08_meta_ads.source_connections WHERE id='0c35defe-45fc-4a54-bc79-704df7bca5b1'::uuid AND provider='CAFE24' AND external_account_id='didadi0729' AND shop_key='shop1' AND access_state='PENDING' AND enabled=false)::int AS pending_cafe, (SELECT count(*) FROM phase08_meta_ads.sync_runs)::int AS runs;"
  if($proof.tables -ne 68 -or $proof.products -ne 0 -or $proof.costs -ne 0 -or $proof.rules -ne 0 -or $proof.coupons -ne 0 -or $proof.sources -ne 3 -or $proof.pending_cafe -ne 1 -or $proof.runs -ne 0){throw 'fresh-baseline'}
  $phase08Stage='SOURCE_EXPORTER_PIN'
  $exporter='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/phase06-read-business-config.cjs'
  Assert-R2ANotReparsePoint $exporter
  if((Get-FileHash -LiteralPath $exporter -Algorithm SHA256).Hash -cne '0139FCBB7EF354492F6E1AEA5EA75D8A6B0545006A13FFE5E361E8133AB1F08C'){throw 'exporter-hash'}
  $protected='C:/Users/seong/AppData/Roaming/MetaAdsSecurity/production-app-runtime/railway-runtime.dpapi'
  Assert-R2ANotReparsePoint $protected;Assert-R2AUserSystemOnlyAcl $protected
  $phase08Stage='SOURCE_PROTECTED_READ'
  $source=(Unprotect-R2APlaintextSecret ([IO.File]::ReadAllText($protected)))|ConvertFrom-Json -AsHashtable
  if($source.SUPABASE_DATABASE_PROJECT_REF -cne 'iygjmosbelbosfxidqxv' -or $source.SUPABASE_DATABASE_SCHEMA -cne 'meta_ads' -or $source.SUPABASE_DATABASE_RUNTIME_USER -cne 'meta_ads_prod_runtime'){throw 'source-identity'}
  $exportInput=@{projectRef=$source.SUPABASE_DATABASE_PROJECT_REF;host='aws-1-ap-northeast-2.pooler.supabase.com';runtimeUser=$source.SUPABASE_DATABASE_RUNTIME_USER;databaseName='postgres';schema=$source.SUPABASE_DATABASE_SCHEMA;databaseUrl=$source.DATABASE_URL}
  $source=$null
  $phase08Stage='READONLY_SOURCE_EXPORT'
  $export=Invoke-Phase08ConfigurationChild $exporter $exportInput @('--export');$exportInput=$null
  if($export.readOnly -ne $true -or $export.source -cne 'CURRENT_INTERNAL_CONFIGURATION' -or $export.fingerprint -cnotmatch '^[a-f0-9]{64}$' -or
     $export.counts.products -ne 18 -or $export.counts.costRules -ne 24 -or $export.counts.productRules -ne 35 -or $export.counts.couponRules -ne 2){throw 'export-shape'}
  $configuration=@{observedAt=$export.observedAt;hash=$export.fingerprint;products=$export.configuration.products;costRules=$export.configuration.costRules;productRules=$export.configuration.productRules;couponRules=$export.configuration.couponRules}
  $seedInput=@{projectRef='ehnfrrmbkvlsbpvqcvkr';freshVerified=$true;databaseUrl=$runtime.env.DATABASE_URL;configuration=$configuration}
  $phase08Stage='FRESH_ISOLATED_SEED'
  $result=Invoke-Phase08ConfigurationChild "$PSScriptRoot/seed-isolated-business-config.mjs" $seedInput
  if($result.state -cne 'PHASE08_BUSINESS_CONFIGURATION_SEEDED' -or $result.configurationFingerprint -cne $configuration.hash){throw 'seed-outcome'}
  # Public summary only; raw internal rules and both database credentials remain in memory.
  $result|ConvertTo-Json -Depth 5
} catch {
  $validDiagnostic=Test-Phase08BusinessDiagnostic $_.Exception.Data['Stage'] $_.Exception.Data['Code']
  $safeStage=if($validDiagnostic){$_.Exception.Data['Stage']}else{$null}
  $safeCode=if($validDiagnostic){$_.Exception.Data['Code']}else{$null}
  @{state='PHASE08_BUSINESS_CONFIGURATION_FAILED';stage=$phase08Stage;childStage=$safeStage;code=$safeCode;childErrorType=(Get-Phase08BusinessSafeErrorType $_.Exception.Data['ErrorType']);exceptionType=$_.Exception.GetType().Name;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json;exit 1
}
finally {$runtime=$null;$source=$null;$export=$null;$configuration=$null;$seedInput=$null;$exportInput=$null;$proof=$null;$result=$null}
