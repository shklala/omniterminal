/**
 * Customizable keyboard shortcuts. Combos are written like "Ctrl+Shift+P" and matched on the
 * physical key (KeyboardEvent.code), so they work the same with Arabic or other keyboard layouts.
 */
export interface ShortcutAction {
  id: string;
  label: string;
  defaultKeys: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'app.palette', label: 'Command palette', defaultKeys: 'Ctrl+Shift+P' },
  { id: 'terminal.new', label: 'New terminal', defaultKeys: 'Ctrl+Shift+T' },
  { id: 'terminal.another', label: 'Another shell of this terminal', defaultKeys: 'Ctrl+Shift+D' },
  { id: 'tab.close', label: 'Close tab or pane (keeps running)', defaultKeys: 'Ctrl+Shift+W' },
  { id: 'tab.next', label: 'Next tab', defaultKeys: 'Ctrl+Tab' },
  { id: 'tab.prev', label: 'Previous tab', defaultKeys: 'Ctrl+Shift+Tab' },
  { id: 'app.dashboard', label: 'All terminals', defaultKeys: 'Ctrl+Shift+A' },
  { id: 'terminal.find', label: 'Find in output', defaultKeys: 'Ctrl+Shift+F' },
  { id: 'pane.splitRight', label: 'Split right', defaultKeys: 'Alt+Shift+=' },
  { id: 'pane.splitDown', label: 'Split down', defaultKeys: 'Alt+Shift+-' },
  { id: 'pane.focusNext', label: 'Next pane', defaultKeys: 'Alt+Right' },
  { id: 'pane.focusPrev', label: 'Previous pane', defaultKeys: 'Alt+Left' },
  { id: 'pane.broadcast', label: 'Type into all panes of this tab', defaultKeys: 'Ctrl+Shift+B' },
  { id: 'app.snippets', label: 'Run a snippet', defaultKeys: 'Ctrl+Shift+S' },
  { id: 'terminal.history', label: 'Earlier commands of this terminal', defaultKeys: 'Ctrl+Shift+H' },
  { id: 'terminal.accounts', label: 'Accounts in this terminal', defaultKeys: 'Ctrl+Shift+I' },
  { id: 'app.settings', label: 'OmniTerminal settings', defaultKeys: 'Ctrl+,' },
  { id: 'zoom.in', label: 'Zoom in', defaultKeys: 'Ctrl+=' },
  { id: 'zoom.out', label: 'Zoom out', defaultKeys: 'Ctrl+-' },
  { id: 'zoom.reset', label: 'Reset zoom', defaultKeys: 'Ctrl+0' },
];

const CODE_NAMES: Record<string, string> = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace',
  NumpadAdd: '=', NumpadSubtract: '-',
};

/** The key part of a combo, or null for modifier-only presses. */
export function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_NAMES[code] ?? null;
}

/** "Ctrl+Alt+Shift+K" for a key event; null if only modifiers are held. */
export function comboFromEvent(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean);
  return [...mods, key].join('+');
}

/** Normalizes user/stored text ("shift+ctrl+p" -> "Ctrl+Shift+P"). */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" style: a trailing "+" key.
  if (combo.endsWith('++')) parts.push('=');
  const has = (m: string) => parts.some((p) => p.toLowerCase() === m.toLowerCase());
  const key = parts.filter((p) => !['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'cmd'].includes(p.toLowerCase())).pop() ?? '';
  const k = key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1);
  const mods = [has('ctrl') || has('control') ? 'Ctrl' : '', has('alt') ? 'Alt' : '', has('shift') ? 'Shift' : '', has('win') || has('meta') || has('cmd') ? 'Win' : ''].filter(Boolean);
  return k ? [...mods, k === '+' ? '=' : k].join('+') : '';
}

/** Effective combo per action (custom overrides; '' = disabled). */
export function effectiveBindings(custom: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of SHORTCUT_ACTIONS) {
    const v = Object.prototype.hasOwnProperty.call(custom, a.id) ? custom[a.id] : a.defaultKeys;
    m.set(a.id, v ? normalizeCombo(v) : '');
  }
  return m;
}

/** Action id for a key event, if any. */
export function actionForEvent(e: KeyboardEvent, bindings: Map<string, string>): string | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const [id, keys] of bindings) if (keys && keys === combo) return id;
  return null;
}

/** Actions that share a combo (shown as a warning in settings). */
export function conflicts(bindings: Map<string, string>): Set<string> {
  const seen = new Map<string, string>();
  const out = new Set<string>();
  for (const [id, keys] of bindings) {
    if (!keys) continue;
    const other = seen.get(keys);
    if (other) {
      out.add(id);
      out.add(other);
    } else seen.set(keys, id);
  }
  return out;
}

/** Shell-reserved combos that would stop reaching programs if bound (warned about, not blocked). */
export function shadowsTerminalKey(combo: string): boolean {
  return /^Ctrl\+[A-Z]$/.test(combo) || /^Ctrl\+[[\]\\]$/.test(combo);
}
