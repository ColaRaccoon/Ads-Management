param([string]$Candidate='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261019',[string]$ExpectedCommit='3b593159f3f2eb7954378a8d605e12ba63fc8567',[string]$EvidenceDirectory='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/evidence')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=$EvidenceDirectory
[void][IO.Directory]::CreateDirectory($root)
$npm='C:/Users/seong/AppData/Local/npm-cache/_npx/4b0cc92362cfffad/node_modules/npm/bin/npm-cli.js'
$receipt=Join-Path $root 'local-checks.json'
if(Test-Path -LiteralPath $receipt){throw 'CREATE_NEW_RECEIPT_REQUIRED'}
$start=[DateTimeOffset]::UtcNow.ToString('o');$results=@()
Push-Location -LiteralPath $Candidate
try {
 $sha=(& git rev-parse HEAD).Trim()
 if($sha -cne $ExpectedCommit){throw 'CANDIDATE_IDENTITY'}
 foreach($name in @('prisma:generate','prisma:validate','lint','test','build')) {
  $log=Join-Path $root ($name.Replace(':','-')+'.log')
  if(Test-Path -LiteralPath $log){throw 'LOG_EXISTS'}
  $sw=[Diagnostics.Stopwatch]::StartNew()
  & node $npm run $name *> $log
  $code=$LASTEXITCODE;$sw.Stop()
  $results+=@{command="npm.cmd run $name";npmVersion='10.9.4';exitCode=$code;status=if($code -eq 0){'PASS'}else{'FAIL'};elapsedMs=$sw.ElapsedMilliseconds;log=$log}
 }
 $out=@{kind='PHASE10_FIXED_CANDIDATE_LOCAL_CHECKS';commit=$sha;startedAt=$start;endedAt=[DateTimeOffset]::UtcNow.ToString('o');results=$results;actualBrowser=$false;cloudImage=$false;remoteWrites=0}
 $stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($out|ConvertTo-Json -Depth 12));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
 $out|ConvertTo-Json -Depth 12
}finally{Pop-Location}
