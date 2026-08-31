#Requires -Version 7.2

if (-not('RecoveryJobProcessFactory' -as [type])) {
  Add-Type -TypeDefinition @'
using Microsoft.Win32.SafeHandles;
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public sealed class RecoveryJobProcess : IDisposable {
  readonly SafeFileHandle job;
  public Process Process { get; private set; }
  public StreamReader StandardOutput { get; private set; }
  public StreamReader StandardError { get; private set; }
  public StreamWriter StandardInput { get; private set; }
  public int Id { get { return Process.Id; } }
  public bool HasExited { get { return Process.HasExited; } }
  public int ExitCode { get { return Process.ExitCode; } }

  internal RecoveryJobProcess(SafeFileHandle jobHandle, Process process, StreamReader stdout, StreamReader stderr, StreamWriter stdin) {
    job = jobHandle; Process = process; StandardOutput = stdout; StandardError = stderr; StandardInput = stdin;
  }

  public bool WaitForExit(int milliseconds) { return Process.WaitForExit(milliseconds); }

  public bool TerminateAndWait(int milliseconds) {
    if (!job.IsInvalid && !NativeRecoveryJob.TerminateJobObject(job, 1)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 5 && error != 6) throw new Win32Exception(error);
    }
    var watch = Stopwatch.StartNew();
    if (!Process.HasExited && !Process.WaitForExit(milliseconds)) return false;
    while (watch.ElapsedMilliseconds < milliseconds) {
      if (NativeRecoveryJob.ActiveProcessCount(job) == 0) return true;
      System.Threading.Thread.Sleep(10);
    }
    return NativeRecoveryJob.ActiveProcessCount(job) == 0;
  }

  public void Dispose() {
    try { StandardInput.Dispose(); } catch { }
    try { StandardOutput.Dispose(); } catch { }
    try { StandardError.Dispose(); } catch { }
    try { Process.Dispose(); } catch { }
    job.Dispose();
  }
}

internal static class NativeRecoveryJob {
  internal const uint CREATE_SUSPENDED = 0x00000004;
  internal const uint CREATE_NO_WINDOW = 0x08000000;
  internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  internal const uint STARTF_USESTDHANDLES = 0x00000100;
  internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
  internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
  internal const int JobObjectBasicAccountingInformation = 1;
  internal const int JobObjectExtendedLimitInformation = 9;

  [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars;
    public uint dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool QueryInformationJobObject(SafeFileHandle job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, int size);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] internal static extern bool CreateProcess(
    string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
    uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
  [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr attributeList);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool CloseHandle(IntPtr handle);

  internal static uint ActiveProcessCount(SafeFileHandle job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero)) throw new Win32Exception();
    return info.ActiveProcesses;
  }
}

public static class RecoveryJobProcessFactory {
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new[]{' ', '\t', '\n', '\v', '"'}) < 0) return value;
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(c);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }

  static IntPtr EnvironmentBlock(ProcessStartInfo info) {
    var text = new StringBuilder();
    foreach (var item in info.Environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)) {
      if (item.Key.IndexOf('=') >= 0 || item.Key.IndexOf('\0') >= 0 || (item.Value ?? "").IndexOf('\0') >= 0) throw new InvalidOperationException("RECOVERY_JOB_ENVIRONMENT_INVALID");
      text.Append(item.Key).Append('=').Append(item.Value ?? "").Append('\0');
    }
    text.Append('\0'); return Marshal.StringToHGlobalUni(text.ToString());
  }

  static void Pipe(out IntPtr parent, out IntPtr child, bool parentReads) {
    var attributes = new NativeRecoveryJob.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<NativeRecoveryJob.SECURITY_ATTRIBUTES>(), bInheritHandle = 1 };
    IntPtr read, write;
    if (!NativeRecoveryJob.CreatePipe(out read, out write, ref attributes, 0)) throw new Win32Exception();
    parent = parentReads ? read : write; child = parentReads ? write : read;
    if (!NativeRecoveryJob.SetHandleInformation(parent, NativeRecoveryJob.HANDLE_FLAG_INHERIT, 0)) {
      NativeRecoveryJob.CloseHandle(read); NativeRecoveryJob.CloseHandle(write); throw new Win32Exception();
    }
  }

  public static RecoveryJobProcess Start(ProcessStartInfo info) {
    if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) || info.UseShellExecute || !info.RedirectStandardOutput || !info.RedirectStandardError) throw new InvalidOperationException("RECOVERY_JOB_START_INFO_REJECTED");
    IntPtr outParent=IntPtr.Zero,outChild=IntPtr.Zero,errParent=IntPtr.Zero,errChild=IntPtr.Zero,inParent=IntPtr.Zero,inChild=IntPtr.Zero,environment=IntPtr.Zero,attributeList=IntPtr.Zero,handleList=IntPtr.Zero;
    IntPtr rawJob=IntPtr.Zero; var pi = new NativeRecoveryJob.PROCESS_INFORMATION(); SafeFileHandle job=null; Process process=null; StreamReader stdout=null,stderr=null; StreamWriter stdin=null; bool transferred=false;
    try {
      Pipe(out outParent,out outChild,true); Pipe(out errParent,out errChild,true); Pipe(out inParent,out inChild,false);
      rawJob = NativeRecoveryJob.CreateJobObject(IntPtr.Zero, null); if (rawJob == IntPtr.Zero) throw new Win32Exception();
      job = new SafeFileHandle(rawJob, true); rawJob=IntPtr.Zero;
      var limits = new NativeRecoveryJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags=NativeRecoveryJob.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!NativeRecoveryJob.SetInformationJobObject(job,NativeRecoveryJob.JobObjectExtendedLimitInformation,ref limits,(uint)Marshal.SizeOf<NativeRecoveryJob.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())) throw new Win32Exception();
      var command = new StringBuilder(Quote(Path.GetFullPath(info.FileName))); foreach (string argument in info.ArgumentList) command.Append(' ').Append(Quote(argument));
      IntPtr attributeBytes=IntPtr.Zero; NativeRecoveryJob.InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeBytes); if(attributeBytes==IntPtr.Zero)throw new Win32Exception();
      attributeList=Marshal.AllocHGlobal(attributeBytes); if(!NativeRecoveryJob.InitializeProcThreadAttributeList(attributeList,1,0,ref attributeBytes))throw new Win32Exception();
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handleList,0,inChild);Marshal.WriteIntPtr(handleList,IntPtr.Size,outChild);Marshal.WriteIntPtr(handleList,IntPtr.Size*2,errChild);
      if(!NativeRecoveryJob.UpdateProcThreadAttribute(attributeList,0,NativeRecoveryJob.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      environment=EnvironmentBlock(info); var si=new NativeRecoveryJob.STARTUPINFOEX();si.StartupInfo=new NativeRecoveryJob.STARTUPINFO { cb=Marshal.SizeOf<NativeRecoveryJob.STARTUPINFOEX>(),dwFlags=NativeRecoveryJob.STARTF_USESTDHANDLES,hStdInput=inChild,hStdOutput=outChild,hStdError=errChild };si.lpAttributeList=attributeList;
      string cwd=String.IsNullOrWhiteSpace(info.WorkingDirectory)?Environment.CurrentDirectory:Path.GetFullPath(info.WorkingDirectory);
      if(!NativeRecoveryJob.CreateProcess(Path.GetFullPath(info.FileName),command,IntPtr.Zero,IntPtr.Zero,true,NativeRecoveryJob.CREATE_SUSPENDED|NativeRecoveryJob.CREATE_NO_WINDOW|NativeRecoveryJob.CREATE_UNICODE_ENVIRONMENT|NativeRecoveryJob.EXTENDED_STARTUPINFO_PRESENT,environment,cwd,ref si,out pi))throw new Win32Exception();
      if(!NativeRecoveryJob.AssignProcessToJobObject(job,pi.hProcess))throw new Win32Exception();
      process=Process.GetProcessById((int)pi.dwProcessId);
      if(NativeRecoveryJob.ResumeThread(pi.hThread)==UInt32.MaxValue)throw new Win32Exception();
      NativeRecoveryJob.CloseHandle(pi.hThread);pi.hThread=IntPtr.Zero;NativeRecoveryJob.CloseHandle(pi.hProcess);pi.hProcess=IntPtr.Zero;
      NativeRecoveryJob.CloseHandle(outChild);outChild=IntPtr.Zero;NativeRecoveryJob.CloseHandle(errChild);errChild=IntPtr.Zero;NativeRecoveryJob.CloseHandle(inChild);inChild=IntPtr.Zero;
      var utf8=new UTF8Encoding(false,false);
      stdout=new StreamReader(new FileStream(new SafeFileHandle(outParent,true),FileAccess.Read,4096,false),utf8,false,4096,false);outParent=IntPtr.Zero;
      stderr=new StreamReader(new FileStream(new SafeFileHandle(errParent,true),FileAccess.Read,4096,false),utf8,false,4096,false);errParent=IntPtr.Zero;
      stdin=new StreamWriter(new FileStream(new SafeFileHandle(inParent,true),FileAccess.Write,4096,false),utf8,4096,false){AutoFlush=true};inParent=IntPtr.Zero;
      var result=new RecoveryJobProcess(job,process,stdout,stderr,stdin);transferred=true;job=null;process=null;stdout=null;stderr=null;stdin=null;return result;
    } finally {
      if(!transferred){
        if(job!=null&&!job.IsInvalid)try{NativeRecoveryJob.TerminateJobObject(job,1);}catch{}
        if(pi.hProcess!=IntPtr.Zero)try{NativeRecoveryJob.TerminateProcess(pi.hProcess,1);}catch{}
        try{stdin?.Dispose();}catch{}try{stdout?.Dispose();}catch{}try{stderr?.Dispose();}catch{}try{process?.Dispose();}catch{}try{job?.Dispose();}catch{}
      }
      if(attributeList!=IntPtr.Zero){NativeRecoveryJob.DeleteProcThreadAttributeList(attributeList);Marshal.FreeHGlobal(attributeList);}if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);
      if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
      foreach(IntPtr handle in new[]{outParent,outChild,errParent,errChild,inParent,inChild,pi.hThread,pi.hProcess,rawJob})if(handle!=IntPtr.Zero)NativeRecoveryJob.CloseHandle(handle);
    }
  }
}
'@
}

function Start-VerifiedRecoveryProcess([Diagnostics.ProcessStartInfo]$StartInfo) {
  try { return [RecoveryJobProcessFactory]::Start($StartInfo) }
  catch { throw 'RECOVERY_JOB_PROCESS_START_FAILED' }
}

function Stop-VerifiedRecoveryProcessTree($Process, [ValidateRange(100,10000)][int]$MaximumWaitMilliseconds = 5000) {
  if ($null -eq $Process) { return }
  if ($Process -isnot [RecoveryJobProcess]) { throw 'RECOVERY_PROCESS_NOT_JOB_BOUND' }
  try {
    if (-not $Process.TerminateAndWait($MaximumWaitMilliseconds) -or -not $Process.HasExited) { throw 'RECOVERY_KIT_TOOL_TREE_EXIT_UNCONFIRMED' }
  } catch { throw 'RECOVERY_KIT_TOOL_TREE_EXIT_UNCONFIRMED' }
}
