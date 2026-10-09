import type { AdvancedSettings, AppSettings, Appearance } from './types';

export const APP_VERSION = '1.4.0';
export const PROTOCOL_VERSION = 1;

export const DEFAULT_APPEARANCE: Appearance = {
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  fontSize: 14,
  theme: 'omni-dark',
  cursorStyle: 'block',
  cursorBlink: true,
};

export const DEFAULT_ADVANCED: AdvancedSettings = {
  persistSession: true,
  scrollback: 5000,
  transcript: false,
  useBundledConpty: false,
  refreshEnvironment: true,
  unsetVars: [],
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autostart: false,
  keepManagerRunning: false,
  defaultShellId: 'powershell',
  defaultCwd: '',
  confirmOnExitCompletely: true,
  uiTheme: 'dark',
  language: 'en',
  restoreAfterRestart: true,
  suggestions: true,
  resumeClaude: true,
  notifyAfterSeconds: 15,
  minimizeToTray: false,
  globalHotkey: '',
  dropDown: false,
  autoUpdate: true,
  keybindings: {},
};

export const PROFILE_COLORS = [
  '#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#94a3b8',
];

export const PROFILE_ICONS = ['terminal', 'cloud', 'code', 'bot', 'briefcase', 'flask', 'rocket', 'shield', 'database', 'globe'];

/** Subdirectories created for every terminal profile. */
export const PROFILE_SUBDIRS = ['config', 'credentials', 'history', 'logs', 'cache', 'environment'] as const;

export const MAX_SCROLLBACK = 100_000;
