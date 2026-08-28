#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$HostBundleRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($HostBundleRoot)
$item=Get-Item -LiteralPath $root -Force
if(-not$item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)){throw 'WINDOWS_HOST_BUNDLE_ROOT_INVALID'}
$files=@(Get-ChildItem -LiteralPath $root -File -Filter '*.ps1'|Sort-Object Name)
if($files.Count-lt1){throw 'WINDOWS_HOST_BUNDLE_SCRIPTS_MISSING'}
foreach($file in $files){
  if($file.Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'WINDOWS_HOST_BUNDLE_REPARSE_REJECTED'}
  $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
  if(@($errors).Count){throw 'WINDOWS_HOST_BUNDLE_PARSE_FAILED'}
}
[pscustomobject]@{result='PASS';parser='System.Management.Automation.Language.Parser';scriptCount=$files.Count}|ConvertTo-Json -Compress
