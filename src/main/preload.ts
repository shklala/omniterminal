import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type EventHandler = (event: string, data: unknown) => void;

const api = {
  invoke: <T = unknown>(method: string, params?: unknown): Promise<T> => ipcRenderer.invoke('omni:invoke', method, params),
  write: (profileId: string, data: string): void => ipcRenderer.send('omni:write', profileId, data),
  onEvent(handler: EventHandler): () => void {
    const listener = (_e: IpcRendererEvent, ev: string, data: unknown) => handler(ev, data);
    ipcRenderer.on('omni:event', listener);
    return () => ipcRenderer.removeListener('omni:event', listener);
  },
  onDaemonStatus(handler: (s: unknown) => void): () => void {
    const listener = (_e: IpcRendererEvent, s: unknown) => handler(s);
    ipcRenderer.on('omni:daemon-status', listener);
    return () => ipcRenderer.removeListener('omni:daemon-status', listener);
  },
  daemonStatus: () => ipcRenderer.invoke('omni:daemon-status'),
  appInfo: () => ipcRenderer.invoke('omni:app-info'),
  pickDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('omni:pick-directory', defaultPath),
  pickFile: (title?: string): Promise<string | null> => ipcRenderer.invoke('omni:pick-file', title),
  exportProfiles: (ids?: string[]): Promise<boolean> => ipcRenderer.invoke('omni:export', ids),
  importProfiles: (): Promise<number | null> => ipcRenderer.invoke('omni:import'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('omni:open-path', p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('omni:open-external', url),
  clipboardRead: (): Promise<string> => ipcRenderer.invoke('omni:clipboard-read'),
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('omni:clipboard-write', text),
  setAutostart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('omni:set-autostart', enabled),
  exitCompletely: (): Promise<void> => ipcRenderer.invoke('omni:exit-completely'),
  quitGui: (): Promise<void> => ipcRenderer.invoke('omni:quit-gui'),
  attention: (): Promise<void> => ipcRenderer.invoke('omni:attention'),
  setTitleBar: (theme: string): Promise<void> => ipcRenderer.invoke('omni:set-titlebar', theme),
  pickThemeImage: (): Promise<string | null> => ipcRenderer.invoke('omni:pick-theme-image'),
  themeImageUrl: (name: string): Promise<string | null> => ipcRenderer.invoke('omni:theme-image-url', name),
  enableSudo: (): Promise<{ ok: boolean; status: unknown }> => ipcRenderer.invoke('omni:enable-sudo'),
  openElevatedWindow: (cwd: string): Promise<boolean> => ipcRenderer.invoke('omni:open-elevated-window', cwd),
  focusWindow: (): Promise<void> => ipcRenderer.invoke('omni:focus-window'),
  hibernateStatus: (): Promise<boolean> => ipcRenderer.invoke('omni:hibernate-status'),
  enableHibernate: (): Promise<boolean> => ipcRenderer.invoke('omni:enable-hibernate'),
  hibernate: (): Promise<void> => ipcRenderer.invoke('omni:hibernate'),
  updateStatus: () => ipcRenderer.invoke('omni:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('omni:update-check'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('omni:update-install'),
  onUpdateStatus(handler: (s: unknown) => void): () => void {
    const listener = (_e: IpcRendererEvent, s: unknown) => handler(s);
    ipcRenderer.on('omni:update-status', listener);
    return () => ipcRenderer.removeListener('omni:update-status', listener);
  },
  /** Commands from the tray menu ("new-terminal", "exit") and notices ("shortcut already in use"). */
  onCommand(handler: (name: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, name: string) => handler(name);
    ipcRenderer.on('omni:command', listener);
    return () => ipcRenderer.removeListener('omni:command', listener);
  },
  onNotice(handler: (text: string) => void): () => void {
    const listener = (_e: IpcRendererEvent, text: string) => handler(text);
    ipcRenderer.on('omni:notice', listener);
    return () => ipcRenderer.removeListener('omni:notice', listener);
  },
};

contextBridge.exposeInMainWorld('omni', api);

export type OmniApi = typeof api;
