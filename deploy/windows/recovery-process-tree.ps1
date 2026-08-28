#Requires -Version 7.2

if (-not('RecoveryProcessSnapshot' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class RecoveryProcessSnapshot {
  const uint TH32CS_SNAPPROCESS = 0x00000002;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  struct PROCESSENTRY32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)] static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)] static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Descendants(int root) {
    var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) throw new Win32Exception();
    try {
      var parents = new Dictionary<int,int>(); var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(entry);
      if (!Process32First(snapshot, ref entry)) throw new Win32Exception();
      do { parents[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID; entry.dwSize = (uint)Marshal.SizeOf(entry); } while (Process32Next(snapshot, ref entry));
      var result = new HashSet<int>(); result.Add(root); bool changed;
      do { changed = false; foreach (var pair in parents) if (result.Contains(pair.Value) && result.Add(pair.Key)) changed = true; } while (changed);
      var values = new int[result.Count]; result.CopyTo(values); return values;
    } finally { CloseHandle(snapshot); }
  }
}
'@
}

function Get-RecoveryProcessTreeIds([int]$RootProcessId) {
  return @([RecoveryProcessSnapshot]::Descendants($RootProcessId))
}

function Stop-VerifiedRecoveryProcessTree([Diagnostics.Process]$Process, [ValidateRange(100,10000)][int]$MaximumWaitMilliseconds = 5000) {
  if ($null -eq $Process) { return }
  $treeIds = [Collections.Generic.HashSet[int]]::new()
  foreach ($id in @(Get-RecoveryProcessTreeIds $Process.Id)) { [void]$treeIds.Add([int]$id) }
  if (-not $Process.HasExited) {
    try { $Process.Kill($true) } catch { throw 'RECOVERY_KIT_TOOL_TREE_KILL_FAILED' }
  }
  foreach ($id in @(Get-RecoveryProcessTreeIds $Process.Id)) { [void]$treeIds.Add([int]$id) }
  if (-not $Process.WaitForExit($MaximumWaitMilliseconds) -or -not $Process.HasExited) { throw 'RECOVERY_KIT_TOOL_TREE_EXIT_UNCONFIRMED' }
  foreach ($id in @(Get-RecoveryProcessTreeIds $Process.Id)) { [void]$treeIds.Add([int]$id) }
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  do {
    $remaining = @($treeIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { return }
    [Threading.Thread]::Sleep(25)
  } while ($deadline.ElapsedMilliseconds -lt $MaximumWaitMilliseconds)
  throw 'RECOVERY_KIT_TOOL_DESCENDANT_EXIT_UNCONFIRMED'
}
