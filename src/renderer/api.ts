import type { AppState, Profile, ProfileInput, SessionInfo } from '../shared/types';

export interface AppInfo {
  version: string;
  electron: string;
  isPackaged: boolean;
  home: string;
  profiles: string;
  autostart: boolean;
}

export interface ElevationStatus {
  managerElevated: boolean;
  sudo: 'unavailable' | 'disabled' | 'newWindow' | 'inputClosed' | 'inline';
  sudoPath: string;
}

export interface UpdateStatus {
  state: 'idle' | 'disabled' | 'portable' | 'dev' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  progress?: number;
  message?: string;
}

export interface DaemonStatus {
  connected: boolean;
  pid: number | null;
  message: string;
}

interface OmniBridge {
  invoke<T = unknown>(method: string, params?: unknown): Promise<T>;
  write(profileId: string, data: string): void;
  onEvent(handler: (event: string, data: unknown) => void): () => void;
  onDaemonStatus(handler: (s: DaemonStatus) => void): () => void;
  daemonStatus(): Promise<DaemonStatus>;
  appInfo(): Promise<AppInfo>;
  pickDirectory(defaultPath?: string): Promise<string | null>;
  pickFile(title?: string): Promise<string | null>;
  exportProfiles(ids?: string[]): Promise<boolean>;
  importProfiles(): Promise<number | null>;
  openPath(p: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  setAutostart(enabled: boolean): Promise<boolean>;
  exitCompletely(): Promise<void>;
  quitGui(): Promise<void>;
  attention(): Promise<void>;
  setTitleBar(theme: string): Promise<void>;
  pickThemeImage(): Promise<string | null>;
  themeImageUrl(name: string): Promise<string | null>;
  enableSudo(): Promise<{ ok: boolean; status: ElevationStatus }>;
  openElevatedWindow(cwd: string): Promise<boolean>;
  focusWindow(): Promise<void>;
  hibernateStatus(): Promise<boolean>;
  enableHibernate(): Promise<boolean>;
  hibernate(): Promise<void>;
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdateStatus(handler: (s: UpdateStatus) => void): () => void;
  onCommand(handler: (name: string) => void): () => void;
  onNotice(handler: (text: string) => void): () => void;
}

declare global {
  interface Window {
    omni: OmniBridge;
  }
}

export const bridge = window.omni;

/** Strips Electron's "Error invoking remote method ...: Error:" prefix for display. */
export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

export const api = {
  getState: () => bridge.invoke<AppState>('app.getState'),
  createProfile: (profile: ProfileInput) => bridge.invoke<Profile>('profiles.create', { profile }),
  updateProfile: (id: string, patch: Partial<Profile>) => bridge.invoke<Profile>('profiles.update', { id, patch }),
  renameProfile: (id: string, name: string) => bridge.invoke<Profile>('profiles.rename', { id, name }),
  deleteProfile: (id: string, deleteFiles: boolean) => bridge.invoke<boolean>('profiles.delete', { id, deleteFiles }),
  duplicateProfile: (id: string, name?: string) => bridge.invoke<Profile>('profiles.duplicate', { id, name }),
  reorder: (ids: string[]) => bridge.invoke('profiles.reorder', { ids }),
  attach: (profileId: string, cols: number, rows: number, autoStart: boolean) =>
    bridge.invoke<{ session: SessionInfo; snapshot: string }>('sessions.attach', { profileId, cols, rows, autoStart }),
  detach: (profileId: string) => bridge.invoke('sessions.detach', { profileId }),
  resize: (profileId: string, cols: number, rows: number) => bridge.invoke('sessions.resize', { profileId, cols, rows }),
  start: (profileId: string) => bridge.invoke<SessionInfo>('sessions.start', { profileId }),
  stop: (profileId: string) => bridge.invoke('sessions.stop', { profileId }),
  restart: (profileId: string, cols?: number, rows?: number, elevated = false) =>
    bridge.invoke<SessionInfo>('sessions.restart', { profileId, cols, rows, elevated }),
  setSettings: (settings: Record<string, unknown>) => bridge.invoke('settings.set', { settings }),
  getUiPrefs: () => bridge.invoke<Record<string, unknown>>('uiPrefs.get'),
  setUiPref: (key: string, value: unknown) => bridge.invoke('uiPrefs.set', { key, value }),
  refreshShells: () => bridge.invoke('shells.refresh'),
};
