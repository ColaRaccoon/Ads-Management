#Requires -Version 7.2

function Get-NasIdentitySha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant()) } finally { $sha.Dispose() }
}

function Get-NasAddressKey([Net.IPAddress]$Address) {
  return ([string][int]$Address.AddressFamily) + ':' + ([BitConverter]::ToString($Address.GetAddressBytes()).Replace('-','').ToLowerInvariant())
}

function Get-StableRemoteNasIdentity([string]$Server, [string]$Share) {
  if (-not $Server -or -not $Share) { throw 'NAS_REMOTE_IDENTITY_ARGUMENT_REQUIRED' }
  $normalizedServer = $Server.Trim().Trim('[',']').ToLowerInvariant()
  $normalizedShare = $Share.Trim().ToLowerInvariant()
  $localNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in @('.', 'localhost', 'localhost.localdomain', $env:COMPUTERNAME, [Net.Dns]::GetHostName())) {
    if ($name) { [void]$localNames.Add($name.TrimEnd('.')) }
  }
  try {
    $localEntry = [Net.Dns]::GetHostEntry([Net.Dns]::GetHostName())
    if ($localEntry.HostName) { [void]$localNames.Add($localEntry.HostName.TrimEnd('.')) }
    foreach ($alias in @($localEntry.Aliases)) { if ($alias) { [void]$localNames.Add($alias.TrimEnd('.')) } }
  } catch { throw 'NAS_LOCAL_IDENTITY_UNAVAILABLE' }
  if ($localNames.Contains($normalizedServer.TrimEnd('.'))) { throw 'NAS_SERVER_RESOLVES_TO_CURRENT_HOST' }

  try { $remoteAddresses = @([Net.Dns]::GetHostAddresses($normalizedServer)) } catch { throw 'NAS_REMOTE_IDENTITY_UNRESOLVED' }
  if ($remoteAddresses.Count -eq 0) { throw 'NAS_REMOTE_IDENTITY_UNRESOLVED' }
  try { $localAddresses = @(Get-NetIPAddress -ErrorAction Stop | ForEach-Object { [Net.IPAddress]::Parse(([string]$_.IPAddress).Split('%')[0]) }) } catch { throw 'NAS_LOCAL_INTERFACE_IDENTITY_UNAVAILABLE' }
  $localKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($address in $localAddresses) { [void]$localKeys.Add((Get-NasAddressKey $address)) }
  $remoteKeys = @($remoteAddresses | ForEach-Object {
    if ([Net.IPAddress]::IsLoopback($_) -or $localKeys.Contains((Get-NasAddressKey $_))) { throw 'NAS_SERVER_RESOLVES_TO_CURRENT_HOST' }
    Get-NasAddressKey $_
  } | Sort-Object -Unique)
  $digest = Get-NasIdentitySha256 (@('nas-remote-v1', $normalizedServer, $normalizedShare) + $remoteKeys -join "`n")
  return [pscustomobject]@{ Server = $normalizedServer; Share = $normalizedShare; AddressCount = $remoteKeys.Count; IdentitySha256 = $digest; LocalAliasRejected = $true }
}
