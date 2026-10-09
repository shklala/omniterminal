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
  /** Run instead of the startup command when the terminal reopens after a restart or update (e.g. "claude --continue"). */
  restoreCommand: string;
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
  /** Session key: the profile id, or "<profileId>~N" for extra shells of the same terminal. */
  key: string;
  /** The terminal (profile) this shell belongs to. */
  profileId: string;
  /** 1 for the terminal's first shell, 2+ for shells opened with "Open another". */
  instance: number;
  pid: number;
  state: SessionState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  cols: number;
  rows: number;
  /** Number of GUI clients currently attached. */
  attachedClients: number;
  /** Started with administrator rights ("Run as Administrator", via Windows sudo). */
  elevated: boolean;
  shellId: string;
  title: string;
}

export interface AppSettings {
  autostart: boolean;
  keepManagerRunning: boolean;
  defaultShellId: string;
  defaultCwd: string;
  confirmOnExitCompletely: boolean;
  /** 'system' follows the Windows light/dark setting. */
  uiTheme: string;
  /** UI language code ('en', 'ar'). */
  language: string;
  /** Restart terminals that were still running when Windows (or the session manager) went down. */
  restoreAfterRestart: boolean;
  /** PowerShell: suggestions from history (and plugins) while typing, shown as a list. */
  suggestions: boolean;
  /** A terminal that was running Claude Code reopens with `claude --continue` after a restart. */
  resumeClaude: boolean;
  /** Notify when a command that ran at least this many seconds finishes in a background tab (0 = off). */
  notifyAfterSeconds: number;
  /** Closing the window keeps OmniTerminal in the notification area (tray). */
  minimizeToTray: boolean;
  /** System-wide shortcut that shows/hides the window, e.g. "Ctrl+Alt+T" ('' = off). */
  globalHotkey: string;
  /** With the global shortcut: show the window as a drop-down panel at the top of the screen. */
  dropDown: boolean;
  /** Check GitHub Releases for new versions and download them in the background. */
  autoUpdate: boolean;
  /** Custom keyboard shortcuts: action id -> key combination ("Ctrl+Shift+P"); '' disables. */
  keybindings: Record<string, string>;
}

/** Which account a tool in a terminal is signed in to (read from that terminal's config files). */
export interface AccountInfo {
  toolId: string;
  toolName: string;
  /** e.g. "you@example.com (Acme)"; null when not signed in or unknown. */
  account: string | null;
  /** Labels of per-terminal token fields that have a value. Values are never sent. */
  tokens: string[];
  /** The tool's own "who am I" command, if it has one. */
  whoami: string | null;
}

/** A saved command, run from the command palette. */
export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** Only offered in this terminal (base profile id); null = every terminal. */
  profileId: string | null;
  /** Press Enter after typing the command. */
  run: boolean;
}

/** One tab of a workspace: its terminals, side by side. */
export interface WorkspaceTab {
  /** Each pane: a terminal id, plus whether it is an extra shell ("Open another"). */
  panes: { profileId: string; another: boolean }[];
  direction: 'row' | 'column';
}

/** A named set of tabs (and split panes) opened together. */
export interface Workspace {
  id: string;
  name: string;
  tabs: WorkspaceTab[];
}

/** A command-line tool found (or not) on PATH, for Settings > CLI tools. */
export interface InstalledTool {
  id: string;
  name: string;
  group: 'ai' | 'code' | 'cloud' | 'deploy' | 'services' | 'runtimes' | 'data';
  command: string;
  /** Full path when installed, else null. */
  path: string | null;
  version: string | null;
  /** Where to get it. */
  url: string;
}

export interface SshKeyStatus {
  /** The per-terminal SSH tool is switched on for this terminal. */
  enabled: boolean;
  hasKey: boolean;
  publicKey: string | null;
  keyFile: string;
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

export type ToolGroup = 'ai' | 'code' | 'cloud' | 'deploy' | 'services' | 'packages' | 'data' | 'history';

export interface ToolDefinition {
  id: string;
  name: string;
  category: 'cli' | 'history';
  group?: ToolGroup;
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

/** The 20 terminal colours a theme defines (hex, #rrggbb). */
export const THEME_COLOR_KEYS = [
  'background', 'foreground', 'cursor', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/** A terminal theme the user made in the theme editor. Usable by every terminal. */
export interface CustomTheme {
  /** "custom:<uuid>" */
  id: string;
  name: string;
  colors: Record<ThemeColorKey, string>;
  /** Image file name inside %LOCALAPPDATA%\OmniTerminal\themes, or '' for none. */
  backgroundImage: string;
  /** How visible the image is, 0..1 (the rest is the background colour on top). */
  imageOpacity: number;
  imageFit: 'cover' | 'contain' | 'tile';
}

export interface AppState {
  daemon: DaemonInfo;
  profiles: Profile[];
  sessions: SessionInfo[];
  shells: ShellInfo[];
  tools: ToolDefinition[];
  limitations: ToolDefinition[];
  settings: AppSettings;
  customThemes: CustomTheme[];
  snippets: Snippet[];
  workspaces: Workspace[];
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
  /** Missing in exports from before 1.3.1. */
  restoreCommand?: string;
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
