import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Profile, ShellInfo } from '../../shared/types';
import { PS_SSH_FUNCTIONS } from '../env/ssh';

function exists(p: string | undefined): p is string {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findOnPath(exe: string): string | undefined {
  const dirs = (process.env.PATH || process.env.Path || '').split(';').filter(Boolean);
  for (const d of dirs) {
    const candidate = path.join(d, exe);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function listWslDistros(wslExe: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(wslExe, ['-l', '-q'], { windowsHide: true, encoding: 'buffer', timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      // wsl.exe prints UTF-16LE.
      const text = Buffer.from(stdout).toString('utf16le').replace(/\0/g, '');
      resolve(
        text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !/^docker-desktop(-data)?$/i.test(s)),
      );
    });
  });
}

/** Detects shells installed on this machine. */
export async function detectShells(): Promise<ShellInfo[]> {
  const shells: ShellInfo[] = [];
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';

  const winPs = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (exists(winPs)) shells.push({ id: 'powershell', kind: 'powershell', label: 'Windows PowerShell', path: winPs });

  const pwshCandidates = [
    path.join(pf, 'PowerShell', '7', 'pwsh.exe'),
    path.join(pf, 'PowerShell', '7-preview', 'pwsh.exe'),
    local && path.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
    findOnPath('pwsh.exe'),
  ];
  const pwsh = pwshCandidates.find((p) => exists(p || undefined));
  if (pwsh) shells.push({ id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7', path: pwsh });

  const cmd = process.env.ComSpec && exists(process.env.ComSpec) ? process.env.ComSpec : path.join(sysRoot, 'System32', 'cmd.exe');
  if (exists(cmd)) shells.push({ id: 'cmd', kind: 'cmd', label: 'Command Prompt', path: cmd });

  const gitFromPath = findOnPath('git.exe');
  const gitBashCandidates = [
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    local && path.join(local, 'Programs', 'Git', 'bin', 'bash.exe'),
    gitFromPath && path.join(path.dirname(path.dirname(gitFromPath)), 'bin', 'bash.exe'),
  ];
  const gitBash = gitBashCandidates.find((p) => exists(p || undefined));
  if (gitBash) shells.push({ id: 'gitbash', kind: 'gitbash', label: 'Git Bash', path: gitBash });

  const wsl = path.join(sysRoot, 'System32', 'wsl.exe');
  if (exists(wsl)) {
    for (const distro of await listWslDistros(wsl)) {
      shells.push({ id: `wsl:${distro}`, kind: 'wsl', label: `WSL: ${distro}`, path: wsl, distro });
    }
  }
  return shells;
}

export interface LaunchSpec {
  file: string;
  /** argv, or (Windows) a raw, pre-quoted command line passed through untouched. */
  args: string[] | string;
  /** Command to type into the terminal once it is ready (shells without a startup flag). */
  typeOnReady: string | null;
  extraEnv: Record<string, string>;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * PowerShell bootstrap: points PSReadLine at the per-terminal history file (reloading the
 * in-memory history from it if PSReadLine already loaded the global history).
 * Runs after the user's $PROFILE, so the user's prompt/modules still work.
 */
export function powershellBootstrap(historyFile: string, startupCommand: string, profileName: string, suggestions = false): string {
  const lines = [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(profileName)}`,
    `try {`,
    `  if (Get-Module -ListAvailable -Name PSReadLine) {`,
    `    Import-Module PSReadLine -ErrorAction SilentlyContinue`,
    `    $__omniHist = ${psQuote(historyFile)}`,
    `    Set-PSReadLineOption -HistorySaveStyle SaveNothing`,
    // Before the first prompt PSReadLine has not read any history yet and AddToHistory throws;
    // it then reads HistorySavePath itself at the first prompt. The reload is only needed when
    // something (e.g. the user's $PROFILE) already started PSReadLine with the global history.
    `    try {`,
    `      [Microsoft.PowerShell.PSConsoleReadLine]::ClearHistory()`,
    `      if (Test-Path -LiteralPath $__omniHist) {`,
    `        $__omniBuf = ''`,
    `        foreach ($__l in [IO.File]::ReadAllLines($__omniHist)) {`,
    `          if ($__l.EndsWith('\`')) { $__omniBuf += $__l.Substring(0, $__l.Length - 1) + "\`n"; continue }`,
    `          [Microsoft.PowerShell.PSConsoleReadLine]::AddToHistory($__omniBuf + $__l); $__omniBuf = ''`,
    `        }`,
    `      }`,
    `    } catch { }`,
    `    Set-PSReadLineOption -HistorySavePath $__omniHist -HistorySaveStyle SaveIncrementally`,
    `    Remove-Variable __omniHist, __omniBuf, __l -ErrorAction SilentlyContinue`,
    ...(suggestions ? psSuggestionLines() : []),
    `  }`,
    `} catch { }`,
    ...PS_SSH_FUNCTIONS,
  ];
  if (startupCommand.trim()) lines.push(startupCommand);
  return lines.join('\n');
}

/**
 * Suggestions while typing (PSReadLine 2.1+): turns predictions on if they are off and shows them
 * as a list under the prompt (PSReadLine 2.2+). HistoryAndPlugin needs PowerShell 7.2+.
 * F1 (command help) and Alt+H (parameter help) come with PSReadLine 2.2 as well.
 * With the setting off, PowerShell's own defaults (or the user's $PROFILE) are left alone.
 */
function psSuggestionLines(): string[] {
  return [
    `    $__omniV = (Get-Module PSReadLine | Sort-Object Version | Select-Object -Last 1).Version`,
    `    if ($__omniV -ge [version]'2.1.0') {`,
    `      if ("$((Get-PSReadLineOption).PredictionSource)" -eq 'None') {`,
    `        $__omniSrc = 'History'`,
    `        if ($__omniV -ge [version]'2.2.2' -and $PSVersionTable.PSVersion -ge [version]'7.2') { $__omniSrc = 'HistoryAndPlugin' }`,
    `        Set-PSReadLineOption -PredictionSource $__omniSrc`,
    `      }`,
    `      if ($__omniV -ge [version]'2.2.0') { Set-PSReadLineOption -PredictionViewStyle ListView }`,
    `    }`,
    `    Remove-Variable __omniV, __omniSrc -ErrorAction SilentlyContinue`,
  ];
}

export interface LaunchOptions {
  suggestions?: boolean;
}

export function buildLaunchSpec(profile: Profile, shells: ShellInfo[], historyDir: string, options: LaunchOptions = {}): LaunchSpec {
  const startup = profile.startupCommand.trim();
  if (profile.shellId === 'custom') {
    if (!profile.shellPath) throw new Error('Custom shell path is not set.');
    return { file: profile.shellPath, args: profile.shellArgs, typeOnReady: startup || null, extraEnv: {} };
  }
  // Falls back to Windows PowerShell if the configured shell was uninstalled.
  const shell = shells.find((s) => s.id === profile.shellId) ?? shells.find((s) => s.id === 'powershell') ?? shells[0];
  if (!shell) throw new Error('No shell is available on this machine.');
  switch (shell.kind) {
    case 'powershell':
    case 'pwsh': {
      const historyFile = path.join(historyDir, 'powershell_history.txt');
      const suggestions = options.suggestions ?? false;
      const script = powershellBootstrap(historyFile, startup, profile.name, suggestions);
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      // Used by "Continue as Administrator": the elevated shell re-applies this terminal's history setup.
      const elevatedInit =
        powershellBootstrap(historyFile, '', `${profile.name} (Administrator)`, suggestions) +
        "\nWrite-Host 'Elevated (Administrator) - same terminal identity. Type exit to return.' -ForegroundColor Yellow";
      return {
        file: shell.path,
        args: ['-NoLogo', '-NoExit', '-EncodedCommand', encoded, ...profile.shellArgs],
        typeOnReady: null,
        extraEnv: { OMNITERMINAL_PS_INIT: elevatedInit },
      };
    }
    case 'cmd': {
      // cmd.exe has its own quoting rules, so build the raw command line ourselves:
      // with /S, cmd strips exactly the outer quotes and runs the rest verbatim.
      const extra = profile.shellArgs.join(' ');
      const raw = ['/D', extra, startup ? `/S /K "${startup}"` : ''].filter(Boolean).join(' ');
      return { file: shell.path, args: raw, typeOnReady: null, extraEnv: { PROMPT: process.env.PROMPT || '$P$G' } };
    }
    case 'gitbash':
      return {
        file: shell.path,
        args: ['--login', '-i', ...profile.shellArgs],
        typeOnReady: startup || null,
        extraEnv: { CHERE_INVOKING: '1', MSYSTEM: process.env.MSYSTEM || 'MINGW64' },
      };
    case 'wsl': {
      const args = ['-d', shell.distro ?? '', '--cd', profile.cwd || '~', ...profile.shellArgs];
      return { file: shell.path, args, typeOnReady: startup || null, extraEnv: {} };
    }
    default:
      return { file: shell.path, args: profile.shellArgs, typeOnReady: startup || null, extraEnv: {} };
  }
}
