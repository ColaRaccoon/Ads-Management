$ErrorActionPreference='Stop'
. "$PSScriptRoot/phase10-cafe-epoch-live-local-v3-20261021.ps1" -Mode Parse
$root='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/cafe-epoch-live-local-'+[Guid]::NewGuid().ToString()
$before=$env:CAFE_EPOCH_SYNTHETIC_PRIVATE_ROOT;$exit=1
try{
 New-CafeEpochLivePrivate $root;$env:CAFE_EPOCH_SYNTHETIC_PRIVATE_ROOT=$root;$env:TSX_TSCONFIG_PATH='apps/api/tsconfig.json'
 & 'C:/Program Files/nodejs/node.exe' --import tsx --test "$PSScriptRoot/phase10-cafe-epoch-live-v4-20261021.native.test.mjs";$exit=$LASTEXITCODE
}finally{
 $privacy=Complete-CafeEpochLivePrivacy $root;$env:CAFE_EPOCH_SYNTHETIC_PRIVATE_ROOT=$before
 [ordered]@{kind='CAFE_EPOCH_LIVE_NATIVE_SYNTHETIC_PRIVACY';syntheticProviderOnly=$true;realProviderGets=0;remoteWrites=0;privateRoot=$root;privacy=$privacy;nodeExit=$exit}|ConvertTo-Json -Depth 8 -Compress
}
exit $exit
