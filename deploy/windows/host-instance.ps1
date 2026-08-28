#Requires -Version 7.2

function Get-HostInstanceSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()) } finally { $sha.Dispose() }
}

function Get-StableHostInstanceDigest {
  try { $machineGuid = [string](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name 'MachineGuid' -ErrorAction Stop) } catch { throw 'HOST_INSTANCE_IDENTITY_UNAVAILABLE' }
  $normalized = $machineGuid.Trim().ToLowerInvariant()
  if ($normalized -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'HOST_INSTANCE_IDENTITY_INVALID' }
  return Get-HostInstanceSha256 ("metaads-host-instance-v1`n$normalized")
}
