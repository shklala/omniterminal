import type { Profile } from '../../shared/types';

/** Saved next to each screen snapshot: what a terminal was doing, so a restart can reopen it like that. */
export interface SnapshotMeta {
  /** Folder the shell was in (reported by its prompt). */
  cwd: string;
  /** Window title set by the running program. */
  title: string;
  /** Every program in the terminal (lower case, no .exe); null when the process list was unavailable. */
  programs: string[] | null;
  /** It ran with administrator rights. */
  elevated: boolean;
  savedAt: number;
  /** Variables the user set in the shell, DPAPI-encrypted for this terminal; null if none. */
  envBlob?: string | null;
}

export const RESUME_CLAUDE = 'claude --continue';

/** Was Claude Code running in the terminal when its screen was last saved? */
export function claudeWasRunning(meta: SnapshotMeta | null): boolean {
  if (!meta) return false;
  const titleSaysClaude = /\bclaude\b/i.test(meta.title);
  if (meta.programs === null) return titleSaysClaude;
  // The native install is claude.exe; the npm install runs under node with "claude" in the title.
  return meta.programs.some((p) => p === 'claude' || p.startsWith('claude-')) || (meta.programs.includes('node') && titleSaysClaude);
}

/**
 * The command a restored terminal runs instead of its startup command: the terminal's own
 * "after a restart" command, or `claude --continue` when Claude Code was running in it.
 */
export function restoreCommandFor(profile: Pick<Profile, 'restoreCommand'>, meta: SnapshotMeta | null, resumeClaude: boolean): string | null {
  const own = profile.restoreCommand.trim();
  if (own) return own;
  if (resumeClaude && claudeWasRunning(meta)) return RESUME_CLAUDE;
  return null;
}

/** How to bring back a terminal that ran as administrator. */
export function planElevatedRestore(status: { managerElevated: boolean; sudo: string } | null): 'elevated' | 'already' | 'normal' {
  if (!status) return 'normal';
  if (status.managerElevated) return 'already';
  return status.sudo === 'inline' ? 'elevated' : 'normal';
}

export function parseSnapshotMeta(text: string): SnapshotMeta | null {
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object') return null;
    return {
      cwd: typeof m.cwd === 'string' ? m.cwd : '',
      title: typeof m.title === 'string' ? m.title : '',
      programs: Array.isArray(m.programs) ? m.programs.map(String) : null,
      elevated: m.elevated === true,
      savedAt: Number(m.savedAt) || 0,
      envBlob: typeof m.envBlob === 'string' ? m.envBlob : null,
    };
  } catch {
    return null;
  }
}
