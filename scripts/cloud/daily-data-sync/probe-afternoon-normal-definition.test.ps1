Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
. "$PSScriptRoot/probe-afternoon-normal-definition.ps1" -ProbeApproved:$true
if(-not $NormalProbeApproved){throw 'approval-import-clobbered'}
$sql=Get-Phase08NormalDefinitionBaselineSql;if(-not $sql.StartsWith('BEGIN READ ONLY;') -or $sql -notmatch '2026-10-14T17:00:00Z' -or $sql -notmatch '2026-10-14T17:01:00Z' -or $sql -notmatch '2026-10-14T17:02:00Z' -or $sql -match '2026-10-15T0[67]:' -or $sql -notmatch 'normalProfileVerified'){throw 'normal-sql'}
$body=@{code='RUN_LIMIT_EXCEEDED';message='The sync request cannot be completed.';details=$null;requestId='11111111-1111-4111-8111-111111111111'}|ConvertTo-Json -Compress
$response=@{StatusCode=400;Content=$body;Headers=@{'Cache-Control'='private, no-store'}};$token=[Convert]::ToBase64String([byte[]](1..32));$out=Assert-Phase08NormalLoadedResponse $response $token;if(-not $out.normalDefinitionLoaded -or $out.Count -ne 4){throw 'normal-response'}
foreach($mode in @('edge-one-field','raw-extra','wrong-message','wrong-code','bad-id','cacheable','stale-200','bad-details')){
 $value=$body|ConvertFrom-Json -AsHashtable;$r=@{StatusCode=400;Content=$body;Headers=@{'Cache-Control'='no-store'}}
 switch($mode){edge-one-field{$value=@{code='RUN_LIMIT_EXCEEDED'}};raw-extra{$value['raw']='SYNTHETIC_PRIVATE'};wrong-message{$value.message='SYNTHETIC_PRIVATE'};wrong-code{$value.code='FIELD_UNSUPPORTED'};bad-id{$value.requestId='SYNTHETIC_PRIVATE'};cacheable{$r.Headers['Cache-Control']='public'};stale-200{$r.StatusCode=200};bad-details{$value.details=@{raw='SYNTHETIC_PRIVATE'}}}
 $r.Content=$value|ConvertTo-Json -Compress -Depth 5;$failed=$false;try{$null=Assert-Phase08NormalLoadedResponse $r $token}catch{$failed=$true};if(-not $failed){throw 'negative'}
}
$baseline=@{identityVerified=$true;stopped=$true;normalProfileVerified=$true;liveLeases=[long]0;digest=('a'*32)};if((ConvertTo-Phase08NormalDefinitionBaseline @([pscustomobject]$baseline)) -cne ('a'*32)){throw 'normal-baseline'}
$scope=@{collectionDataWrites=[long]0;databaseWritesScope='COLLECTION_DATA_ONLY';transportSecurityWritesExpected=$true};Assert-Phase08CompleteCollectionWriteScope $scope
foreach($mode in @('legacy','wrong-scope','false','bool-string','count-string','nonzero','missing')){
 $bad=$scope.Clone();switch($mode){legacy{$bad['databaseWrites']=0};wrong-scope{$bad.databaseWritesScope='ALL_DATABASE'};false{$bad.transportSecurityWritesExpected=$false};bool-string{$bad.transportSecurityWritesExpected='true'};count-string{$bad.collectionDataWrites='0'};nonzero{$bad.collectionDataWrites=1};missing{$bad.Remove('databaseWritesScope')}}
 $failed=$false;try{Assert-Phase08CompleteCollectionWriteScope $bad}catch{$failed=$true};if(-not $failed){throw 'scope-negative'}
}
@{state='NORMAL_LOADED_DEFINITION_TESTS_PASSED';cases=20;remoteCalls=0}|ConvertTo-Json -Compress
