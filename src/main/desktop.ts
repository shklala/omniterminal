// Tray icon, global show/hide shortcut (with drop-down mode) and automatic updates.
// Settings come from the session manager; this module only reacts to them.

import { BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSettings } from '../shared/types';

export interface DesktopHost {
  getWindow(): BrowserWindow | null;
  createWindow(): void;
  /** Sends a command to the renderer ("new-terminal", "exit"). */
  command(name: string): void;
  notice(text: string): void;
  /** Saves every screen and stops the session manager without stopping terminals. */
  handoffSessions(): Promise<void>;
  markQuitting(): void;
  iconPath: string;
}

export type UpdateState = 'idle' | 'disabled' | 'portable' | 'dev' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  progress?: number;
  message?: string;
}

export class Desktop {
  private settings: AppSettings | null = null;
  private tray: Tray | null = null;
  private hotkey = '';
  private dropDownShown = false;
  private updateTimer: NodeJS.Timeout | null = null;
  private updater: typeof import('electron-updater').autoUpdater | null = null;
  status: UpdateStatus = { state: 'idle' };
  onUpdateStatus: (s: UpdateStatus) => void = () => undefined;

  constructor(private readonly host: DesktopHost) {}

  /** Closing the window hides it to the tray instead of quitting the GUI. */
  get keepInTray(): boolean {
    return !!this.settings?.minimizeToTray;
  }

  get inDropDown(): boolean {
    return this.dropDownShown;
  }

  apply(settings: AppSettings): void {
    const prev = this.settings;
    this.settings = settings;
    this.applyTray();
    if (!prev || prev.globalHotkey !== settings.globalHotkey) this.applyHotkey();
    if (!prev || prev.autoUpdate !== settings.autoUpdate) this.applyUpdates();
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.tray?.destroy();
    this.tray = null;
    if (this.updateTimer) clearInterval(this.updateTimer);
  }

  // ---------- tray ----------
  private applyTray(): void {
    const want = !!(this.settings?.minimizeToTray || this.settings?.globalHotkey);
    if (!want) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (!this.tray) {
      this.tray = new Tray(nativeImage.createFromPath(this.host.iconPath));
      this.tray.setToolTip('OmniTerminal');
      this.tray.on('click', () => this.show());
    }
    const hk = this.settings?.globalHotkey ? `\t${this.settings.globalHotkey}` : '';
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Show OmniTerminal${hk}`, click: () => this.show() },
        { label: 'New terminal…', click: () => { this.show(); this.host.command('new-terminal'); } },
        { type: 'separator' },
        // app.quit() goes through the normal goodbye to the session manager (main.ts before-quit).
        { label: 'Close window (terminals keep running)', click: () => app.quit() },
        { label: 'Exit completely…', click: () => { this.show(); this.host.command('exit'); } },
      ]),
    );
  }

  // ---------- global shortcut ----------
  private applyHotkey(): void {
    if (this.hotkey) globalShortcut.unregister(this.hotkey);
    this.hotkey = '';
    const accel = toAccelerator(this.settings?.globalHotkey ?? '');
    if (!accel) return;
    try {
      if (globalShortcut.register(accel, () => this.toggle())) this.hotkey = accel;
      else this.host.notice(`The shortcut ${this.settings?.globalHotkey} is already used by another app. Pick a different one in Settings.`);
    } catch {
      this.host.notice(`${this.settings?.globalHotkey} cannot be used as a system-wide shortcut.`);
    }
  }

  show(): void {
    let win = this.host.getWindow();
    if (!win) {
      this.host.createWindow();
      win = this.host.getWindow();
    }
    if (!win) return;
    if (this.settings?.dropDown && this.settings.globalHotkey) this.placeDropDown(win);
    else if (this.dropDownShown) this.leaveDropDown(win);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  private toggle(): void {
    const win = this.host.getWindow();
    if (win && win.isVisible() && win.isFocused() && !win.isMinimized()) {
      if (this.dropDownShown || this.keepInTray) win.hide();
      else win.minimize();
      return;
    }
    this.show();
  }

  /** Top half of the screen the mouse is on, above other windows; hides again when it loses focus. */
  private placeDropDown(win: BrowserWindow): void {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    if (win.isMaximized()) win.unmaximize();
    win.setBounds({ x: area.x, y: area.y, width: area.width, height: Math.round(area.height * 0.5) });
    win.setAlwaysOnTop(true, 'floating');
    win.setSkipTaskbar(true);
    if (!this.dropDownShown) win.on('blur', this.hideOnBlur);
    this.dropDownShown = true;
  }

  private leaveDropDown(win: BrowserWindow): void {
    win.removeListener('blur', this.hideOnBlur);
    win.setAlwaysOnTop(false);
    win.setSkipTaskbar(false);
    this.dropDownShown = false;
  }

  private hideOnBlur = (): void => {
    const win = this.host.getWindow();
    // Dialogs (file pickers) also blur the window; only hide when no child window is open.
    if (win && this.dropDownShown && win.getChildWindows().length === 0) win.hide();
  };

  // ---------- automatic updates ----------
  private setStatus(s: UpdateStatus): void {
    this.status = s;
    this.onUpdateStatus(s);
  }

  /** Installed copies have an uninstaller next to the exe; the portable zip does not. */
  private isPortable(): boolean {
    return !fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall OmniTerminal.exe'));
  }

  private applyUpdates(): void {
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.updateTimer = null;
    if (!app.isPackaged) return this.setStatus({ state: 'dev' });
    if (this.isPortable()) return this.setStatus({ state: 'portable' });
    if (!this.settings?.autoUpdate) return this.setStatus({ state: this.status.state === 'ready' ? 'ready' : 'disabled', version: this.status.version });
    setTimeout(() => void this.checkForUpdates(), 15_000);
    this.updateTimer = setInterval(() => void this.checkForUpdates(), 6 * 60 * 60 * 1000);
    this.updateTimer.unref();
  }

  private async getUpdater() {
    if (this.updater) return this.updater;
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false; // terminals are handed over first; see install()
    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.setStatus({ state: 'none' }));
    autoUpdater.on('update-available', (i) => this.setStatus({ state: 'downloading', version: i.version, progress: 0 }));
    autoUpdater.on('download-progress', (p) => this.setStatus({ state: 'downloading', version: this.status.version, progress: p.percent }));
    autoUpdater.on('update-downloaded', (i) => this.setStatus({ state: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => this.setStatus({ state: 'error', message: shortError(e) }));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!app.isPackaged) return this.status;
    if (this.isPortable()) return this.status;
    if (this.status.state === 'ready' || this.status.state === 'downloading') return this.status;
    try {
      await (await this.getUpdater()).checkForUpdates();
    } catch (e) {
      this.setStatus({ state: 'error', message: shortError(e) });
    }
    return this.status;
  }

  /** Saves terminal screens, stops the session manager without stopping terminals, then installs. */
  async install(): Promise<void> {
    if (this.status.state !== 'ready' || !this.updater) throw new Error('No update is ready to install.');
    await this.host.handoffSessions();
    this.host.markQuitting();
    this.updater.quitAndInstall(true, true);
  }
}

/** "Ctrl+Alt+T" -> Electron accelerator ("Ctrl+Alt+T"; Win -> Super). */
export function toAccelerator(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  if (!key) return '';
  const mods = parts.map((m) => (m === 'Win' ? 'Super' : m));
  if (mods.length === 0) return ''; // a bare key system-wide would swallow normal typing
  const k = ({ '=': '=', '-': '-', Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down' } as Record<string, string>)[key] ?? key;
  return [...mods, k].join('+');
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::/i.test(msg)) return 'no internet connection';
  if (/404|latest\.yml/i.test(msg)) return 'no update information published for this version yet';
  return msg.split('\n')[0].slice(0, 160);
}
