import { parseJsonOutput, runPowerShell } from './powershell';

/**
 * Reads the CURRENT environment of running shells (what `set X=...` / `$env:X = ...` changed),
 * from each process's own memory: PEB -> ProcessParameters -> Environment, the same place
 * Process Explorer reads. Read-only, same-user processes only (an elevated shell is skipped).
 * x64 offsets: PEB.ProcessParameters 0x20, Environment 0x80, EnvironmentSize 0x3F0.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OmniProcessEnv {
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFrom; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static long ReadInt64(IntPtr h, IntPtr addr) {
    var b = new byte[8]; IntPtr r;
    if (!ReadProcessMemory(h, addr, b, (IntPtr)8, out r)) throw new Exception("read failed");
    return BitConverter.ToInt64(b, 0);
  }
  public static string[] Read(int pid) {
    IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid); // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
      var pp = (IntPtr)ReadInt64(h, pbi.PebBaseAddress + 0x20);
      var env = (IntPtr)ReadInt64(h, pp + 0x80);
      long size = ReadInt64(h, pp + 0x3F0);
      if (size <= 0 || size > 4 * 1024 * 1024) return null;
      var buf = new byte[size]; IntPtr got;
      if (!ReadProcessMemory(h, env, buf, (IntPtr)size, out got)) return null;
      var list = new List<string>();
      foreach (var part in Encoding.Unicode.GetString(buf, 0, (int)got).Split('\0')) if (part.Length > 0) list.Add(part);
      return list.ToArray();
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
$pids = [Console]::In.ReadToEnd() | ConvertFrom-Json
$out = @{}
foreach ($p in @($pids)) { $e = [OmniProcessEnv]::Read([int]$p); if ($e) { $out["$p"] = $e } }
[Console]::Out.Write('<<JSON>>' + (ConvertTo-Json -InputObject $out -Compress -Depth 3) + '<</JSON>>')
`;

/** pid -> environment (name -> value). Missing pids could not be read. */
export async function readProcessEnvironments(pids: number[]): Promise<Record<number, Record<string, string>>> {
  if (pids.length === 0) return {};
  const raw = parseJsonOutput<Record<string, string[]>>(await runPowerShell(SCRIPT, JSON.stringify(pids), 30_000));
  const out: Record<number, Record<string, string>> = {};
  for (const [pid, lines] of Object.entries(raw ?? {})) {
    const env: Record<string, string> = {};
    for (const line of Array.isArray(lines) ? lines : [lines]) {
      const i = String(line).indexOf('=', 1); // "=C:=C:\x" (per-drive folders) starts with '='
      if (i > 0) env[String(line).slice(0, i)] = String(line).slice(i + 1);
    }
    out[Number(pid)] = env;
  }
  return out;
}

/** Variables never carried over: per-session ids, per-drive folders, the prompt, the shell's own. */
const VOLATILE = /^(=|OMNITERMINAL_SESSION_ID$|OMNITERMINAL_INSTANCE$|OMNITERMINAL_PS_INIT$|PROMPT$|CMDCMDLINE$|ERRORLEVEL$|__COMPAT_LAYER$|PSModulePath$|PSExecutionPolicyPreference$)/i;

/** What changed in a shell's environment since it started: set (new or changed) and unset names. */
export function diffEnvironment(launched: Record<string, string>, now: Record<string, string>): { set: Record<string, string>; unset: string[] } {
  const up = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k.toUpperCase(), [k, v] as const]));
  const before = up(launched);
  const after = up(now);
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, [name, value]] of after) {
    if (VOLATILE.test(name)) continue;
    if (before.get(key)?.[1] !== value) set[name] = value;
  }
  for (const [key, [name]] of before) if (!after.has(key) && !VOLATILE.test(name)) unset.push(name);
  return { set, unset };
}
