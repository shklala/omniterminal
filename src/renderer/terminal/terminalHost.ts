import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import type { Appearance } from '../../shared/types';
import { api, bridge, errorMessage } from '../api';
import { findCustomTheme, getTheme } from '../themes';
import { cleanTitle, looksLikeAdminNeeded } from '../util';
import { createLinkProvider, lastLink } from './links';

export type HostState = 'connecting' | 'attached' | 'exited' | 'error' | 'detached';
/** Unseen activity in a background tab: new output, or the program rang the bell (wants attention). */
export type Activity = 'none' | 'output' | 'bell';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

/**
 * One xterm.js instance bound to one terminal profile. Lives outside React so switching tabs
 * never re-creates the terminal or loses its buffer.
 */
export class TerminalHost {
  readonly term: Terminal;
  readonly el: HTMLDivElement;
  private readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  private webgl: WebglAddon | null = null;
  private webglFailed = false;
  private opened = false;
  private sessionId: string | null = null;
  private resizeTimer: number | null = null;
  private observer: ResizeObserver | null = null;
  /** Keystrokes typed while attaching; flushed once the session is attached. */
  private pendingInput = '';
  state: HostState = 'detached';
  activity: Activity = 'none';
  /** Title set by the running program (OSC 0/2), e.g. "claude" or "vim notes.txt". */
  title = '';
  private visible = false;
  private windowWasFocused = true;
  private baseFontSize: number;
  private parentEl: HTMLElement | null = null;
  private appearance: Appearance;
  onStateChange: (s: HostState) => void = () => undefined;
  /** Fired when activity or title changes (for indicators and notifications). */
  onActivity: (a: Activity) => void = () => undefined;
  /** Fired (at most once a minute) when output suggests the command needs administrator rights. */
  onNeedsAdmin: () => void = () => undefined;
  private lastAdminHint = 0;
  /** Global shortcuts handled by the app (returns true if consumed). */
  onAppShortcut: (e: KeyboardEvent) => boolean = () => false;
  /** The terminal got keyboard focus (used to track the focused pane of a split tab). */
  onFocus: () => void = () => undefined;
  /** Everything the user types or pastes (used to mirror input to other panes when broadcasting). */
  onUserInput: (data: string) => void = () => undefined;
  /** A command that ran at least `notifyAfterMs` finished (the prompt came back). */
  onCommandDone: (durationMs: number) => void = () => undefined;
  /** Shared by all terminals; 0 turns the "command finished" detection off. */
  static notifyAfterMs = 15_000;
  /** The command line when Enter was pressed, and when. */
  private pendingCommand: { line: string; at: number } | null = null;
  private lastOutputAt = 0;
  private idleTimer: number | null = null;

  constructor(readonly profileId: string, appearance: Appearance, scrollback = 5000) {
    this.baseFontSize = appearance.fontSize;
    this.appearance = appearance;
    this.el = document.createElement('div');
    this.el.className = 'xterm-host';
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      cursorStyle: appearance.cursorStyle,
      cursorBlink: appearance.cursorBlink,
      theme: terminalTheme(appearance.theme),
      // The session manager keeps the authoritative scrollback; the view never needs more.
      scrollback,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      windowsPty: { backend: 'conpty' },
      allowTransparency: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    // Links open with a plain click, except the click that only brings the window to the front.
    this.term.registerLinkProvider(createLinkProvider(this.term, (url) => void bridge.openExternal(url), () => this.windowWasFocused));
    this.el.addEventListener('mousedown', () => (this.windowWasFocused = document.hasFocus()), true);

    this.term.onBell(() => this.markActivity('bell'));
    this.term.onTitleChange((t) => {
      // Shells often set the title to their own executable path; that is noise, not information.
      this.title = cleanTitle(t);
      this.onActivity(this.activity);
    });
    this.term.onData((data) => this.input(data));
    this.term.onBinary((data) => this.input(data));
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.term.hasSelection()) this.copySelection();
      else void this.paste();
    });
  }

  private setState(s: HostState): void {
    this.state = s;
    if (s === 'attached' && this.pendingInput) {
      bridge.write(this.profileId, this.pendingInput);
      this.pendingInput = '';
    } else if (s !== 'connecting') {
      this.pendingInput = '';
    }
    this.onStateChange(s);
  }

  private input(data: string): void {
    if (this.state === 'attached') {
      bridge.write(this.profileId, data);
      this.onUserInput(data);
      if (data.includes('\r')) this.noteEnter();
    } else if (this.state === 'connecting') {
      this.pendingInput += data;
    } else if (this.state === 'exited' && (data === '\r' || data === '\n')) {
      void this.restart();
    }
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    if (this.onAppShortcut(e)) return false;
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && e.shiftKey && key === 'c') {
      e.preventDefault();
      this.copySelection();
      return false;
    }
    if (ctrl && key === 'v') {
      // Ctrl+V and Ctrl+Shift+V paste (Windows Terminal behaviour).
      e.preventDefault();
      void this.paste();
      return false;
    }
    if (ctrl && !e.shiftKey && key === 'c' && this.term.hasSelection()) {
      // Ctrl+C copies when text is selected; otherwise it is sent to the shell as SIGINT.
      e.preventDefault();
      this.copySelection();
      return false;
    }
    return true;
  }

  /** Input mirrored from another pane (broadcast). Never re-broadcast. */
  sendInput(data: string): void {
    if (this.state !== 'attached') return;
    bridge.write(this.profileId, data);
    if (data.includes('\r')) this.noteEnter();
  }

  /** Full logical line at the cursor (joins wrapped rows), up to the cursor. */
  private cursorLine(): string {
    const buf = this.term.buffer.active;
    let y = buf.baseY + buf.cursorY;
    let text = buf.getLine(y)?.translateToString(true, 0, buf.cursorX) ?? '';
    while (y > 0 && buf.getLine(y)?.isWrapped) {
      y--;
      text = (buf.getLine(y)?.translateToString(false) ?? '') + text;
    }
    return text;
  }

  private noteEnter(): void {
    if (this.term.buffer.active.type !== 'normal') return; // full-screen programs (vim, claude) manage themselves
    this.pendingCommand = { line: this.cursorLine(), at: Date.now() };
  }

  /**
   * After output goes quiet, a command is "done" when the prompt is back: the cursor line is the
   * start of the line where Enter was pressed (the prompt without the command). Works in any shell
   * without changing its prompt.
   */
  private checkCommandDone(): void {
    const cmd = this.pendingCommand;
    if (!cmd || this.term.buffer.active.type !== 'normal') return;
    const prompt = this.cursorLine().trimEnd();
    if (!prompt || !cmd.line.trimEnd().startsWith(prompt) || cmd.line.trimEnd() === prompt) return;
    this.pendingCommand = null;
    const took = this.lastOutputAt - cmd.at;
    if (TerminalHost.notifyAfterMs > 0 && took >= TerminalHost.notifyAfterMs) this.onCommandDone(took);
  }

  /** The most recent web link printed in this terminal, if any. */
  lastLink(): string | null {
    return lastLink(this.term);
  }

  copySelection(): void {
    const text = this.term.getSelection();
    if (text) void bridge.clipboardWrite(text);
    this.term.clearSelection();
  }

  async paste(): Promise<void> {
    const text = await bridge.clipboardRead();
    if (text) this.term.paste(text);
  }

  mount(parent: HTMLElement): void {
    if (this.el.parentElement !== parent) parent.appendChild(this.el);
    if (this.parentEl !== parent) {
      this.parentEl = parent;
      void this.paintBackground();
    }
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
      this.term.textarea?.addEventListener('focus', () => this.onFocus());
      if (this.visible) this.enableWebgl();
      this.observer = new ResizeObserver(() => this.scheduleFit());
      this.observer.observe(this.el);
    }
  }

  /**
   * GPU rendering only for the tab on screen. Each WebGL context holds its own glyph atlas and GPU
   * buffers (and Chromium caps live contexts at ~16), so hidden tabs fall back to the cheap DOM
   * renderer and get WebGL back when shown.
   */
  private enableWebgl(): void {
    if (this.webgl || !this.opened || this.webglFailed) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => this.disableWebgl());
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webglFailed = true; // DOM renderer fallback
    }
  }

  private disableWebgl(): void {
    if (!this.webgl) return;
    try {
      this.webgl.dispose();
    } catch {
      /* already disposed */
    }
    this.webgl = null;
  }

  /** Called when the tab becomes visible/hidden; visible tabs never show activity markers. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.enableWebgl();
    else this.disableWebgl();
    if (visible && this.activity !== 'none') {
      this.activity = 'none';
      this.onActivity('none');
    }
  }

  private markActivity(kind: Activity): void {
    if (kind === 'bell') {
      // A bell always counts (even when visible but the window is in the background).
      if (this.visible && document.hasFocus()) return;
      this.activity = 'bell';
      this.onActivity('bell');
    } else if (!this.visible && this.activity === 'none') {
      this.activity = 'output';
      this.onActivity('output');
    }
  }

  /** Marks the tab as wanting attention (e.g. a long command finished in the background). */
  flagAttention(): void {
    this.markActivity('bell');
  }

  /** Ctrl+= / Ctrl+- / Ctrl+0 zoom (per tab, not saved). */
  zoom(delta: number | 'reset'): void {
    const size = delta === 'reset' ? this.baseFontSize : Math.max(6, Math.min(48, (this.term.options.fontSize ?? 14) + delta));
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  /**
   * Paints the area behind the terminal: the theme colour, or for custom themes with a picture,
   * the picture with the theme colour layered on top (so imageOpacity controls how visible it is).
   */
  private async paintBackground(): Promise<void> {
    const el = this.parentEl;
    if (!el) return;
    const custom = findCustomTheme(this.appearance.theme);
    const bg = custom?.colors.background ?? (getTheme(this.appearance.theme).background as string) ?? '#181818';
    el.style.backgroundColor = bg;
    if (!custom?.backgroundImage) {
      el.style.backgroundImage = '';
      return;
    }
    const url = await themeImage(custom.backgroundImage);
    if (!url || this.parentEl !== el || findCustomTheme(this.appearance.theme)?.id !== custom.id) return;
    const veil = hexToRgba(bg, 1 - custom.imageOpacity);
    el.style.backgroundImage = `linear-gradient(${veil}, ${veil}), url("${url}")`;
    el.style.backgroundRepeat = custom.imageFit === 'tile' ? 'repeat' : 'no-repeat';
    el.style.backgroundSize = custom.imageFit === 'tile' ? 'auto, auto' : `100% 100%, ${custom.imageFit}`;
    el.style.backgroundPosition = 'center';
  }

  /** Re-applies the current theme (after a custom theme was edited). */
  refreshTheme(): void {
    this.applyAppearance(this.appearance);
  }

  applyAppearance(a: Appearance): void {
    this.appearance = a;
    void this.paintBackground();
    this.baseFontSize = a.fontSize;
    this.term.options.fontFamily = a.fontFamily;
    this.term.options.fontSize = a.fontSize;
    this.term.options.cursorStyle = a.cursorStyle;
    this.term.options.cursorBlink = a.cursorBlink;
    this.term.options.theme = terminalTheme(a.theme);
    this.scheduleFit();
  }

  focus(): void {
    this.term.focus();
  }

  scheduleFit(): void {
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.fitNow(), 40);
  }

  fitNow(): void {
    if (!this.opened || this.el.offsetWidth === 0 || this.el.offsetHeight === 0) return;
    const before = `${this.term.cols}x${this.term.rows}`;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (this.state === 'attached' && before !== `${this.term.cols}x${this.term.rows}`) {
      void api.resize(this.profileId, this.term.cols, this.term.rows).catch(() => undefined);
    }
  }

  /** Attaches to the session (optionally starting it) and renders the server-side snapshot. */
  async connect(autoStart: boolean): Promise<void> {
    if (this.state === 'connecting') return;
    this.setState('connecting');
    this.fitNow();
    try {
      const { session, snapshot } = await api.attach(this.profileId, this.term.cols, this.term.rows, autoStart);
      this.sessionId = session.sessionId;
      this.term.reset();
      this.term.write(snapshot);
      if (session.state === 'exited') {
        this.showExited(session.exitCode);
      } else {
        this.setState('attached');
        // Make sure the PTY matches our real size after layout settles.
        this.fitNow();
        void api.resize(this.profileId, this.term.cols, this.term.rows).catch(() => undefined);
      }
    } catch (e) {
      const msg = errorMessage(e);
      if (/not running/i.test(msg)) {
        this.term.write(`\r\n${DIM}[session is not running — press Enter to start it]${RESET}\r\n`);
        this.setState('exited');
      } else {
        this.term.write(`\r\n\x1b[31m[could not connect: ${msg}]${RESET}\r\n`);
        this.setState('error');
      }
    }
  }

  async restart(): Promise<void> {
    this.term.reset();
    this.sessionId = null;
    await this.connect(true);
  }

  /** Restarts the shell; with `elevated`, through Windows sudo so it runs as administrator. */
  async restartSession(elevated = false): Promise<void> {
    this.setState('connecting');
    try {
      await api.restart(this.profileId, this.term.cols, this.term.rows, elevated);
    } catch (e) {
      this.term.write(`\r\n\x1b[31m[restart failed: ${errorMessage(e)}]${RESET}\r\n`);
    }
    this.state = 'detached';
    await this.connect(false);
  }

  handleData(sessionId: string, data: string): void {
    if (this.state !== 'attached' || sessionId !== this.sessionId) return;
    this.term.write(data);
    this.markActivity('output');
    if (this.pendingCommand) {
      this.lastOutputAt = Date.now();
      if (this.idleTimer) window.clearTimeout(this.idleTimer);
      // xterm parses writes asynchronously; check once output has been quiet for a moment.
      this.idleTimer = window.setTimeout(() => this.checkCommandDone(), 1200);
    }
    if (Date.now() - this.lastAdminHint > 60_000 && data.length < 64_000 && looksLikeAdminNeeded(data)) {
      this.lastAdminHint = Date.now();
      this.onNeedsAdmin();
    }
  }

  handleExit(sessionId: string, exitCode: number | null): void {
    if (sessionId !== this.sessionId) return;
    this.showExited(exitCode);
  }

  private showExited(exitCode: number | null): void {
    this.term.write(`\r\n${DIM}[process exited with code ${exitCode ?? '?'} — press Enter to restart]${RESET}\r\n`);
    this.setState('exited');
  }

  /** Called when the session manager connection was lost and re-established. */
  async onManagerReconnected(): Promise<void> {
    if (this.state === 'exited') return;
    this.state = 'detached';
    await this.connect(false);
  }

  markManagerLost(): void {
    if (this.state === 'attached') {
      this.term.write(`\r\n${DIM}[session manager connection lost — reconnecting…]${RESET}\r\n`);
      this.setState('detached');
    }
  }

  dispose(detach = true): void {
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    if (detach && this.state === 'attached') void api.detach(this.profileId).catch(() => undefined);
    this.observer?.disconnect();
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
  }
}

export const hosts = new Map<string, TerminalHost>();

/** xterm theme; when the theme has a background picture the canvas is transparent so it shows through. */
function terminalTheme(id: string) {
  const theme = getTheme(id);
  return findCustomTheme(id)?.backgroundImage ? { ...theme, background: '#00000000' } : theme;
}

const imageCache = new Map<string, Promise<string | null>>();
function themeImage(name: string): Promise<string | null> {
  let p = imageCache.get(name);
  if (!p) {
    p = bridge.themeImageUrl(name).catch(() => null);
    imageCache.set(name, p);
  }
  return p;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${Math.max(0, Math.min(1, alpha))})`;
}
