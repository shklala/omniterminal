// Shared domain types used by the session manager (daemon), Electron main and renderer.

export type ShellKind = 'powershell' | 'pwsh' | 'cmd' | 'gitbash' | 'wsl' | 'custom';

export interface ShellInfo {
  /** Stable id, e.g. "powershell", "pwsh", "cmd", "gitbash", "wsl:Ubuntu". */
  id: string;
  kind: ShellKind;
  label: string;
  path: string;
  /** WSL distribution name for kind === 'wsl'. */
  distro?: string;
}

export interface EnvVar {
  name: string;
  /** Plain value for non-secret vars. Never populated for secrets when sent to the GUI. */
  value: string;
  secret: boolean;
  /** For secrets: whether an encrypted value is stored. */
  hasValue?: boolean;
}

export interface CustomMapping {
  envVar: string;
  /** Relative to the profile directory (no ".." allowed), or an absolute path. */
  path: string;
  kind: 'dir' | 'file';
}

export interface Appearance {
  fontFamily: string;
  fontSize: number;
  theme: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
}

export interface AdvancedSettings {
  /** Keep the session running when the GUI window is closed. */
  persistSession: boolean;
  scrollback: number;
  /** Record raw terminal output (redacted) to <profile>/logs/transcript-*.log. Off by default. */
  transcript: boolean;
  /** Use node-pty's bundled OpenConsole/conpty.dll instead of the system ConPTY. */
  useBundledConpty: boolean;
  /** Re-read Machine/User environment from the registry at launch (like Windows Terminal). */
  refreshEnvironment: boolean;
  /** Environment variable names removed from the inherited environment. */
  unsetVars: string[];
}

export interface Profile {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  cwd: string;
  shellId: string;
  /** Only used when shellId === 'custom'. */
  shellPath: string;
  shellArgs: string[];
  startupCommand: string;
  env: EnvVar[];
  /** Tool isolation toggles keyed by tool id (missing => default enabled). */
  tools: Record<string, boolean>;
  customMappings: CustomMapping[];
  appearance: Appearance;
  advanced: AdvancedSettings;
  lastCols: number;
  lastRows: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  sortOrder: number;
  /** Absolute profile directory (computed). */
  dir: string;
}

export type ProfileInput = Partial<
  Omit<Profile, 'id' | 'slug' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'dir'>
> & { name: string };

export type SessionState = 'running' | 'exited';

export interface SessionInfo {
  sessionId: string;
  profileId: string;
  pid: number;
  state: SessionState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  cols: number;
  rows: number;
  /** Number of GUI clients currently attached. */
  attachedClients: number;
  shellId: string;
  title: string;
}

export interface AppSettings {
  autostart: boolean;
  keepManagerRunning: boolean;
  defaultShellId: string;
  defaultCwd: string;
  confirmOnExitCompletely: boolean;
}

export type IsolationLevel = 'full' | 'partial' | 'shared';

export interface ToolEnvMapping {
  envVar: string;
  /** Relative path inside the profile dir. "{slug}" is replaced by the profile slug. */
  path: string;
  kind: 'dir' | 'file' | 'value';
  /** For kind === 'value': literal value with {slug}/{id} substitution. */
  value?: string;
}

export interface ToolDefinition {
  id: string;
  name: string;
  category: 'cli' | 'history';
  mappings: ToolEnvMapping[];
  isolation: IsolationLevel;
  notes: string;
  defaultEnabled: boolean;
  /**
   * Per-terminal access-token variables the tool honours. The Tools tab offers a field for each;
   * values are stored as encrypted secret variables of that terminal.
   */
  tokenVars?: { envVar: string; label: string; help: string }[];
  /** Command that shows which account is active, for the user's reference. */
  whoami?: string;
}

export interface DaemonInfo {
  version: string;
  pid: number;
  startedAt: number;
  home: string;
}

export interface AppState {
  daemon: DaemonInfo;
  profiles: Profile[];
  sessions: SessionInfo[];
  shells: ShellInfo[];
  tools: ToolDefinition[];
  limitations: ToolDefinition[];
  settings: AppSettings;
}

export interface ExportedProfile {
  name: string;
  description: string;
  color: string;
  icon: string;
  cwd: string;
  shellId: string;
  shellPath: string;
  shellArgs: string[];
  startupCommand: string;
  env: { name: string; value: string | null; secret: boolean }[];
  tools: Record<string, boolean>;
  customMappings: CustomMapping[];
  appearance: Appearance;
  advanced: AdvancedSettings;
}

export interface ExportBundle {
  format: 'omniterminal-export';
  version: 1;
  exportedAt: string;
  note: string;
  profiles: ExportedProfile[];
}
