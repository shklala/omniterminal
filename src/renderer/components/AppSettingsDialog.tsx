import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/types';
import { api, bridge, errorMessage, type AppInfo } from '../api';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export function AppSettingsDialog({ state, onClose, onExitCompletely, toast }: { state: AppState; onClose: () => void; onExitCompletely: () => void; toast: (m: string) => void }) {
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
      });
      toast('Settings saved');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      title="OmniTerminal Settings"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="form-grid">
        <h3 className="subhead first">Session manager</h3>
        <label className="check">
          <input type="checkbox" checked={settings.autostart} onChange={(e) => setSettings((s) => ({ ...s, autostart: e.target.checked }))} />
          <span>
            <b>Start OmniTerminal Session Manager with Windows</b>
            <em>Runs the small background host at sign-in (no window), so the GUI connects instantly.</em>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.keepManagerRunning} onChange={(e) => setSettings((s) => ({ ...s, keepManagerRunning: e.target.checked }))} />
          <span>
            <b>Keep the session manager running when idle</b>
            <em>Otherwise it exits by itself after 10 minutes with no window and no running terminals.</em>
          </span>
        </label>

        <h3 className="subhead">New terminals</h3>
        <label className="field">
          <span>Default shell</span>
          <select value={settings.defaultShellId} onChange={(e) => setSettings((s) => ({ ...s, defaultShellId: e.target.value }))}>
            {state.shells.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Default working directory</span>
          <div className="input-with-btn">
            <input value={settings.defaultCwd} onChange={(e) => setSettings((s) => ({ ...s, defaultCwd: e.target.value }))} placeholder="Your user folder" />
            <button className="btn" onClick={async () => {
              const d = await bridge.pickDirectory(settings.defaultCwd || undefined);
              if (d) setSettings((s) => ({ ...s, defaultCwd: d }));
            }}><Icon name="folder" size={14} /> Browse</button>
          </div>
        </label>
        <button className="btn btn-ghost" onClick={async () => { await api.refreshShells(); toast('Shell list refreshed'); }}>
          <Icon name="restart" size={14} /> Re-detect installed shells
        </button>

        <h3 className="subhead">Data</h3>
        {info && (
          <div className="kv">
            <div><span>Version</span><code>{info.version} (Electron {info.electron})</code></div>
            <div><span>Data folder</span><code>{info.home}</code></div>
            <div><span>Profiles</span><code>{info.profiles}</code></div>
            <div><span>Session manager</span><code>pid {state.daemon.pid} · since {new Date(state.daemon.startedAt).toLocaleString()}</code></div>
          </div>
        )}
        <div className="row-actions">
          {info && <button className="btn" onClick={() => void bridge.openPath(info.home)}><Icon name="folder" size={14} /> Open data folder</button>}
        </div>

        <h3 className="subhead danger">Exit</h3>
        <p className="hint">Closing the window keeps your terminals running. <b>Exit completely</b> stops every terminal and the session manager.</p>
        <div className="row-actions">
          <button className="btn btn-danger" onClick={onExitCompletely}><Icon name="power" size={14} /> Exit completely…</button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
    </Dialog>
  );
}
