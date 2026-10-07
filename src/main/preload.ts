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
  focusWindow: (): Promise<void> => ipcRenderer.invoke('omni:focus-window'),
};

contextBridge.exposeInMainWorld('omni', api);

export type OmniApi = typeof api;
