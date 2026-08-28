#Requires -Version 7.2
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'nas-identity.ps1')
$localhostRejected=$false;try{Get-StableRemoteNasIdentity 'localhost' 'recovery'|Out-Null}catch{$localhostRejected=$_.Exception.Message-eq'NAS_SERVER_RESOLVES_TO_CURRENT_HOST'}
$hostnameRejected=$false;try{Get-StableRemoteNasIdentity ([Net.Dns]::GetHostName()) 'recovery'|Out-Null}catch{$hostnameRejected=$_.Exception.Message-eq'NAS_SERVER_RESOLVES_TO_CURRENT_HOST'}
if(-not$localhostRejected-or-not$hostnameRejected){throw 'NAS_LOCAL_ALIAS_NEGATIVE_TEST_FAILED'}
[pscustomobject]@{result='PASS';localhostRejected=$true;currentHostnameRejected=$true}|ConvertTo-Json -Compress
