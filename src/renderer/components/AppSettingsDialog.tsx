import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/types';
import { api, bridge, errorMessage, type AppInfo } from '../api';
import { LANGUAGES, t } from '../i18n';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export function AppSettingsDialog({
  state,
  onClose,
  onExitCompletely,
  onSaved,
  toast,
}: {
  state: AppState;
  onClose: () => void;
  onExitCompletely: () => void;
  onSaved: () => void;
  toast: (m: string) => void;
}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState(state.settings);
  const [error, setError] = useState<string | null>(null);

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
        suggestions: settings.suggestions,
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
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" onClick={save}>{t('Save')}</button>
        </>
      }
    >
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
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={settings.uiTheme === o.id}
                className={settings.uiTheme === o.id ? 'on' : ''}
                onClick={() => setSettings((s) => ({ ...s, uiTheme: o.id }))}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>{t('Language')}</span>
          <select value={settings.language} onChange={(e) => setSettings((s) => ({ ...s, language: e.target.value }))}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </label>

        <h3 className="subhead">{t('Typing')}</h3>
        <label className="check">
          <input type="checkbox" checked={settings.suggestions} onChange={(e) => setSettings((s) => ({ ...s, suggestions: e.target.checked }))} />
          <span>
            <b>{t('Suggestions while typing (PowerShell)')}</b>
            <em>{t('Shows matching commands from this terminal\'s history as you type. Up/Down picks one, F1 shows help for a command. Applies to terminals started after saving. Needs PSReadLine 2.1 or later: PowerShell 7 has it; for Windows PowerShell run Install-Module PSReadLine -Scope CurrentUser -Force once.')}</em>
          </span>
        </label>

        <h3 className="subhead">{t('Session manager')}</h3>
        <label className="check">
          <input type="checkbox" checked={settings.restoreAfterRestart} onChange={(e) => setSettings((s) => ({ ...s, restoreAfterRestart: e.target.checked }))} />
          <span>
            <b>{t('Reopen terminals after a restart')}</b>
            <em>{t('Terminals that were running when Windows restarted start again, with their earlier output shown above. Programs inside them start fresh.')}</em>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.autostart} onChange={(e) => setSettings((s) => ({ ...s, autostart: e.target.checked }))} />
          <span>
            <b>{t('Start OmniTerminal Session Manager with Windows')}</b>
            <em>{t('Runs the small background host at sign-in (no window), so the app opens instantly.')}</em>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.keepManagerRunning} onChange={(e) => setSettings((s) => ({ ...s, keepManagerRunning: e.target.checked }))} />
          <span>
            <b>{t('Keep the session manager running when idle')}</b>
            <em>{t('Otherwise it exits by itself after 10 minutes with no window and no running terminals.')}</em>
          </span>
        </label>

        <h3 className="subhead">{t('New terminals')}</h3>
        <label className="field">
          <span>{t('Default shell')}</span>
          <select value={settings.defaultShellId} onChange={(e) => setSettings((s) => ({ ...s, defaultShellId: e.target.value }))}>
            {state.shells.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('Default working directory')}</span>
          <div className="input-with-btn">
            <input value={settings.defaultCwd} onChange={(e) => setSettings((s) => ({ ...s, defaultCwd: e.target.value }))} placeholder={t('Your user folder')} />
            <button className="btn" onClick={async () => {
              const d = await bridge.pickDirectory(settings.defaultCwd || undefined);
              if (d) setSettings((s) => ({ ...s, defaultCwd: d }));
            }}><Icon name="folder" size={14} /> {t('Browse')}</button>
          </div>
        </label>
        <button className="btn btn-ghost" onClick={async () => { await api.refreshShells(); toast(t('Shell list refreshed')); }}>
          <Icon name="restart" size={14} /> {t('Re-detect installed shells')}
        </button>

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
        {error && <div className="form-error">{error}</div>}
      </div>
    </Dialog>
  );
}
