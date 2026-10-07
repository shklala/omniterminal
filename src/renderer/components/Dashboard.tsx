import { useMemo, useState } from 'react';
import type { Profile, SessionInfo, ShellInfo } from '../../shared/types';
import { cx, fmtBytes, fmtDate, fmtDateFull, shellLabel, statsSummary, uiStatus, type ResourceStats, type UiStatus } from '../util';
import { StatusPill } from './Chrome';
import { Icon } from './Icon';

type SortKey = 'name' | 'status' | 'lastUsed' | 'created' | 'manual';

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
}: {
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
        <span className="section-hint">{hint}</span>
      </h3>
      {list.length === 0 ? (
        <div className="dash-empty">None</div>
      ) : (
        <div className="dash-table" role="table">
          <div className="dash-row dash-head" role="row">
            <span>Name</span>
            <span>Status</span>
            <span>Shell</span>
            <span>Working directory</span>
            <span>Created</span>
            <span>Last used</span>
            <span>Session ID</span>
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
                    <em className="live-info">{[titles.get(p.id), statsSummary(stats[p.id], titles.get(p.id))].filter(Boolean).join(' · ')}</em>
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
                  {st === 'disconnected' ? <><Icon name="link" size={13} /> Reconnect</> : st === 'running' ? <><Icon name="terminal" size={13} /> Show</> : <><Icon name="play" size={13} /> Open</>}
                </button>
                {(st === 'running' || st === 'disconnected') && (
                  <button className="icon-btn" title="Stop" onClick={() => onStop(p.id)}><Icon name="stop" size={14} /></button>
                )}
                <button className="icon-btn" title="More actions" onClick={(e) => onMenu(p.id, e.clientX, e.clientY)}><Icon name="more" size={16} /></button>
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
          <h1>All Terminals</h1>
          <p className="muted">
            {profiles.length} terminal{profiles.length === 1 ? '' : 's'} · {live.length} running
            {Object.keys(stats).length > 0 && ` · ${fmtBytes(Object.values(stats).reduce((a, s) => a + s.memory, 0))} in use`}
          </p>
        </div>
        <div className="dash-controls">
          <div className="search-box">
            <Icon name="search" size={14} />
            <input placeholder="Search name, folder, notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <label className="sort-select">
            <Icon name="sort" size={14} />
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
              <option value="manual">Sidebar order</option>
              <option value="name">Name</option>
              <option value="status">Status</option>
              <option value="lastUsed">Last used</option>
              <option value="created">Created</option>
            </select>
          </label>
          {live.length > 1 && (
            <button className="btn btn-danger-ghost" onClick={onStopAll} title="Stop every running terminal">
              <Icon name="stop" size={14} /> Stop all
            </button>
          )}
          <button className="btn" onClick={onImport} title="Import configuration"><Icon name="upload" size={14} /> Import</button>
          <button className="btn" onClick={onExportAll} title="Export configuration (never credentials)"><Icon name="download" size={14} /> Export</button>
          <button className="btn btn-primary" onClick={onNew}><Icon name="plus" size={14} /> New Terminal</button>
        </div>
      </div>
      {profiles.length === 0 ? (
        <div className="welcome">
          <div className="welcome-icon"><Icon name="terminal" size={36} /></div>
          <h2>Create your first terminal</h2>
          <p>
            Every terminal is its own identity: separate Claude Code, gcloud, GitHub CLI and Git configuration, its own
            environment variables and its own shell history — with full access to your machine.
          </p>
          <button className="btn btn-primary btn-lg" onClick={onNew}><Icon name="plus" size={16} /> New Terminal</button>
        </div>
      ) : (
        <>
          {section('Running', live, 'Alive in the session manager — survives closing this window')}
          {section('Stopped', stopped, 'One click to start')}
        </>
      )}
    </div>
  );
}
