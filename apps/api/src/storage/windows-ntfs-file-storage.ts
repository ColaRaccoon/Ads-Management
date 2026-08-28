import { spawn, ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  FileStoragePutInput,
  InvalidStorageKeyError,
  StorageIntegrityError,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  StoredFile,
  StoredFileStream
} from "./file-storage";

const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;
const MAX_HELPER_ASSEMBLY_BYTES = 512 * 1024;
const META_LINE = /^META ([0-9]+)\r?$/;
let helperAssemblyPromise: Promise<string> | undefined;

/**
 * Windows-specific NTFS operations. Node's fs API does not expose
 * FILE_FLAG_OPEN_REPARSE_POINT, share-delete leases, final-path-by-handle, or
 * handle-based rename/delete. This helper supplies those primitives without a
 * machine-installed addon. The cross-platform storage policy remains in
 * LocalFileStorage; only the native check/use boundary lives here.
 */
export class WindowsNtfsFileStorage {
  constructor(private readonly rootPath: string) {}

  async assertReady() {
    await this.runJson("ready", "");
  }

  async put(input: FileStoragePutInput): Promise<StoredFile> {
    const expected = input.expectedHashSha256?.toLowerCase() ?? "";
    if (expected && !/^[0-9a-f]{64}$/.test(expected)) throw new StorageIntegrityError();
    const maximum = checkedMaximum(input.maxBytes);
    const result = await this.runJson("put", input.key, expected, maximum, input.body);
    if (!isStoredFile(result) || result.key !== input.key) throw new StorageIntegrityError();
    return result;
  }

  async getStream(key: string): Promise<StoredFileStream> {
    const child = await this.start("get", key, "", Number.MAX_SAFE_INTEGER);
    child.stdin.end();
    const metadata = await waitForMetadata(child);
    child.once("exit", (code) => {
      if (code !== 0 && !child.stdout.destroyed) child.stdout.destroy(new StorageIntegrityError());
    });
    child.once("error", () => {
      if (!child.stdout.destroyed) child.stdout.destroy(new StorageIntegrityError());
    });
    return { stream: child.stdout, size: metadata.size };
  }

  async delete(key: string) {
    const result = await this.runJson("delete", key);
    if (!isBooleanResult(result)) throw new StorageIntegrityError();
    return result.value;
  }

  async exists(key: string) {
    const result = await this.runJson("exists", key);
    if (!isBooleanResult(result)) throw new StorageIntegrityError();
    return result.value;
  }

  private async runJson(
    operation: string,
    key: string,
    expectedHash = "",
    maximum = Number.MAX_SAFE_INTEGER,
    body?: Buffer | Readable
  ) {
    const child = await this.start(operation, key, expectedHash, maximum);
    const stdout = collectBounded(child.stdout);
    const stderr = collectBounded(child.stderr);
    const exited = childExit(child);
    try {
      if (body === undefined) child.stdin.end();
      else await pipeline(Buffer.isBuffer(body) ? Readable.from(body) : body, child.stdin);
      const [code, output, errorOutput] = await Promise.all([exited, stdout, stderr]);
      if (code !== 0) throw helperError(errorOutput);
      try { return JSON.parse(output); }
      catch { throw new StorageIntegrityError(); }
    } catch (error) {
      if (!child.killed) child.kill();
      throw error;
    }
  }

  private async start(operation: string, key: string, expectedHash: string, maximum: number) {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
    if (!path.win32.isAbsolute(systemRoot)) throw new StorageIntegrityError();
    const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const assembly = await helperAssembly(systemRoot, executable);
    const command = [
      "$ErrorActionPreference='Stop'",
      "[Reflection.Assembly]::Load([Convert]::FromBase64String($env:META_NTFS_HELPER_ASSEMBLY))|Out-Null",
      "[NtfsStorageHelper]::Run()",
      "exit [Environment]::ExitCode"
    ].join(";");
    return spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        META_NTFS_HELPER_ASSEMBLY: assembly,
        META_NTFS_OPERATION: operation,
        META_NTFS_ROOT: this.rootPath,
        META_NTFS_KEY: key,
        META_NTFS_EXPECTED_HASH: expectedHash,
        META_NTFS_MAXIMUM_BYTES: String(maximum)
      }
    });
  }
}

function helperAssembly(systemRoot: string, executable: string) {
  helperAssemblyPromise ??= compileHelperAssembly(systemRoot, executable);
  return helperAssemblyPromise;
}

async function compileHelperAssembly(systemRoot: string, executable: string) {
  const source = Buffer.from(NTFS_HELPER_SOURCE, "utf8").toString("base64");
  const command = [
    "$ErrorActionPreference='Stop'",
    "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:META_NTFS_HELPER_SOURCE))",
    "$output=[IO.Path]::Combine($env:TEMP,'meta-ntfs-helper-'+[Guid]::NewGuid().ToString('N')+'.dll')",
    "try{Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $output;$bytes=[IO.File]::ReadAllBytes($output);$loaded=[Reflection.Assembly]::Load($bytes);if(-not $loaded.GetType('NtfsStorageHelper',$false,$false)){throw 'Native helper type is missing.'};[Console]::Out.Write([Convert]::ToBase64String($bytes))}finally{Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue}"
  ].join(";");
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      META_NTFS_HELPER_SOURCE: source
    }
  });
  const [code, output] = await Promise.all([
    childExit(child),
    collectBounded(child.stdout, MAX_HELPER_ASSEMBLY_BYTES),
    collectBounded(child.stderr)
  ]);
  if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) throw new StorageIntegrityError();
  const bytes = Buffer.from(output, "base64");
  if (bytes.length < 1_024 || bytes.length > MAX_HELPER_ASSEMBLY_BYTES) throw new StorageIntegrityError();
  return output;
}

async function waitForMetadata(child: ChildProcessWithoutNullStreams) {
  let stderr = Buffer.alloc(0);
  return new Promise<{ size: number }>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (!child.killed) child.kill();
      reject(error);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > MAX_HELPER_OUTPUT_BYTES) return fail(new StorageIntegrityError());
      const newline = stderr.indexOf(0x0a);
      if (newline < 0) return;
      const line = stderr.subarray(0, newline).toString("utf8");
      const match = META_LINE.exec(line);
      if (!match) return fail(helperError(stderr.toString("utf8")));
      const size = Number(match[1]);
      if (!Number.isSafeInteger(size) || size < 0) return fail(new StorageIntegrityError());
      settled = true;
      resolve({ size });
    });
    child.once("error", () => fail(new StorageIntegrityError()));
    child.once("exit", (code) => {
      if (!settled) fail(code === 0 ? new StorageIntegrityError() : helperError(stderr.toString("utf8")));
    });
  });
}

function childExit(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", () => reject(new StorageIntegrityError()));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function collectBounded(stream: Readable, maximum = MAX_HELPER_OUTPUT_BYTES) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw new StorageIntegrityError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function helperError(output: string) {
  if (/ERR MISSING\b/.test(output)) return new StorageObjectNotFoundError();
  if (/ERR TOO_LARGE\b/.test(output)) return new StorageObjectTooLargeError();
  if (/ERR INTEGRITY\b/.test(output)) return new StorageIntegrityError();
  return new InvalidStorageKeyError();
}

function checkedMaximum(value: number | undefined) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageObjectTooLargeError();
  return value;
}

function isStoredFile(value: unknown): value is StoredFile {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.key === "string" && /^[0-9a-f]{64}$/.test(String(item.hash)) &&
    Number.isSafeInteger(item.size) && Number(item.size) >= 0;
}

function isBooleanResult(value: unknown): value is { value: boolean } {
  return Boolean(value && typeof value === "object" && typeof (value as { value?: unknown }).value === "boolean");
}

const NTFS_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class NtfsStorageHelper {
  const uint READ=0x80000000,WRITE=0x40000000,DELETE=0x00010000,READ_ATTR=0x80;
  const uint SHARE_READ=1,SHARE_WRITE=2,SHARE_DELETE=4,OPEN_EXISTING=3,CREATE_NEW=1;
  const uint BACKUP=0x02000000,OPEN_REPARSE=0x00200000,REPARSE_ATTR=0x400,DIRECTORY_ATTR=0x10;
  const int AttrTag=9,Standard=1,Rename=3,Disposition=4;

  [StructLayout(LayoutKind.Sequential)] struct AttrTagInfo { public uint Attributes; public uint ReparseTag; }
  [StructLayout(LayoutKind.Sequential)] struct StandardInfo { public long AllocationSize; public long EndOfFile; public uint Links; [MarshalAs(UnmanagedType.U1)] public bool DeletePending; [MarshalAs(UnmanagedType.U1)] public bool Directory; }
  [StructLayout(LayoutKind.Sequential)] struct DispositionInfo { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }

  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out AttrTagInfo info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out StandardInfo info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,IntPtr info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,ref DispositionInfo info,uint size);

  sealed class Lease : IDisposable {
    public readonly string Root;
    readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
    public Lease(string root) {
      if(String.IsNullOrWhiteSpace(root)||!Path.IsPathRooted(root)||root.StartsWith("\\\\")) Fail("INVALID");
      Root=Canonical(root);
      string drive=Path.GetPathRoot(Root);
      if(String.IsNullOrEmpty(drive)||!String.Equals(new DriveInfo(drive).DriveFormat,"NTFS",StringComparison.OrdinalIgnoreCase)) Fail("INVALID");
      try { LockDirectory(Root); }
      catch(HelperException error) { if(error.Message!="MISSING")throw;ValidateMissingRootParent(Root);throw; }
    }
    public string Parent(string key,bool create) {
      ValidKey(key);string current=Root;string[] parts=key.Split('/');
      for(int i=0;i<parts.Length-1;i++) { current=Path.Combine(current,parts[i]);if(create&&!Directory.Exists(current))Directory.CreateDirectory(current);LockDirectory(current); }
      return current;
    }
    void LockDirectory(string value) {
      SafeFileHandle handle=null;
      try {
        handle=Open(value,0,SHARE_READ|SHARE_WRITE,OPEN_EXISTING,BACKUP|OPEN_REPARSE);
        AttrTagInfo attr=Attributes(handle);
        if((attr.Attributes&REPARSE_ATTR)!=0||(attr.Attributes&DIRECTORY_ATTR)==0){handle.Dispose();Fail("INVALID");}
        if(!SamePath(value,FinalPath(handle))){handle.Dispose();Fail("INVALID");}handles.Add(handle);
      } catch { if(handle!=null&&!handles.Contains(handle))handle.Dispose();throw; }
    }
    public void Dispose(){for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();}
  }

  public static void Run() {
    try {
      string op=Env("META_NTFS_OPERATION"),root=Env("META_NTFS_ROOT"),key=Env("META_NTFS_KEY");
      if(op=="ready"){using(Lease lease=new Lease(root)){};Console.Out.Write("{\"value\":true}");return;}
      if(op=="put"){Put(root,key,Env("META_NTFS_EXPECTED_HASH"),ParseMaximum());return;}
      if(op=="get"){Get(root,key);return;}
      if(op=="exists"){Exists(root,key);return;}
      if(op=="delete"){Delete(root,key);return;}
      Fail("INVALID");
    } catch(Exception error) {
      string code=error is HelperException?error.Message:"INVALID";
      Console.Error.WriteLine("ERR "+code);Environment.ExitCode=1;
    }
  }

  static void Put(string root,string key,string expected,long maximum) {
    using(Lease lease=new Lease(root)) {
      string parent=lease.Parent(key,true),target=Path.Combine(parent,Leaf(key)),temporary=Path.Combine(parent,".pending-"+Guid.NewGuid().ToString("N"));
      SafeFileHandle handle=null;FileStream stream=null;bool published=false;
      try {
        handle=Open(temporary,READ|WRITE|DELETE|READ_ATTR,0,CREATE_NEW,OPEN_REPARSE);
        VerifyLeaf(handle,temporary);
        stream=new FileStream(handle,FileAccess.ReadWrite,65536,false);
        byte[] buffer=new byte[65536];long size=0;using(SHA256 hash=SHA256.Create()) {
          Stream input=Console.OpenStandardInput();int read;
          while((read=input.Read(buffer,0,buffer.Length))>0){size+=read;if(size>maximum)Fail("TOO_LARGE");hash.TransformBlock(buffer,0,read,null,0);stream.Write(buffer,0,read);}
          hash.TransformFinalBlock(new byte[0],0,0);stream.Flush(true);string digest=Hex(hash.Hash);
          if(expected.Length>0&&!String.Equals(expected,digest,StringComparison.Ordinal))Fail("INTEGRITY");
          if(!RenameHandle(handle,target)) {
            int error=Marshal.GetLastWin32Error();MarkDelete(handle);stream.Dispose();stream=null;handle=null;
            if(error!=80&&error!=183)throw new Win32Exception(error);
            FileResult existing=HashExisting(target,maximum);if(existing.Size!=size||existing.Hash!=digest)Fail("INTEGRITY");
            Console.Out.Write(Result(key,existing.Hash,existing.Size));return;
          }
          published=true;Console.Out.Write(Result(key,digest,size));
        }
      } finally {
        if(!published&&handle!=null&&!handle.IsInvalid)try{MarkDelete(handle);}catch{}
        if(stream!=null)stream.Dispose();else if(handle!=null)handle.Dispose();
      }
    }
  }

  static void Get(string root,string key) {
    using(Lease lease=new Lease(root)) {string target=Path.Combine(lease.Parent(key,false),Leaf(key));using(SafeFileHandle handle=OpenLeaf(target,READ|READ_ATTR)){
      StandardInfo info=Info(handle);if(info.EndOfFile<0)Fail("INTEGRITY");Console.Error.WriteLine("META "+info.EndOfFile);Console.Error.Flush();
      using(FileStream stream=new FileStream(handle,FileAccess.Read,65536,false)){byte[] buffer=new byte[65536];Stream output=Console.OpenStandardOutput();int read;while((read=stream.Read(buffer,0,buffer.Length))>0)output.Write(buffer,0,read);output.Flush();}
    }}
  }

  static void Exists(string root,string key) {
    try{using(Lease lease=new Lease(root)){string target=Path.Combine(lease.Parent(key,false),Leaf(key));using(SafeFileHandle handle=OpenLeaf(target,READ_ATTR)){}Console.Out.Write("{\"value\":true}");}}
    catch(HelperException error){if(error.Message!="MISSING")throw;Console.Out.Write("{\"value\":false}");}
  }

  static void Delete(string root,string key) {
    try{using(Lease lease=new Lease(root)){string target=Path.Combine(lease.Parent(key,false),Leaf(key));using(SafeFileHandle handle=OpenLeaf(target,DELETE|READ_ATTR)){MarkDelete(handle);}Console.Out.Write("{\"value\":true}");}}
    catch(HelperException error){if(error.Message!="MISSING")throw;Console.Out.Write("{\"value\":false}");}
  }

  static SafeFileHandle OpenLeaf(string path,uint access){SafeFileHandle handle=Open(path,access,SHARE_READ,OPEN_EXISTING,OPEN_REPARSE);try{VerifyLeaf(handle,path);return handle;}catch{handle.Dispose();throw;}}
  static FileResult HashExisting(string path,long maximum){using(SafeFileHandle handle=OpenLeaf(path,READ|READ_ATTR))using(FileStream stream=new FileStream(handle,FileAccess.Read,65536,false)){byte[] buffer=new byte[65536];long size=0;using(SHA256 hash=SHA256.Create()){int read;while((read=stream.Read(buffer,0,buffer.Length))>0){size+=read;if(size>maximum)Fail("TOO_LARGE");hash.TransformBlock(buffer,0,read,null,0);}hash.TransformFinalBlock(new byte[0],0,0);return new FileResult{Hash=Hex(hash.Hash),Size=size};}}}
  static void VerifyLeaf(SafeFileHandle handle,string expected){AttrTagInfo attr=Attributes(handle);StandardInfo info=Info(handle);if((attr.Attributes&REPARSE_ATTR)!=0||(attr.Attributes&DIRECTORY_ATTR)!=0||info.Directory||info.Links!=1||!SamePath(expected,FinalPath(handle)))Fail("INVALID");}
  static AttrTagInfo Attributes(SafeFileHandle handle){AttrTagInfo value;if(!GetFileInformationByHandleEx(handle,AttrTag,out value,(uint)Marshal.SizeOf(typeof(AttrTagInfo))))throw new Win32Exception();return value;}
  static StandardInfo Info(SafeFileHandle handle){StandardInfo value;if(!GetFileInformationByHandleEx(handle,Standard,out value,(uint)Marshal.SizeOf(typeof(StandardInfo))))throw new Win32Exception();return value;}
  static SafeFileHandle Open(string name,uint access,uint share,uint creation,uint flags){SafeFileHandle handle=CreateFile(name,access,share,IntPtr.Zero,creation,flags,IntPtr.Zero);if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();handle.Dispose();if(error==2||error==3)Fail("MISSING");throw new Win32Exception(error);}return handle;}
  static void ValidateMissingRootParent(string root){string current=Path.GetDirectoryName(root);while(!String.IsNullOrEmpty(current)){SafeFileHandle handle=null;try{handle=Open(current,0,SHARE_READ|SHARE_WRITE|SHARE_DELETE,OPEN_EXISTING,BACKUP|OPEN_REPARSE);AttrTagInfo attr=Attributes(handle);if((attr.Attributes&REPARSE_ATTR)!=0||(attr.Attributes&DIRECTORY_ATTR)==0||!SamePath(current,FinalPath(handle)))Fail("INVALID");return;}catch(HelperException error){if(error.Message!="MISSING")throw;current=Path.GetDirectoryName(current);}finally{if(handle!=null)handle.Dispose();}}Fail("INVALID");}
  static string FinalPath(SafeFileHandle handle){StringBuilder value=new StringBuilder(32768);uint length=GetFinalPathNameByHandle(handle,value,(uint)value.Capacity,0);if(length==0||length>=value.Capacity)throw new Win32Exception();string result=value.ToString();if(result.StartsWith("\\\\?\\"))result=result.Substring(4);return Canonical(result);}
  static string Canonical(string value){string full=Path.GetFullPath(value),root=Path.GetPathRoot(full);return String.Equals(full,root,StringComparison.OrdinalIgnoreCase)?root:full.TrimEnd('\\');}
  static bool SamePath(string left,string right){return String.Equals(Canonical(left),Canonical(right),StringComparison.OrdinalIgnoreCase);}
  static bool RenameHandle(SafeFileHandle handle,string target){byte[] name=Encoding.Unicode.GetBytes(Path.GetFullPath(target));int rootOffset=IntPtr.Size==8?8:4,lenOffset=rootOffset+IntPtr.Size,nameOffset=lenOffset+4,size=nameOffset+name.Length+2;IntPtr memory=Marshal.AllocHGlobal(size);try{for(int i=0;i<size;i++)Marshal.WriteByte(memory,i,0);Marshal.WriteInt32(memory,0,0);Marshal.WriteIntPtr(memory,rootOffset,IntPtr.Zero);Marshal.WriteInt32(memory,lenOffset,name.Length);Marshal.Copy(name,0,IntPtr.Add(memory,nameOffset),name.Length);return SetFileInformationByHandle(handle,Rename,memory,(uint)size);}finally{Marshal.FreeHGlobal(memory);}}
  static void MarkDelete(SafeFileHandle handle){DispositionInfo value=new DispositionInfo{DeleteFile=true};if(!SetFileInformationByHandle(handle,Disposition,ref value,(uint)Marshal.SizeOf(typeof(DispositionInfo))))throw new Win32Exception();}
  static void ValidKey(string key){if(String.IsNullOrEmpty(key)||key.Length>4096||key[0]=='/'||key.IndexOf('\\')>=0||key.IndexOf(':')>=0||key.IndexOf('\0')>=0)Fail("INVALID");foreach(string part in key.Split('/'))if(String.IsNullOrEmpty(part)||part=="."||part=="..")Fail("INVALID");}
  static string Leaf(string key){ValidKey(key);string[] parts=key.Split('/');return parts[parts.Length-1];}
  static string Env(string name){return Environment.GetEnvironmentVariable(name)??"";}
  static long ParseMaximum(){long value;if(!Int64.TryParse(Env("META_NTFS_MAXIMUM_BYTES"),out value)||value<0)Fail("TOO_LARGE");return value;}
  static string Hex(byte[] value){StringBuilder text=new StringBuilder(value.Length*2);foreach(byte item in value)text.Append(item.ToString("x2"));return text.ToString();}
  static string Result(string key,string hash,long size){return "{\"key\":\""+Json(key)+"\",\"hash\":\""+hash+"\",\"size\":"+size+"}";}
  static string Json(string value){StringBuilder text=new StringBuilder();foreach(char item in value){if(item=='\"')text.Append("\\\"");else if(item=='\\')text.Append("\\\\");else if(item<32)text.Append("\\u"+((int)item).ToString("x4"));else text.Append(item);}return text.ToString();}
  static void Fail(string code){throw new HelperException(code);}
  sealed class HelperException:Exception{public HelperException(string value):base(value){}}
  sealed class FileResult{public string Hash;public long Size;}
}
`;
