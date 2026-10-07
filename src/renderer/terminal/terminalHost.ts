import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import type { Appearance } from '../../shared/types';
import { api, bridge, errorMessage } from '../api';
import { getTheme } from '../themes';
import { SHELL_PATH_TITLE } from '../util';

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
  private baseFontSize: number;
  onStateChange: (s: HostState) => void = () => undefined;
  /** Fired when activity or title changes (for indicators and notifications). */
  onActivity: (a: Activity) => void = () => undefined;
  /** Global shortcuts handled by the app (returns true if consumed). */
  onAppShortcut: (e: KeyboardEvent) => boolean = () => false;

  constructor(readonly profileId: string, appearance: Appearance) {
    this.baseFontSize = appearance.fontSize;
    this.el = document.createElement('div');
    this.el.className = 'xterm-host';
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      cursorStyle: appearance.cursorStyle,
      cursorBlink: appearance.cursorBlink,
      theme: getTheme(appearance.theme),
      scrollback: 10000,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      windowsPty: { backend: 'conpty' },
      allowTransparency: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) void bridge.openExternal(uri);
      }),
    );

    this.term.onBell(() => this.markActivity('bell'));
    this.term.onTitleChange((t) => {
      // Shells often set the title to their own executable path; that is noise, not information.
      this.title = SHELL_PATH_TITLE.test(t.trim()) ? '' : t;
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
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
      try {
        this.webgl = new WebglAddon();
        this.webgl.onContextLoss(() => {
          this.webgl?.dispose();
          this.webgl = null;
        });
        this.term.loadAddon(this.webgl);
      } catch {
        this.webgl = null; // DOM renderer fallback
      }
      this.observer = new ResizeObserver(() => this.scheduleFit());
      this.observer.observe(this.el);
    }
  }

  /** Called when the tab becomes visible/hidden; visible tabs never show activity markers. */
  setVisible(visible: boolean): void {
    this.visible = visible;
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

  /** Ctrl+= / Ctrl+- / Ctrl+0 zoom (per tab, not saved). */
  zoom(delta: number | 'reset'): void {
    const size = delta === 'reset' ? this.baseFontSize : Math.max(6, Math.min(48, (this.term.options.fontSize ?? 14) + delta));
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  applyAppearance(a: Appearance): void {
    this.baseFontSize = a.fontSize;
    this.term.options.fontFamily = a.fontFamily;
    this.term.options.fontSize = a.fontSize;
    this.term.options.cursorStyle = a.cursorStyle;
    this.term.options.cursorBlink = a.cursorBlink;
    this.term.options.theme = getTheme(a.theme);
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

  async restartSession(): Promise<void> {
    this.setState('connecting');
    try {
      await api.restart(this.profileId, this.term.cols, this.term.rows);
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
    if (detach && this.state === 'attached') void api.detach(this.profileId).catch(() => undefined);
    this.observer?.disconnect();
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
  }
}

export const hosts = new Map<string, TerminalHost>();
