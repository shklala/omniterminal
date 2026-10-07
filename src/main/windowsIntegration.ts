import { app } from 'electron';

export const DAEMON_ONLY_FLAG = '--daemon-only';

/** Registers/unregisters "Start OmniTerminal Session Manager with Windows" (HKCU Run key). */
export function setAutostart(enabled: boolean): void {
  const args = app.isPackaged ? [DAEMON_ONLY_FLAG] : [app.getAppPath(), DAEMON_ONLY_FLAG];
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args,
    name: 'OmniTerminal Session Manager',
  });
}

export function getAutostart(): boolean {
  const args = app.isPackaged ? [DAEMON_ONLY_FLAG] : [app.getAppPath(), DAEMON_ONLY_FLAG];
  return app.getLoginItemSettings({ path: process.execPath, args }).openAtLogin;
}
