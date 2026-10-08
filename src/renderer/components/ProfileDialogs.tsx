import { useEffect, useState } from 'react';
import { DEFAULT_APPEARANCE, PROFILE_COLORS } from '../../shared/defaults';
import { TOOL_GROUPS, isToolEnabled } from '../../shared/tools';
import type { ToolDefinition } from '../../shared/types';
import type { AppState, CustomMapping, CustomTheme, Profile, ProfileInput, SessionInfo, SshKeyStatus } from '../../shared/types';
import { api, bridge, errorMessage } from '../api';
import { THEMES, findCustomTheme, getCustomThemes, getTheme, setCustomThemes } from '../themes';
import { ThemeEditor } from './ThemeEditor';
import { cx, fmtDateFull, nextDefaultName } from '../util';
import { Dialog } from './Dialog';
import { EnvEditor, rowsToEnv, toRows, type EnvRow } from './EnvEditor';
import { Icon } from './Icon';
import { t as tr } from '../i18n';

interface GeneralValues {
  name: string;
  description: string;
  cwd: string;
  shellId: string;
  shellPath: string;
  startupCommand: string;
  color: string;
}

function GeneralFields({ values, onChange, state, autoFocus }: { values: GeneralValues; onChange: (v: Partial<GeneralValues>) => void; state: AppState; autoFocus?: boolean }) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>{tr('Name')}</span>
        <input autoFocus={autoFocus} value={values.name} maxLength={64} onChange={(e) => onChange({ name: e.target.value })} placeholder={tr('e.g. Claude Account 03')} />
      </label>
      <label className="field">
        <span>{tr('Working directory')}</span>
        <div className="input-with-btn">
          <input value={values.cwd} onChange={(e) => onChange({ cwd: e.target.value })} placeholder={tr('Default: your user folder')} spellCheck={false} />
          <button className="btn" type="button" onClick={async () => {
            const dir = await bridge.pickDirectory(values.cwd || undefined);
            if (dir) onChange({ cwd: dir });
          }}>
            <Icon name="folder" size={14} /> {tr('Browse')}
          </button>
        </div>
      </label>
      <label className="field">
        <span>{tr('Shell')}</span>
        <select value={values.shellId} onChange={(e) => onChange({ shellId: e.target.value })}>
          {state.shells.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
          <option value="custom">{tr('Custom executable…')}</option>
        </select>
      </label>
      {values.shellId === 'custom' && (
        <label className="field">
          <span>{tr('Shell executable')}</span>
          <div className="input-with-btn">
            <input value={values.shellPath} onChange={(e) => onChange({ shellPath: e.target.value })} placeholder="C:\path\to\shell.exe" spellCheck={false} />
            <button className="btn" type="button" onClick={async () => {
              const f = await bridge.pickFile('Choose shell executable');
              if (f) onChange({ shellPath: f });
            }}>{tr('Browse')}</button>
          </div>
        </label>
      )}
      <label className="field">
        <span>{tr('Startup command')} <em>{tr('optional')}</em></span>
        <input value={values.startupCommand} onChange={(e) => onChange({ startupCommand: e.target.value })} placeholder="e.g. claude" spellCheck={false} />
        <div className="presets">
          {['claude', 'claude --continue', 'codex', 'npm run dev', 'supabase start', 'gcloud auth list'].map((c) => (
            <button key={c} type="button" className={cx('preset', values.startupCommand === c && 'on')} onClick={() => onChange({ startupCommand: values.startupCommand === c ? '' : c })}>
              {c}
            </button>
          ))}
        </div>
      </label>
      <div className="field">
        <span>{tr('Color')}</span>
        <div className="swatches">
          {PROFILE_COLORS.map((c) => (
            <button key={c} type="button" className={cx('swatch', values.color === c && 'selected')} style={{ background: c }} onClick={() => onChange({ color: c })} aria-label={`Color ${c}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

export interface NewTerminalPreset {
  name?: string;
  shellId?: string;
  startupCommand?: string;
}

export function NewTerminalDialog({
  state,
  onClose,
  onCreated,
  preset,
}: {
  state: AppState;
  onClose: () => void;
  onCreated: (p: Profile) => void;
  preset?: NewTerminalPreset;
}) {
  const defaultShell = state.shells.some((s) => s.id === state.settings.defaultShellId) ? state.settings.defaultShellId : state.shells[0]?.id ?? 'powershell';
  const [values, setValues] = useState<GeneralValues>({
    name: preset?.name ? uniqueLocalName(preset.name, state.profiles) : nextDefaultName(state.profiles),
    description: '',
    cwd: state.settings.defaultCwd,
    shellId: preset?.shellId && state.shells.some((s) => s.id === preset.shellId) ? preset.shellId : defaultShell,
    shellPath: '',
    startupCommand: preset?.startupCommand ?? '',
    color: PROFILE_COLORS[state.profiles.length % PROFILE_COLORS.length],
  });
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [showEnv, setShowEnv] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const input: ProfileInput = { ...values, env: rowsToEnv(env) };
      const p = await api.createProfile(input);
      onCreated(p);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={tr('New Terminal')}
      subtitle={tr('Each terminal is an independent environment with its own config, credentials and history.')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{tr('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={create}>
            <Icon name="play" size={14} /> {tr('Create & Launch')}
          </button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <GeneralFields values={values} onChange={(v) => setValues((s) => ({ ...s, ...v }))} state={state} autoFocus />
        <button type="submit" hidden />
      </form>
      <div className="section-toggle" onClick={() => setShowEnv((s) => !s)}>
        <span className={cx('chevron', showEnv && 'open')}>›</span> {tr('Environment variables')} <em>{tr('optional')}</em>
        {env.length > 0 && <span className="pill">{env.length}</span>}
      </div>
      {showEnv && <EnvEditor rows={env} onChange={setEnv} />}
      <p className="hint">
        <Icon name="shield" size={13} /> {tr('Claude Code, gcloud, GitHub CLI, Git and other tools get their own config folders automatically.')}
      </p>
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

function uniqueLocalName(base: string, profiles: Profile[]): string {
  const taken = new Set(profiles.map((p) => p.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

type Tab = 'general' | 'environment' | 'tools' | 'appearance' | 'advanced';
const TAB_LABELS: Record<Tab, string> = { general: 'General', environment: 'Environment', tools: 'Tools', appearance: 'Appearance', advanced: 'Advanced' };

export function ProfileSettingsDialog({
  state,
  profile,
  session,
  onClose,
  onSaved,
  initialTab = 'general',
}: {
  state: AppState;
  profile: Profile;
  session: SessionInfo | undefined;
  onClose: () => void;
  onSaved: (p: Profile, needsRestart: boolean) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [general, setGeneral] = useState<GeneralValues>({
    name: profile.name,
    description: profile.description,
    cwd: profile.cwd,
    shellId: profile.shellId,
    shellPath: profile.shellPath,
    startupCommand: profile.startupCommand,
    color: profile.color,
  });
  const [env, setEnv] = useState<EnvRow[]>(() => toRows(profile.env));
  const [tools, setTools] = useState<Record<string, boolean>>(profile.tools);
  const [mappings, setMappings] = useState<CustomMapping[]>(profile.customMappings);
  const [appearance, setAppearance] = useState(profile.appearance);
  const [advanced, setAdvanced] = useState(profile.advanced);
  const [unsetText, setUnsetText] = useState(profile.advanced.unsetVars.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolQuery, setToolQuery] = useState('');

  const running = session?.state === 'running';
  const sep = profile.dir.includes('\\') ? '\\' : '/';
  const toolPath = (rel: string) => `${profile.dir}${sep}${rel.replace(/\//g, sep)}`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const unsetVars = unsetText.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      const patch: Partial<Profile> = {
        ...general,
        env: rowsToEnv(env),
        tools,
        customMappings: mappings,
        appearance,
        advanced: { ...advanced, unsetVars },
      };
      const updated = await api.updateProfile(profile.id, patch);
      const envChanged =
        general.cwd !== profile.cwd ||
        general.shellId !== profile.shellId ||
        general.shellPath !== profile.shellPath ||
        general.startupCommand !== profile.startupCommand ||
        JSON.stringify(rowsToEnv(env)) !== JSON.stringify(profile.env.map(({ name, value, secret }) => ({ name, value, secret }))) ||
        JSON.stringify(tools) !== JSON.stringify(profile.tools) ||
        JSON.stringify(mappings) !== JSON.stringify(profile.customMappings) ||
        JSON.stringify(advanced) !== JSON.stringify({ ...profile.advanced, unsetVars: advanced.unsetVars });
      onSaved(updated, running && envChanged);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const q = toolQuery.trim().toLowerCase();
  const toolMatches = (t: ToolDefinition) =>
    !q ||
    [t.name, t.notes, ...t.mappings.map((m) => m.envVar), ...(t.tokenVars ?? []).map((v) => v.envVar)].some((f) => f.toLowerCase().includes(q));
  const groupedTools = TOOL_GROUPS.map((g) => ({ ...g, tools: state.tools.filter((t) => (t.group ?? 'code') === g.id && toolMatches(t)) })).filter(
    (g) => g.tools.length > 0,
  );

  return (
    <Dialog
      wide
      title={tr('{name} settings', { name: profile.name })}
      subtitle={<span className="mono small">{profile.dir}</span>}
      onClose={onClose}
      footer={
        <>
          {running && <span className="footer-note">{tr('Changes to shell/environment apply after Restart.')}</span>}
          <button className="btn" onClick={onClose}>{tr('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save')}</button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {(['general', 'environment', 'tools', 'appearance', 'advanced'] as Tab[]).map((t) => (
            <button key={t} className={cx('settings-nav-item', tab === t && 'active')} onClick={() => setTab(t)}>
              {tr(TAB_LABELS[t])}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {tab === 'general' && (
            <>
              <GeneralFields values={general} onChange={(v) => setGeneral((s) => ({ ...s, ...v }))} state={state} />
              <label className="field">
                <span>{tr('Notes / description')}</span>
                <textarea rows={3} value={general.description} onChange={(e) => setGeneral((s) => ({ ...s, description: e.target.value }))} placeholder="What is this terminal for?" />
              </label>
            </>
          )}

          {tab === 'environment' && (
            <>
              <p className="hint">
                Variables apply only to this terminal. <Icon name="lock" size={12} /> Secret values are encrypted with Windows DPAPI in
                this terminal's <span className="mono">credentials</span> folder, never shown again, never logged and never exported.
              </p>
              <EnvEditor rows={env} onChange={setEnv} />
            </>
          )}

          {tab === 'tools' && (
            <>
              <p className="hint">
                Tools with a switch get their own folder inside this terminal, so signing in here does not touch your other
                terminals. Tools without one share their login, so give this terminal its own token instead.
              </p>
              <div className="tool-filter">
                <div className="search-box">
                  <Icon name="search" size={14} />
                  <input placeholder={tr('Search tools or variables')} value={toolQuery} onChange={(e) => setToolQuery(e.target.value)} spellCheck={false} />
                </div>
                <span className="muted small">{tr('{n} tools', { n: state.tools.length })}</span>
              </div>
              {groupedTools.length === 0 && <p className="hint">No tool matches "{toolQuery}". You can still add a custom mapping below.</p>}
              {groupedTools.map((g) => (
              <div key={g.id}>
              <h4 className="tool-group">{tr(g.label)}</h4>
              <div className="tool-list">
                {g.tools.map((t) => {
                  // Tools without folder mappings are always "on" (token fields only), except the SSH key tool.
                  const switchable = t.mappings.length > 0 || t.id === 'ssh-key';
                  const enabled = !switchable || isToolEnabled(tools, t);
                  const tokenSet = (t.tokenVars ?? []).some((tv) => env.some((r) => r.name === tv.envVar && (r.value || r.hasValue)));
                  const level = tokenSet ? 'full' : t.isolation;
                  return (
                    <div key={t.id} className={cx('tool-card', !enabled && 'disabled')}>
                      <div className="tool-head">
                        {switchable && (
                          <label className="switch" title={tr("Redirect this tool into the terminal's private folder")}>
                            <input type="checkbox" checked={enabled} onChange={(e) => setTools((s) => ({ ...s, [t.id]: e.target.checked }))} />
                            <span className="slider" />
                          </label>
                        )}
                        <span className="tool-name">{t.name}</span>
                        <span className={cx('badge', `iso-${level}`)}>
                          {tr(tokenSet ? 'Own token' : level === 'full' ? 'Separate' : level === 'partial' ? 'Shared login' : 'Shared')}
                        </span>
                      </div>
                      {t.mappings.map((m) => (
                        <div key={m.envVar} className="tool-mapping mono">
                          {m.envVar} = {m.kind === 'value' ? (m.value ?? '').replace('{slug}', profile.slug) : toolPath(m.path)}
                        </div>
                      ))}
                      <div className="tool-notes">{tr(t.notes)}</div>
                      {t.id === 'ssh-key' && enabled && <SshKeyPanel profileId={profile.id} />}
                      {(t.tokenVars ?? []).map((tv) => (
                        <TokenField key={tv.envVar} tokenVar={tv} rows={env} onChange={setEnv} />
                      ))}
                      {t.whoami && <div className="tool-whoami">Check which account is active: <code>{t.whoami}</code></div>}
                    </div>
                  );
                })}
              </div>
              </div>
              ))}

              <h3 className="subhead">{tr('Custom config mappings')}</h3>
              <p className="hint">Point any CLI's config variable at this terminal (relative paths live inside the profile folder).</p>
              <div className="mapping-editor">
                {mappings.map((m, i) => (
                  <div key={i} className="mapping-row">
                    <input placeholder="ENV_VAR" value={m.envVar} spellCheck={false} onChange={(e) => setMappings((s) => s.map((x, j) => (j === i ? { ...x, envVar: e.target.value.trim() } : x)))} />
                    <input placeholder="config/mytool" value={m.path} spellCheck={false} onChange={(e) => setMappings((s) => s.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} />
                    <select value={m.kind} onChange={(e) => setMappings((s) => s.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'dir' | 'file' } : x)))}>
                      <option value="dir">Folder</option>
                      <option value="file">File</option>
                    </select>
                    <button className="icon-btn small" onClick={() => setMappings((s) => s.filter((_, j) => j !== i))} title="Remove">
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
                <button className="btn btn-ghost" onClick={() => setMappings((s) => [...s, { envVar: '', path: 'config/', kind: 'dir' }])}>
                  <Icon name="plus" size={14} /> Add mapping
                </button>
              </div>

              <h3 className="subhead">{tr('Known limitations')}</h3>
              <div className="limitations">
                {state.limitations.map((l) => (
                  <div key={l.id} className="limitation">
                    <Icon name="alert" size={14} />
                    <div>
                      <b>{l.name}</b>
                      <div className="tool-notes">{l.notes}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'appearance' && <AppearanceFields value={appearance} onChange={setAppearance} />}

          {tab === 'advanced' && (
            <div className="form-grid">
              <label className="check">
                <input type="checkbox" checked={advanced.persistSession} onChange={(e) => setAdvanced((s) => ({ ...s, persistSession: e.target.checked }))} />
                <span>
                  <b>Keep running when the window closes</b>
                  <em>The session manager keeps this terminal alive so you can reconnect later. If off, it stops when you close OmniTerminal normally (never on a crash).</em>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={advanced.refreshEnvironment} onChange={(e) => setAdvanced((s) => ({ ...s, refreshEnvironment: e.target.checked }))} />
                <span>
                  <b>Refresh Windows environment at launch</b>
                  <em>Re-read PATH and other variables from the registry, like Windows Terminal, so newly installed tools are found.</em>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={advanced.useBundledConpty} onChange={(e) => setAdvanced((s) => ({ ...s, useBundledConpty: e.target.checked }))} />
                <span>
                  <b>Use bundled ConPTY (OpenConsole)</b>
                  <em>Newer pseudoconsole shipped with the app instead of the one built into Windows.</em>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={advanced.transcript} onChange={(e) => setAdvanced((s) => ({ ...s, transcript: e.target.checked }))} />
                <span>
                  <b>Record output transcript</b>
                  <em>Writes terminal output to logs\transcript-*.log. Known secrets and token formats are redacted, but output can still contain sensitive data. Off by default.</em>
                </span>
              </label>
              <label className="field">
                <span>Scrollback lines kept by the session manager</span>
                <input type="number" min={100} max={100000} value={advanced.scrollback} onChange={(e) => setAdvanced((s) => ({ ...s, scrollback: Number(e.target.value) }))} />
              </label>
              <label className="field">
                <span>Unset inherited variables <em>comma separated</em></span>
                <input value={unsetText} onChange={(e) => setUnsetText(e.target.value)} placeholder="e.g. AWS_PROFILE, HTTP_PROXY" spellCheck={false} />
              </label>
              <div className="kv">
                <div><span>Terminal ID</span><code>{profile.id}</code></div>
                <div><span>Session ID</span><code>{session?.sessionId ?? '—'}</code></div>
                <div><span>Process ID</span><code>{session?.state === 'running' ? session.pid : '—'}</code></div>
                <div><span>Created</span><code>{fmtDateFull(profile.createdAt)}</code></div>
                <div><span>Last used</span><code>{fmtDateFull(profile.lastUsedAt)}</code></div>
                <div><span>Last size</span><code>{profile.lastCols} × {profile.lastRows}</code></div>
              </div>
              <div className="row-actions">
                <button className="btn" onClick={() => void bridge.openPath(profile.dir)}><Icon name="folder" size={14} /> Open profile folder</button>
                <button className="btn" onClick={() => void bridge.openPath(`${profile.dir}${sep}logs`)}><Icon name="folder" size={14} /> Open logs</button>
              </div>
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
      </div>
    </Dialog>
  );
}

/** Write-only token input stored as an encrypted secret variable of this terminal. */
/** Create this terminal's SSH key and copy its public key. */
function SshKeyPanel({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState<SshKeyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void bridge.invoke<SshKeyStatus>('ssh.status', { id: profileId }).then(setStatus).catch((e) => setError(errorMessage(e)));
  }, [profileId]);
  if (!status) return error ? <div className="form-error">{error}</div> : null;
  return (
    <div className="ssh-panel">
      {status.hasKey ? (
        <>
          <div className="ssh-pub">
            <code className="mono">{status.publicKey ?? tr('(public key file missing)')}</code>
            {status.publicKey && (
              <button
                className="btn btn-sm"
                onClick={async () => {
                  await bridge.clipboardWrite(status.publicKey ?? '');
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? tr('Copied') : tr('Copy public key')}
              </button>
            )}
          </div>
          <p className="hint">{tr('Add the public key to GitHub (Settings > SSH and GPG keys) or GitLab. Save, then restart the terminal to use it.')}</p>
        </>
      ) : (
        <>
          <p className="hint">{tr('This terminal has no SSH key yet, so it still uses your normal one.')}</p>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setStatus(await bridge.invoke<SshKeyStatus>('ssh.createKey', { id: profileId }));
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="key" size={13} /> {busy ? tr('Creating…') : tr('Create SSH key for this terminal')}
          </button>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}

function TokenField({ tokenVar, rows, onChange }: { tokenVar: { envVar: string; label: string; help: string }; rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const row = rows.find((r) => r.name === tokenVar.envVar);
  const stored = !!row && (row.hasValue || !!row.value);
  const setValue = (value: string) => {
    if (row) onChange(rows.map((r) => (r.key === row.key ? { ...r, value, secret: true } : r)));
    else onChange([...rows, ...toRows([{ name: tokenVar.envVar, value, secret: true }])]);
  };
  return (
    <div className="token-field">
      <div className="token-label">
        <Icon name="lock" size={12} /> {tokenVar.label} <span className="mono">({tokenVar.envVar})</span>
        {stored && <span className="token-ok"><Icon name="check" size={12} /> {row?.value ? 'will be saved' : 'stored'}</span>}
      </div>
      <div className="input-with-btn">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={row?.hasValue ? 'Saved. Type to replace it' : 'Paste token'}
          value={row?.value ?? ''}
          onChange={(e) => setValue(e.target.value)}
        />
        {row && (
          <button className="btn" type="button" title="Remove token from this terminal" onClick={() => onChange(rows.filter((r) => r.key !== row.key))}>
            Remove
          </button>
        )}
      </div>
      <div className="token-help">{tokenVar.help}</div>
    </div>
  );
}

export function AppearanceFields({ value, onChange }: { value: Profile['appearance']; onChange: (v: Profile['appearance']) => void }) {
  const [editor, setEditor] = useState<{ theme: CustomTheme | null } | null>(null);
  const custom = getCustomThemes();
  const current = findCustomTheme(value.theme);
  const preview = getTheme(value.theme);
  return (
    <div className="form-grid">
      <label className="field">
        <span>{tr('Font family')}</span>
        <input value={value.fontFamily} onChange={(e) => onChange({ ...value, fontFamily: e.target.value })} spellCheck={false} />
      </label>
      <label className="field">
        <span>{tr('Font size')}</span>
        <input type="number" min={8} max={40} value={value.fontSize} onChange={(e) => onChange({ ...value, fontSize: Number(e.target.value) })} />
      </label>
      <div className="field">
        <span>{tr('Terminal theme')}</span>
        <div className="input-with-btn">
          <select value={value.theme} onChange={(e) => onChange({ ...value, theme: e.target.value })} style={{ flex: 1 }}>
            <optgroup label={tr('Built-in')}>
              {THEMES.map((th) => <option key={th.id} value={th.id}>{th.label}</option>)}
            </optgroup>
            {custom.length > 0 && (
              <optgroup label={tr('My themes')}>
                {custom.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
              </optgroup>
            )}
          </select>
          {current && (
            <button className="btn" type="button" onClick={() => setEditor({ theme: current })}>
              <Icon name="edit" size={14} /> {tr('Edit')}
            </button>
          )}
          <button className="btn" type="button" onClick={() => setEditor({ theme: null })}>
            <Icon name="plus" size={14} /> {tr('New theme')}
          </button>
        </div>
      </div>
      <label className="field">
        <span>{tr('Cursor')}</span>
        <div className="inline">
          <select value={value.cursorStyle} onChange={(e) => onChange({ ...value, cursorStyle: e.target.value as 'block' | 'bar' | 'underline' })}>
            <option value="block">{tr('Block')}</option>
            <option value="bar">{tr('Bar')}</option>
            <option value="underline">{tr('Underline')}</option>
          </select>
          <label className="check compact">
            <input type="checkbox" checked={value.cursorBlink} onChange={(e) => onChange({ ...value, cursorBlink: e.target.checked })} />
            <span>{tr('Blink')}</span>
          </label>
        </div>
      </label>
      <div className="theme-preview" style={{ background: current?.colors.background ?? preview.background, color: preview.foreground, fontFamily: value.fontFamily, fontSize: value.fontSize }}>
        <span style={{ color: preview.green }}>user@omni</span>:<span style={{ color: preview.blue }}>~/project</span>$ git status{'\n'}
        <span style={{ color: preview.red }}>modified:</span> src/app.ts{'\n'}
        <span style={{ color: preview.yellow }}>warning</span> <span style={{ color: preview.magenta }}>3 packages</span> <span style={{ color: preview.cyan }}>outdated</span>
      </div>
      <button className="btn btn-ghost" onClick={() => onChange({ ...DEFAULT_APPEARANCE })}>{tr('Reset to defaults')}</button>
      {editor && (
        <ThemeEditor
          theme={editor.theme}
          startFrom={value.theme}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            setCustomThemes([...getCustomThemes().filter((x) => x.id !== saved.id), saved]);
            onChange({ ...value, theme: saved.id });
          }}
          onDeleted={() => {
            if (editor.theme) setCustomThemes(getCustomThemes().filter((x) => x.id !== editor.theme!.id));
            onChange({ ...value, theme: DEFAULT_APPEARANCE.theme });
          }}
        />
      )}
    </div>
  );
}

