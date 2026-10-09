import { useEffect, useMemo, useState } from 'react';
import type { AppState, InstalledTool, Snippet } from '../../shared/types';
import { api, bridge, errorMessage, type AppInfo, type UpdateStatus } from '../api';
import { LANGUAGES, t } from '../i18n';
import { SHORTCUT_ACTIONS, comboFromEvent, conflicts, effectiveBindings, shadowsTerminalKey } from '../keybindings';
import { cx } from '../util';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export type SettingsTab = 'general' | 'window' | 'shortcuts' | 'snippets' | 'tools' | 'updates';
type Tab = SettingsTab;
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'window', label: 'Window and startup' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'tools', label: 'CLI tools' },
  { id: 'updates', label: 'Updates and data' },
];

export function AppSettingsDialog({
  state,
  onClose,
  onExitCompletely,
  onSaved,
  toast,
  initialTab = 'general',
}: {
  state: AppState;
  onClose: () => void;
  onExitCompletely: () => void;
  onSaved: () => void;
  toast: (m: string) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState(state.settings);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof settings>) => setSettings((s) => ({ ...s, ...patch }));

  useEffect(() => {
    void bridge.appInfo().then((i) => {
      setInfo(i);
      setSettings((s) => ({ ...s, autostart: i.autostart }));
    });
  }, []);

  const save = async () => {
    try {
      if (info && settings.autostart !== info.autostart) await bridge.setAutostart(settings.autostart);
      await api.setSettings({
        keepManagerRunning: settings.keepManagerRunning,
        defaultShellId: settings.defaultShellId,
        defaultCwd: settings.defaultCwd,
        confirmOnExitCompletely: settings.confirmOnExitCompletely,
        uiTheme: settings.uiTheme,
        language: settings.language,
        restoreAfterRestart: settings.restoreAfterRestart,
        resumeClaude: settings.resumeClaude,
        suggestions: settings.suggestions,
        notifyAfterSeconds: settings.notifyAfterSeconds,
        minimizeToTray: settings.minimizeToTray,
        globalHotkey: settings.globalHotkey,
        dropDown: settings.dropDown,
        autoUpdate: settings.autoUpdate,
        keybindings: settings.keybindings,
      });
      onSaved();
      toast(t('Settings saved'));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      title={t('OmniTerminal Settings')}
      onClose={onClose}
      wide
      footer={
        <>
          {error && <span className="footer-note form-error-inline">{error}</span>}
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" onClick={save}>{t('Save')}</button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {TABS.map((x) => (
            <button key={x.id} className={cx('settings-nav-item', tab === x.id && 'active')} onClick={() => setTab(x.id)}>
              {t(x.label)}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'general' && <GeneralTab settings={settings} set={set} state={state} toast={toast} />}
          {tab === 'window' && <WindowTab settings={settings} set={set} />}
          {tab === 'shortcuts' && <ShortcutsTab custom={settings.keybindings} onChange={(keybindings) => set({ keybindings })} />}
          {tab === 'snippets' && <SnippetsTab state={state} toast={toast} />}
          {tab === 'tools' && <InstalledToolsTab />}
          {tab === 'updates' && <UpdatesTab settings={settings} set={set} info={info} onExitCompletely={onExitCompletely} />}
        </div>
      </div>
    </Dialog>
  );
}

type S = AppState['settings'];

function GeneralTab({ settings, set, state, toast }: { settings: S; set: (p: Partial<S>) => void; state: AppState; toast: (m: string) => void }) {
  return (
    <div className="form-grid">
      <h3 className="subhead first">{t('Appearance')}</h3>
      <div className="field">
        <span>{t('Theme')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('Theme')}>
          {[
            { id: 'system', label: t('Use Windows setting') },
            { id: 'dark', label: t('Dark') },
            { id: 'light', label: t('Light') },
            { id: 'midnight', label: t('Midnight') },
            { id: 'nord', label: t('Nord') },
          ].map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={settings.uiTheme === o.id} className={settings.uiTheme === o.id ? 'on' : ''} onClick={() => set({ uiTheme: o.id })}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>{t('Language')}</span>
        <select value={settings.language} onChange={(e) => set({ language: e.target.value })}>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </label>

      <h3 className="subhead">{t('Typing')}</h3>
      <label className="check">
        <input type="checkbox" checked={settings.suggestions} onChange={(e) => set({ suggestions: e.target.checked })} />
        <span>
          <b>{t('Suggestions while typing (PowerShell)')}</b>
          <em>{t('Shows matching commands from this terminal\'s history as you type. Up/Down picks one, F1 shows help for a command. Applies to terminals started after saving.')}</em>
        </span>
      </label>
      {settings.suggestions && <SuggestionsSetup toast={toast} />}

      <h3 className="subhead">{t('Notifications')}</h3>
      <label className="field">
        <span>{t('Tell me when a long command finishes')}</span>
        <select value={String(settings.notifyAfterSeconds)} onChange={(e) => set({ notifyAfterSeconds: Number(e.target.value) })}>
          <option value="0">{t('Never')}</option>
          {[10, 15, 30, 60, 120, 300].map((n) => (
            <option key={n} value={n}>{n < 60 ? t('If it took {n} seconds or more', { n }) : t('If it took {n} minutes or more', { n: n / 60 })}</option>
          ))}
        </select>
        <em className="field-help">{t('Only when you are looking at another tab or another app. Works in every shell.')}</em>
      </label>

      <h3 className="subhead">{t('New terminals')}</h3>
      <label className="field">
        <span>{t('Default shell')}</span>
        <select value={settings.defaultShellId} onChange={(e) => set({ defaultShellId: e.target.value })}>
          {state.shells.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>{t('Default working directory')}</span>
        <div className="input-with-btn">
          <input value={settings.defaultCwd} onChange={(e) => set({ defaultCwd: e.target.value })} placeholder={t('Your user folder')} />
          <button className="btn" onClick={async () => {
            const d = await bridge.pickDirectory(settings.defaultCwd || undefined);
            if (d) set({ defaultCwd: d });
          }}><Icon name="folder" size={14} /> {t('Browse')}</button>
        </div>
      </label>
      <button className="btn btn-ghost" onClick={async () => { await api.refreshShells(); toast(t('Shell list refreshed')); }}>
        <Icon name="restart" size={14} /> {t('Re-detect installed shells')}
      </button>
    </div>
  );
}

/** Windows PowerShell 5.1 ships PSReadLine 2.0, which has no suggestions: offer a one-click fix. */
function SuggestionsSetup({ toast }: { toast: (m: string) => void }) {
  const [status, setStatus] = useState<{ installed: boolean; version: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bridge.invoke<{ installed: boolean; version: string }>('system.suggestions').then(setStatus).catch(() => undefined);
  }, []);
  if (!status) return null;
  if (status.installed) {
    return <p className="hint ok-hint"><Icon name="check" size={13} /> {t('Ready in Windows PowerShell too (PSReadLine {v}, used only by OmniTerminal).', { v: status.version })}</p>;
  }
  return (
    <div className="setup-box">
      <p className="hint">
        {t('PowerShell 7 shows suggestions already. Windows PowerShell needs a newer PSReadLine: OmniTerminal can download it from the PowerShell Gallery (about 250 KB, checked against a known checksum). It is used only by OmniTerminal terminals; your normal PowerShell is not changed.')}
      </p>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setStatus(await bridge.invoke('system.installSuggestions'));
            toast(t('Suggestions are ready. Restart PowerShell terminals to use them.'));
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="download" size={14} /> {busy ? t('Downloading…') : t('Turn on for Windows PowerShell')}
      </button>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function WindowTab({ settings, set }: { settings: S; set: (p: Partial<S>) => void }) {
  return (
    <div className="form-grid">
      <h3 className="subhead first">{t('Window')}</h3>
      <label className="check">
        <input type="checkbox" checked={settings.minimizeToTray} onChange={(e) => set({ minimizeToTray: e.target.checked })} />
        <span>
          <b>{t('Keep OmniTerminal in the notification area when the window is closed')}</b>
          <em>{t('Closing the window hides it next to the clock instead. Click the icon to bring it back. Terminals keep running either way.')}</em>
        </span>
      </label>
      <div className="field">
        <span>{t('Show or hide OmniTerminal from anywhere')}</span>
        <ShortcutInput value={settings.globalHotkey} onChange={(globalHotkey) => set({ globalHotkey })} placeholder={t('Off')} />
        <em className="field-help">{t('A system-wide shortcut, for example Ctrl+Alt+T or Ctrl+`. Pick one other apps do not use.')}</em>
      </div>
      <label className="check">
        <input type="checkbox" checked={settings.dropDown} disabled={!settings.globalHotkey} onChange={(e) => set({ dropDown: e.target.checked })} />
        <span>
          <b>{t('Drop-down mode')}</b>
          <em>{t('The shortcut slides OmniTerminal in at the top of the screen, over other windows, and hides it again.')}</em>
        </span>
      </label>

      <h3 className="subhead">{t('Session manager')}</h3>
      <label className="check">
        <input type="checkbox" checked={settings.restoreAfterRestart} onChange={(e) => set({ restoreAfterRestart: e.target.checked })} />
        <span>
          <b>{t('Reopen terminals after a restart')}</b>
          <em>{t('Terminals that were running when Windows restarted start again, with their earlier output shown above. Programs inside them start fresh.')}</em>
        </span>
      </label>
      <label className="check indent">
        <input type="checkbox" checked={settings.resumeClaude} disabled={!settings.restoreAfterRestart} onChange={(e) => set({ resumeClaude: e.target.checked })} />
        <span>
          <b>{t('Resume Claude Code conversations')}</b>
          <em>{t('A terminal that was running Claude Code reopens with claude --continue, in the folder it was in. Terminals that ran as administrator ask Windows for administrator rights again.')}</em>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.autostart} onChange={(e) => set({ autostart: e.target.checked })} />
        <span>
          <b>{t('Start OmniTerminal Session Manager with Windows')}</b>
          <em>{t('Runs the small background host at sign-in (no window), so the app opens instantly.')}</em>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.keepManagerRunning} onChange={(e) => set({ keepManagerRunning: e.target.checked })} />
        <span>
          <b>{t('Keep the session manager running when idle')}</b>
          <em>{t('Otherwise it exits by itself after 10 minutes with no window and no running terminals.')}</em>
        </span>
      </label>
    </div>
  );
}

/** Click, then press a key combination. Backspace clears, Esc cancels. */
export function ShortcutInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [recording, setRecording] = useState(false);
  return (
    <button
      type="button"
      className={cx('shortcut-input', recording && 'recording')}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') return setRecording(false);
        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          onChange('');
          return setRecording(false);
        }
        const combo = comboFromEvent(e.nativeEvent);
        if (!combo) return; // only modifiers so far
        onChange(combo);
        setRecording(false);
      }}
    >
      {recording ? t('Press keys… (Backspace clears)') : value ? <kbd>{value}</kbd> : <span className="muted">{placeholder ?? t('None')}</span>}
    </button>
  );
}

function ShortcutsTab({ custom, onChange }: { custom: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const bindings = useMemo(() => effectiveBindings(custom), [custom]);
  const clash = useMemo(() => conflicts(bindings), [bindings]);
  return (
    <div className="form-grid">
      <p className="hint">{t('Click a shortcut and press the new keys. Shortcuts are matched by key position, so they work with any keyboard language. Ctrl+Alt+1 to 9 always switch tabs.')}</p>
      <div className="shortcut-list">
        {SHORTCUT_ACTIONS.map((a) => {
          const v = bindings.get(a.id) ?? '';
          const changed = Object.prototype.hasOwnProperty.call(custom, a.id);
          return (
            <div key={a.id} className={cx('shortcut-row', clash.has(a.id) && 'clash')}>
              <span className="shortcut-label">{t(a.label)}</span>
              <ShortcutInput
                value={v}
                onChange={(k) => onChange(k === a.defaultKeys ? omit(custom, a.id) : { ...custom, [a.id]: k })}
              />
              <button className="icon-btn small" disabled={!changed} title={t('Reset to {keys}', { keys: a.defaultKeys })} onClick={() => onChange(omit(custom, a.id))}>
                <Icon name="restart" size={13} />
              </button>
              {clash.has(a.id) && <span className="shortcut-warn">{t('Used twice')}</span>}
              {!clash.has(a.id) && v && shadowsTerminalKey(v) && <span className="shortcut-warn">{t('Programs in the terminal will not get this key')}</span>}
            </div>
          );
        })}
      </div>
      <button className="btn btn-ghost" disabled={Object.keys(custom).length === 0} onClick={() => onChange({})}>
        <Icon name="restart" size={14} /> {t('Reset all shortcuts')}
      </button>
    </div>
  );
}

function omit(o: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

/** Saved commands, run from the command palette (Ctrl+Shift+S). Saved immediately. */
function SnippetsTab({ state, toast }: { state: AppState; toast: (m: string) => void }) {
  const empty: Partial<Snippet> = { name: '', command: '', profileId: null, run: true };
  const [list, setList] = useState<Snippet[]>(state.snippets);
  const [draft, setDraft] = useState<Partial<Snippet>>(empty);
  const [error, setError] = useState<string | null>(null);
  const terminalName = (id: string | null) => (id ? state.profiles.find((p) => p.id === id)?.name ?? '?' : t('Every terminal'));

  const save = async () => {
    setError(null);
    try {
      const s = await bridge.invoke<Snippet>('snippets.save', { snippet: draft });
      setList((l) => (l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? s : x)) : [...l, s]));
      setDraft(empty);
      toast(t('Snippet saved'));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="form-grid">
      <p className="hint">{t('Commands you run often. Press Ctrl+Shift+S (or open the command palette) and pick one to type it into the current terminal.')}</p>
      {list.length > 0 && (
        <div className="snippet-list">
          {list.map((s) => (
            <div key={s.id} className="snippet-row">
              <div className="snippet-text">
                <b>{s.name}</b>
                <code>{s.command}</code>
                <span className="muted small">{terminalName(s.profileId)}{s.run ? '' : ` · ${t('typed, not run')}`}</span>
              </div>
              <button className="icon-btn small" title={t('Edit')} onClick={() => setDraft(s)}><Icon name="edit" size={13} /></button>
              <button
                className="icon-btn small"
                title={t('Delete')}
                onClick={async () => {
                  await bridge.invoke('snippets.delete', { id: s.id });
                  setList((l) => l.filter((x) => x.id !== s.id));
                  if (draft.id === s.id) setDraft(empty);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <h3 className="subhead">{draft.id ? t('Edit snippet') : t('New snippet')}</h3>
      <label className="field">
        <span>{t('Name')}</span>
        <input value={draft.name ?? ''} maxLength={60} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder={t('e.g. Run tests')} />
      </label>
      <label className="field">
        <span>{t('Command')}</span>
        <textarea rows={2} className="mono" value={draft.command ?? ''} onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))} placeholder="npm test" spellCheck={false} />
      </label>
      <label className="field">
        <span>{t('Offer it in')}</span>
        <select value={draft.profileId ?? ''} onChange={(e) => setDraft((d) => ({ ...d, profileId: e.target.value || null }))}>
          <option value="">{t('Every terminal')}</option>
          {state.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.run !== false} onChange={(e) => setDraft((d) => ({ ...d, run: e.target.checked }))} />
        <span><b>{t('Press Enter after typing it')}</b></span>
      </label>
      <div className="row-actions">
        {draft.id && <button className="btn" onClick={() => setDraft(empty)}>{t('Cancel')}</button>}
        <button className="btn btn-primary" disabled={!draft.name?.trim() || !draft.command?.trim()} onClick={() => void save()}>
          <Icon name="check" size={14} /> {draft.id ? t('Save snippet') : t('Add snippet')}
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

const TOOL_GROUP_LABEL: Record<InstalledTool['group'], string> = {
  ai: 'AI coding tools',
  code: 'Git and code hosting',
  cloud: 'Cloud and infrastructure',
  deploy: 'Hosting and deploys',
  services: 'Developer services',
  runtimes: 'Languages and shells',
  data: 'Data and ML',
};

/** Which CLIs are installed (on PATH, as a new terminal sees it) and their versions. */
function InstalledToolsTab() {
  const [list, setList] = useState<InstalledTool[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setList(await bridge.invoke<InstalledTool[]>('system.tools', { force }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load(false);
  }, []);
  const installed = list?.filter((x) => x.path).length ?? 0;
  return (
    <div className="form-grid">
      <p className="hint">{t('Command-line tools found on this PC, as a new terminal sees them. Each terminal keeps its own logins for them.')}</p>
      <div className="row-actions">
        <button className="btn" disabled={busy} onClick={() => void load(true)}>
          <Icon name="restart" size={14} /> {busy ? t('Checking…') : t('Check again')}
        </button>
        {list && <span className="muted small">{t('{n} of {total} installed', { n: installed, total: list.length })}</span>}
      </div>
      {error && <div className="form-error">{error}</div>}
      {!list && busy && <p className="hint">{t('Looking for installed tools… (some take a few seconds to report their version)')}</p>}
      {list &&
        (Object.keys(TOOL_GROUP_LABEL) as InstalledTool['group'][]).map((g) => {
          const items = list.filter((x) => x.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g}>
              <h4 className="tool-group">{t(TOOL_GROUP_LABEL[g])}</h4>
              <div className="installed-list">
                {items.map((x) => (
                  <div key={x.id} className={cx('installed-row', !x.path && 'missing')}>
                    <span className={cx('installed-dot', x.path ? 'ok' : 'none')} />
                    <span className="installed-name">{x.name}</span>
                    {x.path ? (
                      <>
                        <code className="installed-version">{x.version ?? '?'}</code>
                        <span className="installed-path mono" title={x.path}>{x.path}</span>
                      </>
                    ) : (
                      <>
                        <span className="installed-version muted">{t('Not installed')}</span>
                        <button className="btn btn-sm btn-ghost" onClick={() => void bridge.openExternal(x.url)}>
                          <Icon name="download" size={13} /> {t('How to install')}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function UpdatesTab({ settings, set, info, onExitCompletely }: { settings: S; set: (p: Partial<S>) => void; info: AppInfo | null; onExitCompletely: () => void }) {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void bridge.updateStatus().then(setUpdate);
    return bridge.onUpdateStatus(setUpdate);
  }, []);
  return (
    <div className="form-grid">
      <h3 className="subhead first">{t('Updates')}</h3>
      <label className="check">
        <input type="checkbox" checked={settings.autoUpdate} onChange={(e) => set({ autoUpdate: e.target.checked })} />
        <span>
          <b>{t('Download new versions automatically')}</b>
          <em>{t('Checks GitHub Releases when OmniTerminal starts and every few hours. You choose when to install; running terminals reopen afterwards with their output.')}</em>
        </span>
      </label>
      {update && (
        <div className="kv">
          <div><span>{t('Status')}</span><code>{updateText(update)}</code></div>
        </div>
      )}
      <div className="row-actions">
        <button className="btn" disabled={!update || ['checking', 'downloading', 'portable', 'dev'].includes(update.state)} onClick={() => void bridge.checkForUpdates()}>
          <Icon name="restart" size={14} /> {t('Check now')}
        </button>
        {update?.state === 'ready' && (
          <button className="btn btn-primary" onClick={() => void bridge.installUpdate()}>
            <Icon name="download" size={14} /> {t('Restart and install {v}', { v: update.version ?? '' })}
          </button>
        )}
      </div>

      <h3 className="subhead">{t('Data')}</h3>
      {info && (
        <div className="kv">
          <div><span>{t('Version')}</span><code>{info.version} (Electron {info.electron})</code></div>
          <div><span>{t('Data folder')}</span><code>{info.home}</code></div>
          <div><span>{t('Profiles')}</span><code>{info.profiles}</code></div>
        </div>
      )}
      <div className="row-actions">
        {info && <button className="btn" onClick={() => void bridge.openPath(info.home)}><Icon name="folder" size={14} /> {t('Open data folder')}</button>}
      </div>

      <h3 className="subhead danger">{t('Exit')}</h3>
      <p className="hint">{t('Closing the window keeps your terminals running. Exit completely stops every terminal and the session manager.')}</p>
      <div className="row-actions">
        <button className="btn btn-danger" onClick={onExitCompletely}><Icon name="power" size={14} /> {t('Exit completely…')}</button>
      </div>
    </div>
  );
}

export function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'portable':
      return t('Portable copy: download new versions from GitHub Releases.');
    case 'dev':
      return t('Development build: updates are off.');
    case 'disabled':
      return t('Automatic updates are off.');
    case 'checking':
      return t('Checking…');
    case 'none':
      return t('You have the latest version.');
    case 'downloading':
      return t('Downloading {v}… {p}%', { v: u.version ?? '', p: Math.round(u.progress ?? 0) });
    case 'ready':
      return t('Version {v} is ready to install.', { v: u.version ?? '' });
    case 'error':
      return t('Could not check: {m}', { m: u.message ?? '' });
    default:
      return t('Not checked yet.');
  }
}
