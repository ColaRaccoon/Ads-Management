# Root-only one-time new isolated relay deployment. Existing function/custom names reject.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/scheduler-live-helpers.ps1"
. "$PSScriptRoot/relay-protected-context.ps1"
Import-Phase08SchedulerChildDefinitions
$context=$null;$password=$null;$headers=$null;$token=$null;$payload=$null;$stage='PREFLIGHT'
try {
 $pins=Get-Phase08SchedulerPins;$context=Read-Phase08ProtectedJson
 Assert-Phase08SchedulerContext $context $pins
 $graph=Get-Phase08SchedulerGraphState $context $pins
 if(-not $graph.scheduleEnabled -or $graph.appSchedules.Count -ne 3){throw 'live-graph'}
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 $base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
 function Read-Phase08RelayMetadata([string]$Path){
  $reply=Invoke-WebRequest -Uri ($base+$Path) -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$reply.StatusCode -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($reply.Content) -gt 1048576){throw 'metadata'}
  return ($reply.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15)
 }
 if(@(Read-Phase08RelayMetadata '/functions').Count -ne 0){throw 'existing-function'}
 $before=@(Read-Phase08RelayMetadata '/secrets')
 $defaults=@('SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_PUBLISHABLE_KEYS','SUPABASE_SECRET_KEYS','SUPABASE_JWKS','SUPABASE_DB_URL','SUPABASE_URL')
 if($before.Count -ne 7 -or @($before|Where-Object{$_.name -cnotin $defaults}).Count -ne 0 -or @($before.name|Sort-Object -Unique).Count -ne 7){throw 'secret-baseline'}
 $stage='SOURCE_SNAPSHOT'
 $destination='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v1'
 if(Test-Path -LiteralPath $destination){throw 'snapshot-exists'}
 $expected=@{ 'index.ts'='23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7';'relay.mjs'='9eed72203282a52dd96b51b9f66cd4c2882affb3166dab5ef79dcd90caa28382' }
 $manifest=@()
 foreach($name in @('index.ts','relay.mjs')){
  $source=Join-Path $PSScriptRoot ('../../../supabase/functions/phase08-scheduled-relay/'+$name)
  $item=Get-Item -LiteralPath $source
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536 -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected[$name]){throw 'source-pin'}
 }
 $null=[IO.Directory]::CreateDirectory($destination)
 foreach($name in @('index.ts','relay.mjs')){
  $source=Join-Path $PSScriptRoot ('../../../supabase/functions/phase08-scheduled-relay/'+$name);$dest=Join-Path $destination $name
  [IO.File]::Copy($source,$dest,$false)
  $hash=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
  if($hash -cne $expected[$name]){throw 'snapshot-pin'}
  $manifest += [ordered]@{path=$name;sha256=$hash}
 }
 $manifestJson=ConvertTo-Json -InputObject $manifest -Compress
 $sourceSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($manifestJson))).ToLowerInvariant()
 if($sourceSha -cne '207bd3040b55e01d01531636b7cf42dd64bcef3326320853e750a664a83863b9'){throw 'manifest-pin'}
 [IO.File]::WriteAllText((Join-Path $destination 'source-manifest.json'),$manifestJson,[Text.UTF8Encoding]::new($false))
 $password=Read-Phase08RelayProtectedPassword
 if($password -ceq $context.env.DAILY_SYNC_MACHINE_TOKEN){throw 'independent-secret'}
 $stage='PROJECT_SECRETS'
 $payload=@(@{name='PHASE08_RELAY_BASIC_PASSWORD';value=$password},@{name='PHASE08_RELAY_MACHINE_TOKEN';value=$context.env.DAILY_SYNC_MACHINE_TOKEN})|ConvertTo-Json -Compress
 $reply=Invoke-WebRequest -Uri ($base+'/secrets') -Headers $headers -Method Post -ContentType 'application/json' -Body $payload -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
 $payload=$null
 if([int]$reply.StatusCode -ne 201){throw 'secret-write-outcome'}
 $after=@(Read-Phase08RelayMetadata '/secrets')
 if($after.Count -ne 9){throw 'secret-count'}
 foreach($old in $before){$match=@($after|Where-Object{$_.name -ceq $old.name});if($match.Count -ne 1 -or $match[0].value -cne $old.value){throw 'existing-secret-changed'}}
 foreach($secret in @(@{name='PHASE08_RELAY_BASIC_PASSWORD';value=$password},@{name='PHASE08_RELAY_MACHINE_TOKEN';value=$context.env.DAILY_SYNC_MACHINE_TOKEN})){
  $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($secret.value))).ToLowerInvariant()
  $match=@($after|Where-Object{$_.name -ceq $secret.name});if($match.Count -ne 1 -or $match[0].value -cne $hash){throw 'secret-digest'}
 }
 $stage='EDGE_DEPLOY'
 $form=@{file=@((Get-Item -LiteralPath (Join-Path $destination 'index.ts')),(Get-Item -LiteralPath (Join-Path $destination 'relay.mjs')));metadata='{"entrypoint_path":"index.ts","name":"phase08-scheduled-relay","verify_jwt":false}'}
 $reply=Invoke-WebRequest -Uri ($base+'/functions/deploy?slug=phase08-scheduled-relay') -Headers $headers -Method Post -Form $form -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
 if([int]$reply.StatusCode -ne 201){throw 'deploy-outcome'}
 $deployed=$reply.Content|ConvertFrom-Json -AsHashtable -Depth 15
 if($deployed.id -isnot [string] -or $deployed.id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $deployed.slug -cne 'phase08-scheduled-relay' -or $deployed.status -cne 'ACTIVE' -or ($deployed.version -isnot [int] -and $deployed.version -isnot [long]) -or $deployed.version -ne 1 -or $deployed.verify_jwt -isnot [bool] -or $deployed.verify_jwt -ne $false -or $deployed.ezbr_sha256 -isnot [string] -or $deployed.ezbr_sha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'deploy-metadata'}
 $readback=@(Read-Phase08RelayMetadata '/functions')
 if($readback.Count -ne 1 -or $readback[0].id -cne $deployed.id -or $readback[0].slug -cne $deployed.slug -or $readback[0].status -cne $deployed.status -or $readback[0].verify_jwt -isnot [bool] -or $readback[0].verify_jwt -ne $deployed.verify_jwt -or ($readback[0].version -isnot [int] -and $readback[0].version -isnot [long]) -or $readback[0].version -ne $deployed.version -or $readback[0].ezbr_sha256 -cne $deployed.ezbr_sha256){throw 'deploy-identity'}
 $evidence=@{classification='ACTUAL_NEW_ISOLATED_EDGE_RELAY_DEPLOY';projectRef='ehnfrrmbkvlsbpvqcvkr';slug=$deployed.slug;id=$deployed.id;version=$deployed.version;status=$deployed.status;verifyJwt=$deployed.verify_jwt;bundleSha=$deployed.ezbr_sha256;sourceSha=$sourceSha;sourceSnapshot=$destination;newProjectSecrets=2;oldDefaultsPreserved=7;providerCalls=0;appDeployments=0;cronChanges=0;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
 $out='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-deploy-actual-20261015.json'
 $stream=[IO.File]::Open($out,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($evidence|ConvertTo-Json -Depth 8));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $evidence|ConvertTo-Json -Compress
}catch{@{state='PHASE08_RELAY_DEPLOY_FAILED';stage=$stage;inspectBeforeRetry=$true;retryPerformed=$false;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$context=$null;$password=$null;$headers=$null;$token=$null;$payload=$null;$before=$null;$after=$null;$secret=$null;$form=$null;$reply=$null;$deployed=$null;$readback=$null}
