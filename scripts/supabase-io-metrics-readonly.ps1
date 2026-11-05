param([Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'cloud/daily-data-sync/protected-context.ps1')
$credential=$null;$headers=$null;$reply=$null
try {
  if(Test-Path -LiteralPath $OutputPath){throw 'OUTPUT_ALREADY_EXISTS'}
  $credential=Get-Phase08SupabaseCredential
  $headers=@{Authorization=('Bearer '+$credential)}
  $reply=Invoke-WebRequest -Uri 'https://api.supabase.com/v1/projects/iygjmosbelbosfxidqxv/analytics/endpoints/metrics' -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 25 -SkipHttpErrorCheck
  $samples=@()
  if([int]$reply.StatusCode -eq 200){
    foreach($line in ($reply.Content -split "`n")){
      if($line -match '^(node_disk_(?:reads_completed_total|writes_completed_total|read_bytes_total|written_bytes_total|io_time_seconds_total|read_time_seconds_total|write_time_seconds_total|io_time_weighted_seconds_total))\{([^}]+)\}\s+([-+eE.0-9]+)(?:\s+\d+)?\s*$'){
        $metric=$Matches[1];$labels=$Matches[2];$value=[double]::Parse($Matches[3],[Globalization.CultureInfo]::InvariantCulture)
        if($labels -match '(?:^|,)device="([a-zA-Z0-9_-]+)"' -and [double]::IsFinite($value)){
          $samples+=@{metric=$metric;device=$Matches[1];value=$value}
        }
      }
    }
  }
  $result=[ordered]@{projectRef='iygjmosbelbosfxidqxv';observedAt=[DateTime]::UtcNow.ToString('o');httpStatus=[int]$reply.StatusCode;remoteWrites=0;samples=$samples}
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath
  @{httpStatus=[int]$reply.StatusCode;diskSamples=$samples.Count;output=$OutputPath}|ConvertTo-Json -Compress
} finally {if($headers){$headers.Clear()};$credential=$null;$headers=$null;$reply=$null;$line=$null}
