# Root-only existing new08 relay source update; no secret writes.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. "$PSScriptRoot/protected-context.ps1"
$headers=$null;$token=$null;$stage='BASELINE'
try {
 $token=Get-Phase08SupabaseCredential;$headers=@{Authorization=('Bearer '+$token)}
 $base='https://api.supabase.com/v1/projects/ehnfrrmbkvlsbpvqcvkr'
 function Get-RelayMetadata([string]$Path){
  $r=Invoke-WebRequest -Uri ($base+$Path) -Headers $headers -Method Get -MaximumRedirection 0 -TimeoutSec 30 -SkipHttpErrorCheck
  if([int]$r.StatusCode -ne 200 -or [Text.Encoding]::UTF8.GetByteCount($r.Content) -gt 1048576){throw 'metadata'}
  return ($r.Content|ConvertFrom-Json -AsHashtable -DateKind String -Depth 15)
 }
 $functions=@(Get-RelayMetadata '/functions');$secrets=@(Get-RelayMetadata '/secrets')
 if($functions.Count -ne 1 -or $functions[0].id -cne '42f4d9e1-eddb-4b00-b574-399a489f78b4' -or $functions[0].slug -cne 'phase08-scheduled-relay' -or $functions[0].version -ne 1 -or $functions[0].status -cne 'ACTIVE' -or $functions[0].verify_jwt -ne $false -or $functions[0].ezbr_sha256 -cne 'e4aa0eb68513b50380f45272796d1c15f9345e3591bb3bbc0f6849e837c262a6' -or $secrets.Count -ne 9){throw 'baseline'}
 $stage='SNAPSHOT'
 $destination='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-20261015-v2'
 if(Test-Path -LiteralPath $destination){throw 'snapshot-exists'}
 $expected=@{'index.ts'='23e837fe985be82c70a5da0a83e3a68ceae634c6073abf0a193dbec4e2df24f7';'relay.mjs'='408dcb0cf05d4f1b8f699a81025454d4ce7cb4a3062f47f17821d449b714cd88'}
 $null=[IO.Directory]::CreateDirectory($destination);$manifest=@()
 foreach($name in @('index.ts','relay.mjs')){
  $source=Join-Path $PSScriptRoot ('../../../supabase/functions/phase08-scheduled-relay/'+$name);$item=Get-Item -LiteralPath $source
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 65536){throw 'source'}
  $dest=Join-Path $destination $name;[IO.File]::Copy($source,$dest,$false)
  $hash=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
  if($hash -cne $expected[$name]){throw 'source-pin'}
  $manifest+=[ordered]@{path=$name;sha256=$hash}
 }
 $manifestJson=ConvertTo-Json -InputObject $manifest -Compress
 $sourceSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($manifestJson))).ToLowerInvariant()
 if($sourceSha -cne '7e6236640c84d4dcfb417ef5fdc9a22ec770fabe587955339ce28ddc8ee77dc2'){throw 'manifest-pin'}
 [IO.File]::WriteAllText((Join-Path $destination 'source-manifest.json'),$manifestJson,[Text.UTF8Encoding]::new($false))
 $stage='DEPLOY'
 $form=@{file=@((Get-Item -LiteralPath (Join-Path $destination 'index.ts')),(Get-Item -LiteralPath (Join-Path $destination 'relay.mjs')));metadata='{"entrypoint_path":"index.ts","name":"phase08-scheduled-relay","verify_jwt":false}'}
 $reply=Invoke-WebRequest -Uri ($base+'/functions/deploy?slug=phase08-scheduled-relay') -Headers $headers -Method Post -Form $form -MaximumRedirection 0 -TimeoutSec 60 -SkipHttpErrorCheck
 if([int]$reply.StatusCode -ne 201){throw 'outcome'}
 $deployed=$reply.Content|ConvertFrom-Json -AsHashtable -Depth 15
 $after=@(Get-RelayMetadata '/functions');$afterSecrets=@(Get-RelayMetadata '/secrets')
 if($deployed.id -cne $functions[0].id -or $deployed.slug -cne 'phase08-scheduled-relay' -or $deployed.version -ne 2 -or $deployed.status -cne 'ACTIVE' -or $deployed.verify_jwt -isnot [bool] -or $deployed.verify_jwt -ne $false -or $deployed.ezbr_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $after.Count -ne 1 -or $after[0].id -cne $deployed.id -or $after[0].slug -cne $deployed.slug -or $after[0].status -cne 'ACTIVE' -or $after[0].verify_jwt -isnot [bool] -or $after[0].verify_jwt -ne $false -or $after[0].version -ne 2 -or $after[0].ezbr_sha256 -cne $deployed.ezbr_sha256 -or $afterSecrets.Count -ne 9){throw 'readback'}
 foreach($old in $secrets){$match=@($afterSecrets|Where-Object{$_.name -ceq $old.name});if($match.Count -ne 1 -or $match[0].value -cne $old.value){throw 'secret-preservation'}}
 $evidence=@{classification='ACTUAL_ISOLATED_10AM_RELAY_UPDATE';projectRef='ehnfrrmbkvlsbpvqcvkr';id=$deployed.id;version=$deployed.version;bundleSha=$deployed.ezbr_sha256;manifest=$manifest;secretWrites=0;allNineSecretDigestsPreserved=$true;providerCalls=0;observedAt=[DateTimeOffset]::UtcNow.ToString('o')}
 $path='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/edge-relay-10am-actual-20261015.json'
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($evidence|ConvertTo-Json -Depth 8));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $evidence|ConvertTo-Json -Compress -Depth 8
}catch{@{state='PHASE08_10AM_RELAY_UPDATE_FAILED';stage=$stage;inspectBeforeRetry=$true;rawErrorSuppressed=$true}|ConvertTo-Json -Compress;exit 1}
finally{if($headers){$headers.Clear()};$token=$null;$headers=$null;$secrets=$null;$afterSecrets=$null;$reply=$null}
