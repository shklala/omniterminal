import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Windows "sudo" (Windows 11 24H2+) modes, from HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Sudo\Enabled:
 *   0 disabled · 1 forceNewWindow · 2 disableInput · 3 normal (inline: elevated command runs in this terminal)
 */
export type SudoMode = 'unavailable' | 'disabled' | 'newWindow' | 'inputClosed' | 'inline';

export interface ElevationStatus {
  /** The session manager (and so every terminal it starts) already runs as administrator. */
  managerElevated: boolean;
  sudo: SudoMode;
  sudoPath: string;
}

function run(file: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, out: String(stdout ?? '') });
    });
  });
}

export function parseSudoMode(regOutput: string, exists: boolean): SudoMode {
  if (!exists) return 'unavailable';
  const m = /Enabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOutput);
  switch (m ? parseInt(m[1], 16) : 0) {
    case 1:
      return 'newWindow';
    case 2:
      return 'inputClosed';
    case 3:
      return 'inline';
    default:
      return 'disabled';
  }
}

export async function getElevationStatus(): Promise<ElevationStatus> {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const sudoPath = path.join(sys, 'System32', 'sudo.exe');
  const exists = fs.existsSync(sudoPath);
  // "fltmc" succeeds only for elevated callers: a cheap, dependency-free elevation check.
  const [fltmc, reg] = await Promise.all([
    run(path.join(sys, 'System32', 'fltmc.exe'), []),
    exists ? run(path.join(sys, 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo', '/v', 'Enabled']) : Promise.resolve({ code: 1, out: '' }),
  ]);
  return { managerElevated: fltmc.code === 0, sudo: parseSudoMode(reg.out, exists), sudoPath };
}

/**
 * The line typed into a terminal to continue in an elevated shell, in place.
 * `sudo -E` keeps the terminal's environment (its isolated tool folders and variables) and folder.
 * PowerShell re-runs the per-terminal history bootstrap from OMNITERMINAL_PS_INIT.
 * Returns null for shells where Windows sudo does not apply (WSL has its own sudo).
 */
export function elevatedShellCommand(kind: string, shellPath: string): string | null {
  switch (kind) {
    case 'powershell':
    case 'pwsh':
      return `sudo -E "${shellPath}" -NoLogo -NoExit -Command 'iex $env:OMNITERMINAL_PS_INIT'`;
    case 'cmd':
      return `sudo -E "${shellPath}" /D /K "title Administrator: ${'%'}OMNITERMINAL_PROFILE${'%'} & echo Elevated (Administrator). Type exit to return."`;
    case 'gitbash':
      return `sudo.exe -E "${shellPath.replace(/\\/g, '/')}" --login -i`;
    default:
      return null;
  }
}

/**
 * Wraps a shell launch so the whole terminal starts elevated through Windows sudo (inline mode):
 * sudo.exe becomes the PTY process and runs the shell with administrator rights inside the same
 * pseudoconsole. `-E` passes the terminal's isolated environment through.
 */
export function wrapWithSudo(sudoPath: string, file: string, args: string[] | string): { file: string; args: string[] | string } {
  if (typeof args === 'string') return { file: sudoPath, args: `-E "${file}" ${args}`.trim() };
  return { file: sudoPath, args: ['-E', file, ...args] };
}
