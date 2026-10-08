// Window chrome: sidebar, tab bar, top bar, context menu.

import { Fragment, useEffect, useRef, useState } from 'react';
import type { Profile, SessionInfo, ShellInfo } from '../../shared/types';
import type { DaemonStatus } from '../api';
import { baseProfileId, instanceNumber } from '../../shared/sessionKey';
import { STATUS_LABEL, cx, shellLabel, statsSummary, uiStatus, type ResourceStats, type UiStatus } from '../util';
import { Icon } from './Icon';
import { t } from '../i18n';

export function StatusDot({ status }: { status: UiStatus }) {
  return <span className={cx('status-dot', `st-${status}`)} title={t(STATUS_LABEL[status])} />;
}

export function ActivityBadge({ kind }: { kind: 'none' | 'output' | 'bell' | undefined }) {
  if (!kind || kind === 'none') return null;
  return (
    <span
      className={cx('activity', `activity-${kind}`)}
      title={kind === 'bell' ? t('Needs attention (the program rang the bell)') : t('New output')}
    />
  );
}

export function StatusPill({ status }: { status: UiStatus }) {
  return (
    <span className={cx('status-pill', `st-${status}`)}>
      <span className="status-dot" />
      {t(STATUS_LABEL[status])}
    </span>
  );
}

export function Sidebar({
  profiles,
  sessions,
  openTabs,
  active,
  daemon,
  onNew,
  onSelect,
  onDashboard,
  onContextMenu,
  onSettings,
  onReorder,
  activity,
  shells,
  titles,
  instances,
}: {
  shells: ShellInfo[];
  titles: Map<string, string>;
  /** Extra running shells ("Open another"), grouped by terminal. */
  instances: Map<string, SessionInfo[]>;
  profiles: Profile[];
  sessions: Map<string, SessionInfo>;
  openTabs: string[];
  active: string;
  daemon: DaemonStatus;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDashboard: () => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onSettings: () => void;
  onReorder: (ids: string[]) => void;
  activity: Map<string, 'none' | 'output' | 'bell'>;
}) {
  const [filter, setFilter] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const canDrag = filter === '';
  const drop = () => {
    if (dragId && dropTarget && dragId !== dropTarget.id) {
      const ids = profiles.map((p) => p.id).filter((id) => id !== dragId);
      const idx = ids.indexOf(dropTarget.id) + (dropTarget.after ? 1 : 0);
      ids.splice(idx, 0, dragId);
      onReorder(ids);
    }
    setDragId(null);
    setDropTarget(null);
  };
  const shown = profiles.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  // Terminals with at least one running shell (extra shells of the same terminal count once).
  const runningCount = new Set([...sessions.values()].filter((s) => s.state === 'running').map((s) => s.profileId)).size;
  return (
    <aside className="sidebar">
      <div className="brand drag">
        <div className="brand-mark"><Icon name="terminal" size={15} /></div>
        <span>OmniTerminal</span>
      </div>
      <button className="btn btn-primary new-btn" onClick={onNew} title="New Terminal (Ctrl+Shift+T)">
        <Icon name="plus" size={16} /> {t('New Terminal')}
      </button>
      <button className={cx('nav-item', active === 'dashboard' && 'active')} onClick={onDashboard}>
        <Icon name="grid" size={15} />
        <span>{t('All Terminals')}</span>
        <span className="nav-count">{runningCount}/{profiles.length}</span>
      </button>
      <div className="sidebar-search">
        <Icon name="search" size={14} />
        <input placeholder={t('Filter terminals')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="profile-list" role="list">
        {shown.map((p) => {
          const st = uiStatus(sessions.get(p.id), openTabs.includes(p.id));
          return (
            <Fragment key={p.id}>
            <button
              role="listitem"
              className={cx(
                'profile-item',
                active === p.id && 'active',
                dragId === p.id && 'dragging',
                dropTarget?.id === p.id && (dropTarget.after ? 'drop-after' : 'drop-before'),
              )}
              draggable={canDrag}
              onDragStart={(e) => {
                setDragId(p.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setDropTarget({ id: p.id, after: e.clientY > r.top + r.height / 2 });
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropTarget(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop();
              }}
              onClick={() => onSelect(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(p.id, e.clientX, e.clientY);
              }}
              title={`${p.name} (${t(STATUS_LABEL[st]).toLowerCase()})`}
            >
              <span className="profile-color" style={{ background: p.color }} />
              <span className="profile-text">
                <span className="profile-name">{p.name}</span>
                <span className="profile-sub" dir="auto">
                  {st === 'running' || st === 'disconnected'
                    ? `${sessions.get(p.id)?.elevated ? t('Admin: ') : ''}${titles.get(p.id) || shellLabel(p, shells)}${st === 'disconnected' ? t(' (in background)') : ''}`
                    : t('Stopped')}
                </span>
              </span>
              {/* Only "needs attention" shows here; ongoing output is shown on tabs. */}
              <ActivityBadge kind={activity.get(p.id) === 'bell' ? 'bell' : 'none'} />
              <StatusDot status={st} />
            </button>
            {(instances.get(p.id) ?? []).map((inst) => {
              const ist = uiStatus(inst, openTabs.includes(inst.key));
              return (
                <button
                  key={inst.key}
                  role="listitem"
                  className={cx('profile-item', 'instance-item', active === inst.key && 'active')}
                  onClick={() => onSelect(inst.key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onContextMenu(inst.key, e.clientX, e.clientY);
                  }}
                  title={`${p.name} ${inst.instance}`}
                >
                  <span className="profile-text">
                    <span className="profile-name">{`${p.name} ${inst.instance}`}</span>
                  </span>
                  <ActivityBadge kind={activity.get(inst.key) === 'bell' ? 'bell' : 'none'} />
                  <StatusDot status={ist} />
                </button>
              );
            })}
            </Fragment>
          );
        })}
        {profiles.length === 0 && <div className="empty-hint">{t('No terminals yet.')}</div>}
        {profiles.length > 0 && shown.length === 0 && <div className="empty-hint">{t('No match.')}</div>}
      </div>
      <div className="sidebar-footer">
        <div className={cx('daemon-status', daemon.connected ? 'ok' : 'bad')} title={daemon.message}>
          <span className="status-dot" />
          <span>{daemon.connected ? t('Session manager running') : daemon.message}</span>
        </div>
        <button className="icon-btn" onClick={onSettings} title={t('Application settings')}>
          <Icon name="settings" size={16} />
        </button>
      </div>
    </aside>
  );
}

export function TabBar({
  tabs,
  profiles,
  sessions,
  active,
  onSelect,
  onClose,
  onNew,
  activity,
  titles,
  panes,
}: {
  /** Number of extra split panes per tab. */
  panes: Map<string, number>;
  tabs: string[];
  profiles: Map<string, Profile>;
  sessions: Map<string, SessionInfo>;
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  activity: Map<string, 'none' | 'output' | 'bell'>;
  titles: Map<string, string>;
}) {
  return (
    <div className="tabbar drag">
      <div className="tabs no-drag">
        {tabs.map((id) => {
          const p = profiles.get(baseProfileId(id));
          if (!p) return null;
          const st = uiStatus(sessions.get(id), true);
          const n = instanceNumber(id);
          return (
            <div
              key={id}
              className={cx('tab', active === id && 'active')}
              onClick={() => onSelect(id)}
              onAuxClick={(e) => e.button === 1 && onClose(id)}
              title={titles.get(id) ? `${p.name}: ${titles.get(id)}` : p.name}
            >
              <span className="tab-color" style={{ background: p.color }} />
              <StatusDot status={st} />
              <span className="tab-name">{n > 1 ? `${p.name} ${n}` : p.name}</span>
              {(panes.get(id) ?? 0) > 0 && <span className="tab-panes" title={t('Split into {n} panes', { n: (panes.get(id) ?? 0) + 1 })}>+{panes.get(id)}</span>}
              <ActivityBadge kind={activity.get(id)} />
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
                title={t('Close tab (session keeps running)')}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        <button className="tab-new" onClick={onNew} title={t('New Terminal')}>
          <Icon name="plus" size={14} />
        </button>
      </div>
    </div>
  );
}

export function TopBar({
  profile,
  session,
  shells,
  status,
  onNew,
  onReconnect,
  onRestart,
  onStop,
  onSettings,
  onStart,
  programTitle,
  stats,
  admin,
  onRunAsAdmin,
  onRestartNormal,
  more,
  broadcasting,
}: {
  /** Extra terminal actions behind the "More" button (accounts, split, broadcast, snippets…). */
  more: (MenuItem | 'sep')[];
  /** Input typed here also goes to the other panes of this tab. */
  broadcasting: boolean;
  /**
   * 'all': the whole app runs as administrator; 'session': this terminal was started as administrator;
   * 'available': can be restarted as administrator; null: not applicable (e.g. WSL).
   */
  admin: 'all' | 'session' | 'available' | null;
  onRunAsAdmin: () => void;
  onRestartNormal: () => void;
  programTitle: string;
  stats: ResourceStats | undefined;
  profile: Profile;
  session: SessionInfo | undefined;
  shells: ShellInfo[];
  status: UiStatus;
  onNew: () => void;
  onReconnect: () => void;
  onRestart: () => void;
  onStop: () => void;
  onSettings: () => void;
  onStart: () => void;
}) {
  const running = session?.state === 'running';
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="topbar">
      <div className="topbar-info">
        <span className="topbar-color" style={{ background: profile.color }} />
        <div className="topbar-text">
          <div className="topbar-title">
            <span className="name">{profile.name}</span>
            <StatusPill status={status} />
            {(admin === 'all' || admin === 'session') && (
              <span className="admin-pill" title={t('This terminal runs with administrator rights')}>
                <Icon name="shield" size={11} /> {t('Administrator')}
              </span>
            )}
            {broadcasting && (
              <span className="broadcast-pill" title={t('What you type goes to every pane in this tab')}>
                <Icon name="broadcast" size={11} /> {t('Typing into all panes')}
              </span>
            )}
            {programTitle && <span className="program-title" title={t('Title set by the running program')}>{programTitle}</span>}
          </div>
          <div className="topbar-meta">
            <span>{shellLabel(profile, shells)}</span>
            <span className="mono" title={profile.cwd || 'User folder'}>{profile.cwd || '%USERPROFILE%'}</span>
            {session && (
              <>
                    <span className="mono" title="Session ID">{session.sessionId.slice(0, 8)}</span>
              </>
            )}
            {running && stats && (
              <>
                    <span dir="auto" title={`${stats.processes} process(es) in this terminal`}>{statsSummary(stats, programTitle)}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="topbar-actions">
        <button className="btn btn-sm" onClick={onNew} title={t('New Terminal')}><Icon name="plus" size={14} /> {t('New')}</button>
        {running ? (
          <button className="btn btn-sm" onClick={onReconnect} title={t('Re-attach to the running session')}><Icon name="link" size={14} /> {t('Reconnect')}</button>
        ) : (
          <button className="btn btn-sm" onClick={onStart} title={t('Start session')}><Icon name="play" size={14} /> {t('Start')}</button>
        )}
        {admin === 'available' && (
          <button className="btn btn-sm btn-admin" onClick={onRunAsAdmin} title={t('Restart this terminal with administrator rights (Windows asks for permission once)')}>
            <Icon name="shield" size={14} /> {t('Run as Administrator')}
          </button>
        )}
        {admin === 'session' && (
          <button className="btn btn-sm" onClick={onRestartNormal} title={t('Restart this terminal with your normal rights')}>
            <Icon name="restart" size={14} /> {t('Restart normally')}
          </button>
        )}
        <button className="btn btn-sm" onClick={onRestart} title={t('Restart the shell')}><Icon name="restart" size={14} /> {t('Restart')}</button>
        <button className="btn btn-sm btn-danger-ghost" onClick={onStop} disabled={!running} title={t('Stop the shell and its processes')}><Icon name="stop" size={14} /> {t('Stop')}</button>
        <button className="btn btn-sm" onClick={onSettings} title={t('Terminal settings')}><Icon name="settings" size={14} /> {t('Settings')}</button>
        <button
          className="icon-btn"
          title={t('More: accounts, split, snippets…')}
          aria-label={t('More actions')}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenuAt({ x: r.right - 240, y: r.bottom + 4 });
          }}
        >
          <Icon name="more" size={16} />
        </button>
      </div>
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} items={more} onClose={() => setMenuAt(null)} />}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | 'sep')[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    }
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={cx('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            <span>{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
