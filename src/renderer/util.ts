import type { Profile, SessionInfo, ShellInfo } from '../shared/types';

export type UiStatus = 'running' | 'disconnected' | 'stopped' | 'exited';

/**
 * Running      – process alive and shown in this window.
 * Disconnected – process alive in the session manager but not attached here (click Reconnect).
 * Stopped      – no process.
 */
export function uiStatus(session: SessionInfo | undefined, isOpen: boolean): UiStatus {
  if (!session) return 'stopped';
  if (session.state === 'exited') return 'exited';
  return isOpen ? 'running' : 'disconnected';
}

export const STATUS_LABEL: Record<UiStatus, string> = {
  running: 'Running',
  disconnected: 'Disconnected',
  stopped: 'Stopped',
  exited: 'Stopped',
};

export function shellLabel(profile: Profile, shells: ShellInfo[]): string {
  if (profile.shellId === 'custom') return profile.shellPath.split(/[\\/]/).pop() || 'Custom';
  return shells.find((s) => s.id === profile.shellId)?.label ?? `${profile.shellId} (not found)`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000 && new Date(now).getDate() === d.getDate()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateFull(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

export function nextDefaultName(profiles: Profile[]): string {
  const taken = new Set(profiles.map((p) => p.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const n = `Terminal ${String(i).padStart(2, '0')}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** e.g. "Administrator: C:\WINDOWS\system32\cmd.exe", "/usr/bin/bash", "MINGW64:/c/Users/me". */
export const SHELL_PATH_TITLE = /^(administrator:\s*)?(([a-z]:[\\/]|\/).*[\\/])?(cmd|powershell|pwsh|bash|zsh|sh|wsl)(\.exe)?$|^MINGW(32|64):/i;

export interface ResourceStats {
  memory: number;
  processes: number;
  children: string[];
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/** "claude · 412 MB" summary of what is running inside a terminal. */
export function statsSummary(s: ResourceStats | undefined, title = ''): string {
  if (!s) return '';
  // Skip process names already visible in the program title ("claude · claude").
  const running = [...new Set(s.children)].filter((c) => !title.toLowerCase().includes(c.toLowerCase())).slice(0, 3).join(', ');
  return `${running ? `${running} · ` : ''}${fmtBytes(s.memory)}`;
}

/**
 * Turns a raw terminal title into something worth showing:
 *   "Administrator: C:\WINDOWS\system32\cmd.exe - python  -q" → "python -q"
 *   "C:\WINDOWS\system32\cmd.exe" → ""   (just the shell)
 *   "claude" → "claude"
 */
export function cleanTitle(raw: string, profileName = ''): string {
  let t = raw.trim().replace(/^administrator:\s*/i, '');
  const m = /^(?:[a-z]:[\\/]|\/)[^]*?[\\/](?:cmd|powershell|pwsh|bash|wsl)(?:\.exe)?\s+-\s+(.+)$/i.exec(t);
  if (m) t = m[1];
  t = t.replace(/\s{2,}/g, ' ').trim();
  if (SHELL_PATH_TITLE.test(t) || t === profileName) return '';
  return t;
}
