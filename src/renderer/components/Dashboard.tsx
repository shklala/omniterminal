import { useMemo, useState } from 'react';
import type { Profile, SessionInfo, ShellInfo } from '../../shared/types';
import { cx, fmtBytes, fmtDate, fmtDateFull, shellLabel, statsSummary, uiStatus, type ResourceStats, type UiStatus } from '../util';
import { StatusPill } from './Chrome';
import { Icon } from './Icon';
import { t } from '../i18n';

type SortKey = 'name' | 'status' | 'lastUsed' | 'created' | 'manual';

const QUICK = [
  { title: 'Claude Code', desc: 'Starts claude in its own account', name: 'Claude', shellId: 'powershell', cmd: 'claude', icon: 'bot', color: '#a855f7' },
  { title: 'PowerShell', desc: 'Windows PowerShell 5.1', name: 'PowerShell', shellId: 'powershell', cmd: '', icon: 'terminal', color: '#4f8cff' },
  { title: 'PowerShell 7', desc: 'pwsh', name: 'PowerShell 7', shellId: 'pwsh', cmd: '', icon: 'terminal', color: '#06b6d4' },
  { title: 'Git Bash', desc: 'Bash with Git tools', name: 'Git Bash', shellId: 'gitbash', cmd: '', icon: 'code', color: '#f97316' },
  { title: 'Command Prompt', desc: 'cmd.exe', name: 'Command Prompt', shellId: 'cmd', cmd: '', icon: 'terminal', color: '#94a3b8' },
  { title: 'Dev server', desc: 'npm run dev', name: 'Dev server', shellId: 'powershell', cmd: 'npm run dev', icon: 'rocket', color: '#22c55e' },
];

const SHORTCUTS: [string, string][] = [
  ['Ctrl+Shift+P', 'Command palette'],
  ['Ctrl+Shift+T', 'New terminal'],
  ['Ctrl+Shift+F', 'Find in terminal'],
  ['Ctrl+Tab', 'Next tab'],
  ['Ctrl+Alt+1-9', 'Go to tab'],
  ['Ctrl+Shift+W', 'Close tab (keeps running)'],
  ['Ctrl+= Ctrl+-', 'Zoom'],
  ['Ctrl+Shift+A', 'All terminals'],
];

function summarySentence(total: number, running: number, stats: Record<string, ResourceStats>, admin: string): string {
  const mem = Object.values(stats).reduce((a, s) => a + s.memory, 0);
  let text = total === 1 ? t('1 terminal, {r} running', { r: running }) : t('{n} terminals, {r} running', { n: total, r: running });
  if (mem) text += t(', using {mem}', { mem: fmtBytes(mem) });
  if (admin === 'All terminals') text += t('. Running as administrator');
  return text + '.';
}

const STATUS_ORDER: Record<UiStatus, number> = { running: 0, disconnected: 1, exited: 2, stopped: 3 };

export function Dashboard({
  profiles,
  sessions,
  shells,
  openTabs,
  onOpen,
  onStop,
  onNew,
  onMenu,
  onImport,
  onExportAll,
  onStopAll,
  stats,
  titles,
  onQuickNew,
  adminLabel,
}: {
  onQuickNew: (preset: { name: string; shellId: string; startupCommand: string }) => void;
  adminLabel: string;
  profiles: Profile[];
  sessions: Map<string, SessionInfo>;
  shells: ShellInfo[];
  openTabs: string[];
  onOpen: (id: string) => void;
  onStop: (id: string) => void;
  onNew: () => void;
  onMenu: (id: string, x: number, y: number) => void;
  onImport: () => void;
  onExportAll: () => void;
  onStopAll: () => void;
  stats: Record<string, ResourceStats>;
  titles: Map<string, string>;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('manual');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = profiles
      .map((p) => ({ p, s: sessions.get(p.id), st: uiStatus(sessions.get(p.id), openTabs.includes(p.id)) }))
      .filter(({ p }) => !q || [p.name, p.cwd, p.description, p.shellId, p.slug].some((f) => f.toLowerCase().includes(q)));
    const cmp: Record<SortKey, (a: (typeof list)[0], b: (typeof list)[0]) => number> = {
      manual: (a, b) => a.p.sortOrder - b.p.sortOrder,
      name: (a, b) => a.p.name.localeCompare(b.p.name, undefined, { numeric: true }),
      status: (a, b) => STATUS_ORDER[a.st] - STATUS_ORDER[b.st] || a.p.name.localeCompare(b.p.name),
      lastUsed: (a, b) => (b.p.lastUsedAt ?? 0) - (a.p.lastUsedAt ?? 0),
      created: (a, b) => b.p.createdAt - a.p.createdAt,
    };
    return list.sort(cmp[sort]);
  }, [profiles, sessions, openTabs, query, sort]);

  const live = rows.filter((r) => r.st === 'running' || r.st === 'disconnected');
  const stopped = rows.filter((r) => r.st === 'stopped' || r.st === 'exited');

  const section = (title: string, list: typeof rows, hint: string) => (
    <section className="dash-section">
      <h3>
        {title} <span className="count">{list.length}</span>
        {hint && <span className="section-hint">{hint}</span>}
      </h3>
      {list.length === 0 ? (
        <div className="dash-empty">{t('None')}</div>
      ) : (
        <div className="dash-table" role="table">
          <div className="dash-row dash-head" role="row">
            <span>{t('Name')}</span>
            <span>{t('Status')}</span>
            <span>{t('Shell')}</span>
            <span>{t('Working directory')}</span>
            <span>{t('Created')}</span>
            <span>{t('Last used')}</span>
            <span>{t('Session ID')}</span>
            <span />
          </div>
          {list.map(({ p, s, st }) => (
            <div
              key={p.id}
              className="dash-row"
              role="row"
              onDoubleClick={() => onOpen(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onMenu(p.id, e.clientX, e.clientY);
              }}
            >
              <span className="dash-name">
                <span className="profile-color" style={{ background: p.color }} />
                <span>
                  <b>{p.name}</b>
                  {(st === 'running' || st === 'disconnected') && (stats[p.id] || titles.get(p.id)) ? (
                    <em className="live-info" dir="auto">{[titles.get(p.id), statsSummary(stats[p.id], titles.get(p.id))].filter(Boolean).join(', ')}</em>
                  ) : (
                    p.description && <em>{p.description}</em>
                  )}
                </span>
              </span>
              <span><StatusPill status={st} /></span>
              <span>{shellLabel(p, shells)}</span>
              <span className="mono ellipsis" title={p.cwd}>{p.cwd || '%USERPROFILE%'}</span>
              <span title={fmtDateFull(p.createdAt)}>{fmtDate(p.createdAt)}</span>
              <span title={fmtDateFull(p.lastUsedAt)}>{fmtDate(p.lastUsedAt)}</span>
              <span className="mono" title={s?.sessionId}>{s ? s.sessionId.slice(0, 8) : '—'}</span>
              <span className="dash-actions">
                <button className={cx('btn btn-sm', st !== 'running' && 'btn-primary')} onClick={() => onOpen(p.id)}>
                  {st === 'disconnected' ? <><Icon name="link" size={13} /> {t('Reconnect')}</> : st === 'running' ? <><Icon name="terminal" size={13} /> {t('Show')}</> : <><Icon name="play" size={13} /> {t('Open')}</>}
                </button>
                {(st === 'running' || st === 'disconnected') && (
                  <button className="icon-btn" title={t('Stop')} onClick={() => onStop(p.id)}><Icon name="stop" size={14} /></button>
                )}
                <button className="icon-btn" title={t('More actions')} onClick={(e) => onMenu(p.id, e.clientX, e.clientY)}><Icon name="more" size={16} /></button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="dashboard">
      <div className="dash-toolbar">
        <div>
          <h1>{t('All Terminals')}</h1>
          <p className="muted">
            {summarySentence(profiles.length, live.length, stats, adminLabel)}
          </p>
        </div>
        <div className="dash-controls">
          <div className="search-box">
            <Icon name="search" size={14} />
            <input placeholder={t('Search name, folder, notes…')} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label className="sort-select">
            <Icon name="sort" size={14} />
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
              <option value="manual">{t('Sidebar order')}</option>
              <option value="name">{t('Name')}</option>
              <option value="status">{t('Status')}</option>
              <option value="lastUsed">{t('Last used')}</option>
              <option value="created">{t('Created')}</option>
            </select>
          </label>
          {live.length > 1 && (
            <button className="btn btn-danger-ghost" onClick={onStopAll} title={t('Stop every running terminal')}>
              <Icon name="stop" size={14} /> {t('Stop all')}
            </button>
          )}
          <button className="btn" onClick={onImport} title={t('Import configuration')}><Icon name="upload" size={14} /> {t('Import')}</button>
          <button className="btn" onClick={onExportAll} title={t('Export configuration (never credentials)')}><Icon name="download" size={14} /> {t('Export')}</button>
          <button className="btn btn-primary" onClick={onNew}><Icon name="plus" size={14} /> {t('New Terminal')}</button>
        </div>
      </div>
      {profiles.length === 0 ? (
        <div className="welcome">
          <div className="welcome-icon"><Icon name="terminal" size={36} /></div>
          <h2>{t('Create your first terminal')}</h2>
          <p>{t('Each terminal keeps its own Claude Code, gcloud, GitHub and Git logins, its own variables and its own history. It still has full access to your machine.')}</p>
          <button className="btn btn-primary btn-lg" onClick={onNew}><Icon name="plus" size={16} /> {t('New Terminal')}</button>
        </div>
      ) : (
        <>
          {section(t('Running'), live, t('These keep running after you close the window.'))}
          {section(t('Stopped'), stopped, '')}
        </>
      )}

      <section className="dash-section">
        <h3>{t('New terminal from a template')}</h3>
        <div className="quick-grid">
          {QUICK.filter((q) => !q.shellId || shells.some((s) => s.id === q.shellId)).map((q) => (
            <button key={q.title} className="quick-tile" onClick={() => onQuickNew({ name: q.name, shellId: q.shellId, startupCommand: q.cmd })}>
              <span className="quick-icon" style={{ background: q.color }}><Icon name={q.icon} size={16} /></span>
              <span className="quick-text">
                <b>{q.title}</b>
                <em>{t(q.desc)}</em>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="dash-section">
        <h3>{t('Keyboard shortcuts')}</h3>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="shortcut">
              <span>{t(what)}</span>
              <span className="keys">{keys.split(' ').map((k) => <kbd key={k}>{k}</kbd>)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
