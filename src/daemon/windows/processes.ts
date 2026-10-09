import { spawn } from 'node:child_process';
import { parseJsonOutput, runPowerShell } from './powershell';

/** Process creation time as Windows FILETIME (string, to keep 64-bit precision), or null. */
export async function getProcessStartTime(pid: number): Promise<string | null> {
  try {
    const out = await runPowerShell(
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { [Console]::Out.Write('<<JSON>>"' + $p.StartTime.ToFileTimeUtc() + '"<</JSON>>') } else { [Console]::Out.Write('<<JSON>>null<</JSON>>') }`,
      '',
      15_000,
    );
    return parseJsonOutput<string | null>(out);
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kills a process and all of its descendants (taskkill /T /F). */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

export interface OrphanCandidate {
  pid: number;
  /** FILETIME recorded when the session was launched; guards against PID reuse. */
  startTime: string | null;
}

/**
 * Safely cleans up processes left behind by a crashed session manager.
 * A recorded root PID is only killed if its creation time matches what we recorded.
 * Descendants of a dead root are found via ParentProcessId and only killed when they were
 * created after the root (so a recycled PID's unrelated children are never touched).
 */
export async function cleanupOrphans(candidates: OrphanCandidate[]): Promise<number[]> {
  if (candidates.length === 0) return [];
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
$byParent = @{}
foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }; [void]$byParent[$k].Add($p) }
$killed = New-Object System.Collections.Generic.List[int]
# The recorded start time comes from Get-Process (100 ns ticks); WMI's CreationDate only has
# microseconds. Allow 1 ms so the same process still matches; a reused PID never starts that close.
$tol = 10000
function Kill-Desc([int]$ppid, [long]$after) {
  if (-not $byParent.ContainsKey($ppid)) { return }
  foreach ($c in $byParent[$ppid]) {
    if ($c.CreationDate -and $c.CreationDate.ToFileTimeUtc() -ge ($after - $tol)) {
      Kill-Desc ([int]$c.ProcessId) $after
      Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
      $killed.Add([int]$c.ProcessId)
    }
  }
}
foreach ($cand in @($req)) {
  if (-not $cand.startTime) { continue }
  $start = [long]$cand.startTime
  $root = $all | Where-Object { $_.ProcessId -eq $cand.pid } | Select-Object -First 1
  if ($root) {
    if ([math]::Abs($root.CreationDate.ToFileTimeUtc() - $start) -gt $tol) { continue }
    Kill-Desc ([int]$cand.pid) $start
    Stop-Process -Id $cand.pid -Force -ErrorAction SilentlyContinue
    $killed.Add([int]$cand.pid)
  } else {
    Kill-Desc ([int]$cand.pid) $start
  }
}
[Console]::Out.Write('<<JSON>>' + (ConvertTo-Json -InputObject @($killed.ToArray()) -Compress) + '<</JSON>>')
`;
  try {
    const out = await runPowerShell(script, JSON.stringify(candidates), 60_000);
    const r = parseJsonOutput<number[] | number>(out);
    return Array.isArray(r) ? r : [r];
  } catch {
    return [];
  }
}

export interface TreeStats {
  /** Working set of the shell and all of its descendants, in bytes. */
  memory: number;
  /** Number of processes in the tree (shell included). */
  processes: number;
  /** Names of the direct children of the shell (what is running "in" the terminal). */
  children: string[];
  /** Every program in the terminal's process tree (lower case, no .exe), shell excluded. */
  programs: string[];
}

/** Memory / process count for each root PID's process tree, from one Win32_Process snapshot. */
export async function getTreeStats(rootPids: number[]): Promise<Record<number, TreeStats>> {
  if (rootPids.length === 0) return {};
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, WorkingSetSize, Name | ForEach-Object { @{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; m = [long]$_.WorkingSetSize; n = [string]$_.Name } })
[Console]::Out.Write('<<JSON>>' + (ConvertTo-Json -InputObject $all -Compress -Depth 3) + '<</JSON>>')
`;
  let list: { p: number; pp: number; m: number; n: string }[];
  try {
    list = parseJsonOutput(await runPowerShell(script, '', 20_000));
  } catch {
    return {};
  }
  const byParent = new Map<number, typeof list>();
  for (const proc of list) {
    if (proc.p === proc.pp) continue;
    const arr = byParent.get(proc.pp) ?? [];
    arr.push(proc);
    byParent.set(proc.pp, arr);
  }
  const byPid = new Map(list.map((p) => [p.p, p]));
  const out: Record<number, TreeStats> = {};
  for (const root of rootPids) {
    const r = byPid.get(root);
    if (!r) continue;
    const stats: TreeStats = { memory: 0, processes: 0, children: [], programs: [] };
    const seen = new Set<number>();
    const stack = [r];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur.p)) continue;
      seen.add(cur.p);
      stats.memory += cur.m;
      stats.processes += 1;
      if (cur !== r && !/^(conhost|openconsole)\.exe$/i.test(cur.n)) stats.programs.push(cur.n.replace(/\.exe$/i, '').toLowerCase());
      for (const c of byParent.get(cur.p) ?? []) stack.push(c);
    }
    // conhost/OpenConsole belong to the pseudoconsole, not to what the user runs.
    stats.children = (byParent.get(root) ?? []).map((c) => c.n.replace(/\.exe$/i, '')).filter((n) => !/^(conhost|openconsole)$/i.test(n));
    out[root] = stats;
  }
  return out;
}
