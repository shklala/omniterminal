// OmniTerminal GUI (Electron main process). Owns windows only — never terminal processes.

import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_VERSION } from '../shared/defaults';
import { getAppPaths } from '../shared/paths';
import { isPathInside } from '../shared/validation';
import { DaemonBridge } from './daemonBridge';
import { DAEMON_ONLY_FLAG, getAutostart, setAutostart } from './windowsIntegration';
import { Desktop } from './desktop';
import type { AppSettings } from '../shared/types';

const paths = getAppPaths();
const appDir = app.getAppPath();
const bridge = new DaemonBridge(paths, DaemonBridge.spawnSpecFor(process.execPath, appDir));
const daemonOnly = process.argv.includes(DAEMON_ONLY_FLAG);
let win: BrowserWindow | null = null;
let quitting = false;

const send = (channel: string, ...args: unknown[]) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

const desktop = new Desktop({
  getWindow: () => win,
  createWindow: () => createWindow(),
  command: (name) => send('omni:command', name),
  notice: (text) => send('omni:notice', text),
  markQuitting: () => (quitting = true),
  iconPath: path.join(appDir, 'build', 'icon.ico'),
  async handoffSessions() {
    // The session manager saves every screen and exits, leaving terminals recorded as running;
    // the updated version's manager restores them on its first start.
    await bridge.call('daemon.handoff').catch(() => undefined);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && fs.existsSync(paths.daemonInfo)) await new Promise((r) => setTimeout(r, 150));
  },
});
desktop.onUpdateStatus = (s) => send('omni:update-status', s);

async function refreshDesktopSettings(): Promise<void> {
  try {
    desktop.apply(await bridge.call<AppSettings>('settings.get'));
  } catch {
    /* manager not connected yet */
  }
}

app.setAppUserModelId('com.omniterminal.app');
// Dev/test instances (custom OMNITERMINAL_HOME) get their own Chromium profile and single-instance lock.
if (process.env.OMNITERMINAL_HOME) app.setPath('userData', path.join(paths.home, 'electron'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes(DAEMON_ONLY_FLAG)) return;
    desktop.show();
  });
  void app.whenReady().then(onReady);
}

// ---------- window state ----------

interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }
const windowStateFile = path.join(paths.home, 'window-state.json');

function loadWindowState(): WindowState {
  try {
    return { width: 1280, height: 800, maximized: false, ...JSON.parse(fs.readFileSync(windowStateFile, 'utf8')) };
  } catch {
    return { width: 1280, height: 800, maximized: false };
  }
}

function saveWindowState(): void {
  if (!win || desktop.inDropDown) return; // the drop-down panel's size is not the normal window size
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(paths.home, { recursive: true });
    fs.writeFileSync(windowStateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* non-critical */
  }
}

function createWindow(): void {
  const st = loadWindowState();
  win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#1a1a1a',
    title: 'OmniTerminal',
    icon: path.join(appDir, 'build', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1a1a1a', symbolColor: '#d6d6d6', height: 40 },
    show: false,
    webPreferences: {
      preload: path.join(appDir, 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    saveWindowState();
    // "Keep in the notification area": hide instead of closing the GUI.
    if (!quitting && desktop.keepInTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => (win = null));

  // No navigation away from the app; external links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(appDir, 'dist', 'renderer', 'index.html'));

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win?.webContents.toggleDevTools();
  });
}

// ---------- IPC ----------

const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => ipcMain.handle(channel, fn);

const ALLOWED_PREFIXES = [
  'app.', 'profiles.', 'sessions.', 'settings.', 'uiPrefs.', 'shells.', 'themes.', 'snippets.', 'workspaces.', 'ssh.',
  'system.elevation', 'system.suggestions', 'system.installSuggestions', 'ping',
];
const THEME_IMAGE_RE = /^[a-z0-9-]{8,64}\.(png|jpe?g|webp|gif)$/i;
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function registerIpc(): void {
  bridge.on('event', (ev: string, data: unknown) => {
    send('omni:event', ev, data);
    if (ev === 'state.changed' && /\bsettings\b/.test(String((data as { reason?: string })?.reason ?? ''))) void refreshDesktopSettings();
  });
  bridge.on('status', (s: { connected?: boolean }) => {
    send('omni:daemon-status', s);
    if (s?.connected) void refreshDesktopSettings();
  });
  handle('omni:update-status', () => desktop.status);
  handle('omni:update-check', () => desktop.checkForUpdates());
  handle('omni:update-install', () => desktop.install());


  handle('omni:invoke', async (_e, method: string, params: unknown) => {
    if (typeof method !== 'string' || !ALLOWED_PREFIXES.some((p) => method.startsWith(p))) {
      throw new Error(`Method not allowed: ${method}`);
    }
    return bridge.call(method, params);
  });
  ipcMain.on('omni:write', (_e, profileId: string, data: string) => {
    if (typeof profileId === 'string' && typeof data === 'string') bridge.notify('sessions.write', { profileId, data });
  });
  handle('omni:daemon-status', () => bridge.status);
  handle('omni:app-info', () => ({
    version: APP_VERSION,
    electron: process.versions.electron,
    isPackaged: app.isPackaged,
    home: paths.home,
    profiles: paths.profiles,
    autostart: getAutostart(),
  }));
  handle('omni:pick-directory', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('omni:pick-file', async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win!, {
      title: typeof title === 'string' ? title : 'Choose executable',
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('omni:export', async (_e, ids?: string[]) => {
    const json = await bridge.call<string>('profiles.export', { ids });
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export terminal configuration (no credentials)',
      defaultPath: `omniterminal-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'OmniTerminal export', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, json, 'utf8');
    return true;
  });
  handle('omni:import', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import terminal configuration',
      properties: ['openFile'],
      filters: [{ name: 'OmniTerminal export', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 10 * 1024 * 1024) throw new Error('Import file is too large.');
    const created = await bridge.call<unknown[]>('profiles.import', { json: fs.readFileSync(r.filePaths[0], 'utf8') });
    return created.length;
  });
  handle('omni:open-path', async (_e, p: string) => {
    // Only folders that belong to OmniTerminal can be opened from the UI.
    if (typeof p !== 'string' || !(isPathInside(paths.home, p) || path.resolve(p) === path.resolve(paths.home))) {
      throw new Error('Path not allowed');
    }
    fs.mkdirSync(p, { recursive: true });
    return shell.openPath(p);
  });
  handle('omni:open-external', (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    return undefined;
  });
  handle('omni:clipboard-read', () => clipboard.readText());
  handle('omni:clipboard-write', (_e, text: string) => clipboard.writeText(String(text ?? '')));
  handle('omni:set-autostart', async (_e, enabled: boolean) => {
    setAutostart(!!enabled);
    await bridge.call('settings.set', { settings: { autostart: !!enabled } });
    return getAutostart();
  });
  handle('omni:exit-completely', async () => {
    quitting = true;
    await bridge.shutdownDaemon();
    app.exit(0);
  });
  handle('omni:enable-sudo', async () => {
    // One-time, user-initiated: Windows shows a UAC prompt for "sudo config --enable normal".
    const sudoExe = path.join(systemRoot(), 'System32', 'sudo.exe');
    const script = `Start-Process -FilePath '${sudoExe}' -ArgumentList 'config','--enable','normal' -Verb RunAs -Wait -WindowStyle Hidden`;
    const code = await runHiddenPowerShell(script);
    return { ok: code === 0, status: await bridge.call('system.elevation') };
  });
  handle('omni:open-elevated-window', async (_e, cwd: string) => {
    // Fallback when Windows sudo is unavailable: a separate elevated PowerShell window in this folder.
    const dir = typeof cwd === 'string' && cwd && fs.existsSync(cwd) ? cwd : process.env.USERPROFILE || path.parse(systemRoot()).root;
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = `Start-Process -FilePath powershell.exe -Verb RunAs -WorkingDirectory ${q(dir)} -ArgumentList '-NoExit','-Command',${q(`Set-Location -LiteralPath ${q(dir)}`)}`;
    return (await runHiddenPowerShell(script)) === 0;
  });
  handle('omni:set-titlebar', (_e, theme: string) => {
    // Match Windows' native caption buttons and the window background to the UI theme.
    if (!win) return;
    const frames: Record<string, [string, string, string]> = {
      // [caption bar colour, caption symbol colour, window background]
      dark: ['#1a1a1a', '#d6d6d6', '#1a1a1a'],
      light: ['#ebebeb', '#1b1b1b', '#f3f3f3'],
      midnight: ['#0b0f19', '#c9d2e3', '#0f1420'],
      nord: ['#292e39', '#d8dee9', '#2e3440'],
    };
    const [color, symbolColor, bg] = frames[theme] ?? frames.dark;
    win.setTitleBarOverlay({ color, symbolColor, height: 40 });
    win.setBackgroundColor(bg);
  });
  handle('omni:pick-theme-image', async () => {
    // Copies the chosen picture into the app's own themes folder; the theme stores only the file name.
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose a background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!IMAGE_MIME[ext]) throw new Error('Choose a PNG, JPG, WebP or GIF image.');
    if (fs.statSync(src).size > 15 * 1024 * 1024) throw new Error('The image is larger than 15 MB.');
    const dir = path.join(paths.home, 'themes');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.copyFileSync(src, path.join(dir, name));
    return name;
  });
  handle('omni:theme-image-url', (_e, name: string) => {
    if (typeof name !== 'string' || !THEME_IMAGE_RE.test(name)) return null;
    const file = path.join(paths.home, 'themes', name);
    if (!fs.existsSync(file)) return null;
    const ext = path.extname(name).slice(1).toLowerCase();
    return `data:${IMAGE_MIME[ext]};base64,${fs.readFileSync(file).toString('base64')}`;
  });
  handle('omni:attention', () => {
    // Flash the taskbar button until the user focuses the window.
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  handle('omni:focus-window', () => desktop.show());
  handle('omni:quit-gui', () => {
    app.quit();
  });
}

function systemRoot(): string {
  return process.env.SystemRoot || 'C:\\Windows';
}

function runHiddenPowerShell(script: string): Promise<number> {
  return new Promise((resolve) => {
    const ps = path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// ---------- lifecycle ----------

async function onReady(): Promise<void> {
  Menu.setApplicationMenu(null);
  if (daemonOnly) {
    // Autostart at login: make sure the session manager runs, then leave no GUI behind.
    try {
      const c = await bridge.connect();
      await c.call('settings.set', { settings: { autostart: true } }).catch(() => undefined);
      await bridge.goodbye();
    } finally {
      app.exit(0);
    }
    return;
  }
  registerIpc();
  createWindow();
  void bridge.connect();
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => desktop.dispose());

// Closing the GUI never kills terminals: we just say goodbye to the session manager.
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void bridge.goodbye().finally(() => app.exit(0));
});
