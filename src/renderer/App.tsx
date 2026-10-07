import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Profile, SessionInfo } from '../shared/types';
import type { ResourceStats } from './util';
import { api, bridge, errorMessage, type DaemonStatus } from './api';
import { AppSettingsDialog } from './components/AppSettingsDialog';
import { ContextMenu, Sidebar, TabBar, TopBar, type MenuItem } from './components/Chrome';
import { Dashboard } from './components/Dashboard';
import { FindBar } from './components/FindBar';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { ConfirmDialog, PromptDialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { NewTerminalDialog, ProfileSettingsDialog } from './components/ProfileDialogs';
import { TerminalView } from './components/TerminalView';
import { hosts } from './terminal/terminalHost';
import { uiStatus } from './util';

type DialogState =
  | { kind: 'new' }
  | { kind: 'settings'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'app-settings' }
  | { kind: 'exit' }
  | { kind: 'stop-all' }
  | null;

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

let toastId = 1;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus>({ connected: false, pid: null, message: 'Starting session manager…' });
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>('dashboard');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [, setHostTick] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [stats, setStats] = useState<Record<string, ResourceStats>>({});
  const [zoomMsg, setZoomMsg] = useState<string | null>(null);
  const zoomTimer = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const profilesRef = useRef<Profile[]>([]);
  /** Terminals the user is stopping on purpose (no "exited" toast for those). */
  const stopping = useRef(new Set<string>());
  const autoStart = useRef(new Map<string, boolean>());
  const initialized = useRef(false);
  const managerLost = useRef(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = toastId++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 4000);
  }, []);

  const toastRef = useRef(toast);
  toastRef.current = toast;

  const refreshTimer = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await api.getState());
    } catch {
      /* manager unavailable; status bar shows it */
    }
  }, []);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 60);
  }, [refresh]);

  // ----- session manager events -----
  useEffect(() => {
    const offEvent = bridge.onEvent((ev, data) => {
      if (ev === 'session.data') {
        const d = data as { profileId: string; sessionId: string; data: string };
        hosts.get(d.profileId)?.handleData(d.sessionId, d.data);
      } else if (ev === 'session.exit') {
        const d = data as { profileId: string; sessionId: string; exitCode: number | null };
        hosts.get(d.profileId)?.handleExit(d.sessionId, d.exitCode);
        if (!stopping.current.delete(d.profileId) && d.profileId !== activeRef.current) {
          const name = profilesRef.current.find((p) => p.id === d.profileId)?.name ?? 'A terminal';
          toastRef.current(`"${name}" exited (code ${d.exitCode ?? '?'})`, d.exitCode ? 'error' : 'info');
        }
        scheduleRefresh();
      } else if (ev === 'state.changed') {
        scheduleRefresh();
      }
    });
    const onStatus = (s: DaemonStatus) => {
      setDaemon(s);
      if (s.connected) {
        void refresh();
        if (managerLost.current) {
          managerLost.current = false;
          for (const h of hosts.values()) void h.onManagerReconnected();
        }
      } else if (initialized.current) {
        managerLost.current = true;
        for (const h of hosts.values()) h.markManagerLost();
      }
    };
    const offStatus = bridge.onDaemonStatus(onStatus);
    void bridge.daemonStatus().then(onStatus);
    return () => {
      offEvent();
      offStatus();
    };
  }, [refresh, scheduleRefresh]);

  // ----- startup: reconnect to every running session -----
  useEffect(() => {
    if (!state || initialized.current) return;
    initialized.current = true;
    void (async () => {
      const prefs = await api.getUiPrefs().catch(() => ({}) as Record<string, unknown>);
      const savedTabs = Array.isArray(prefs.openTabs) ? (prefs.openTabs as string[]) : [];
      const running = state.sessions.filter((s) => s.state === 'running').map((s) => s.profileId);
      const ordered = [...savedTabs.filter((id) => running.includes(id)), ...running.filter((id) => !savedTabs.includes(id))];
      ordered.forEach((id) => autoStart.current.set(id, false));
      setTabs(ordered);
      const savedActive = typeof prefs.active === 'string' ? prefs.active : '';
      setActive(ordered.includes(savedActive) ? savedActive : ordered[0] ?? 'dashboard');
      if (ordered.length) toast(`Reconnected to ${ordered.length} running terminal${ordered.length === 1 ? '' : 's'}`);
    })();
  }, [state, toast]);

  useEffect(() => {
    if (!initialized.current) return;
    void api.setUiPref('openTabs', tabs).catch(() => undefined);
    void api.setUiPref('active', active).catch(() => undefined);
  }, [tabs, active]);

  const profiles = state?.profiles ?? [];
  profilesRef.current = profiles;
  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const sessionMap = useMemo(() => new Map((state?.sessions ?? []).map((s) => [s.profileId, s] as [string, SessionInfo])), [state]);

  // Drop tabs whose profile was deleted (e.g. from another window). Runs only on fresh state,
  // so a tab opened for a just-created profile is never dropped by a stale snapshot.
  useEffect(() => {
    if (!state) return;
    const gone = tabsRef.current.filter((id) => !profileMap.has(id));
    if (gone.length === 0) return;
    gone.forEach((id) => {
      hosts.get(id)?.dispose(false);
      hosts.delete(id);
    });
    setTabs((t) => t.filter((id) => !gone.includes(id)));
    setActive((a) => (gone.includes(a) ? 'dashboard' : a));
  }, [state, profileMap]);

  // ----- actions -----
  const openTerminal = useCallback((id: string, start = true) => {
    if (!tabsRef.current.includes(id)) {
      autoStart.current.set(id, start);
      setTabs((t) => (t.includes(id) ? t : [...t, id]));
    } else {
      const h = hosts.get(id);
      if (h && start && (h.state === 'exited' || h.state === 'error')) void h.restart();
      else if (h && h.state === 'detached') void h.connect(start);
    }
    setActive(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    hosts.get(id)?.dispose(true);
    hosts.delete(id);
    setTabs((t) => {
      const idx = t.indexOf(id);
      const next = t.filter((x) => x !== id);
      setActive((a) => (a === id ? next[Math.min(idx, next.length - 1)] ?? 'dashboard' : a));
      return next;
    });
  }, []);

  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
      try {
        await fn();
        if (okMsg) toast(okMsg);
      } catch (e) {
        toast(errorMessage(e), 'error');
      } finally {
        scheduleRefresh();
      }
    },
    [toast, scheduleRefresh],
  );

  const stop = (id: string) => {
    stopping.current.add(id);
    return run(() => api.stop(id));
  };
  const stopAll = () =>
    run(async () => {
      const ids = (state?.sessions ?? []).filter((s) => s.state === 'running').map((s) => s.profileId);
      ids.forEach((id) => stopping.current.add(id));
      await Promise.all(ids.map((id) => api.stop(id)));
    }, 'Stopped all terminals');

  // Background tab printed output / rang the bell. Bells flash the taskbar and notify when unfocused.
  const onActivity = useCallback((profileId: string, kind: 'none' | 'output' | 'bell') => {
    setHostTick((t) => t + 1);
    if (kind !== 'bell') return;
    void bridge.attention();
    if (!document.hasFocus() && 'Notification' in window) {
      const name = profilesRef.current.find((p) => p.id === profileId)?.name ?? 'Terminal';
      const n = new Notification(`${name} needs attention`, { body: hosts.get(profileId)?.title || 'The program rang the terminal bell.', silent: false });
      n.onclick = () => {
        void bridge.focusWindow();
        setActive(profileId);
      };
    }
  }, []);

  const reorder = (ids: string[]) => {
    setState((st) => (st ? { ...st, profiles: ids.map((id) => st.profiles.find((p) => p.id === id)!).filter(Boolean).map((p, i) => ({ ...p, sortOrder: i + 1 })) } : st));
    void run(() => api.reorder(ids));
  };

  const zoom = (delta: number | 'reset') => {
    const h = hosts.get(activeRef.current);
    if (!h) return;
    h.zoom(delta);
    setZoomMsg(`${h.term.options.fontSize}px`);
    if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => setZoomMsg(null), 900);
  };
  const restart = (id: string) => {
    const h = hosts.get(id);
    if (h) return run(() => h.restartSession());
    return run(async () => {
      await api.restart(id);
      openTerminal(id, false);
    });
  };
  const reconnect = (id: string) => {
    const h = hosts.get(id);
    if (h) {
      h.state = 'detached';
      return run(() => h.connect(false));
    }
    openTerminal(id, false);
  };
  const duplicate = (id: string) =>
    run(async () => {
      const p = await api.duplicateProfile(id);
      toast(`Created "${p.name}" — configuration only. Credentials were NOT copied; sign in again there.`);
    });

  const menuItems = (id: string): (MenuItem | 'sep')[] => {
    const s = sessionMap.get(id);
    const running = s?.state === 'running';
    const open = tabs.includes(id);
    return [
      { label: running ? (open ? 'Show' : 'Reconnect') : 'Open', icon: running ? 'link' : 'play', onClick: () => openTerminal(id, true) },
      { label: 'Restart', icon: 'restart', onClick: () => void restart(id) },
      { label: 'Stop', icon: 'stop', disabled: !running, onClick: () => void stop(id) },
      'sep',
      { label: 'Rename…', icon: 'edit', onClick: () => setDialog({ kind: 'rename', id }) },
      { label: 'Duplicate (no credentials)', icon: 'copy', onClick: () => void duplicate(id) },
      { label: 'Settings…', icon: 'settings', onClick: () => setDialog({ kind: 'settings', id }) },
      { label: 'Export configuration…', icon: 'download', onClick: () => void run(() => bridge.exportProfiles([id])) },
      { label: 'Open profile folder', icon: 'folder', onClick: () => { const p = profileMap.get(id); if (p) void bridge.openPath(p.dir); } },
      'sep',
      { label: 'Delete…', icon: 'trash', danger: true, onClick: () => setDialog({ kind: 'delete', id }) },
    ];
  };

  // ----- keyboard shortcuts (also routed from inside xterm) -----
  const appShortcut = useCallback(
    (e: KeyboardEvent): boolean => {
      // Ctrl+Alt+1..9 switches to tab N (Windows Terminal convention).
      if (e.ctrlKey && e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const id = tabsRef.current[Number(e.code.slice(5)) - 1];
        if (!id) return false;
        setActive(id);
        e.preventDefault();
        return true;
      }
      const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
      if (!ctrl) return false;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === 'p') {
        setPaletteOpen(true);
      } else if (e.shiftKey && key === 't') {
        setDialog({ kind: 'new' });
      } else if (e.shiftKey && key === 'w') {
        if (active !== 'dashboard') closeTab(active);
      } else if (key === 'tab') {
        const order = ['dashboard', ...tabsRef.current];
        const i = order.indexOf(active);
        setActive(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
      } else if (e.shiftKey && key === 'a') {
        setActive('dashboard');
      } else if (e.shiftKey && key === 'f') {
        if (activeRef.current !== 'dashboard') setFindOpen(true);
      } else if (!e.shiftKey && (key === '=' || key === '+')) {
        zoom(1);
      } else if (!e.shiftKey && key === '-') {
        zoom(-1);
      } else if (!e.shiftKey && key === '0') {
        zoom('reset');
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    },
    [active, closeTab],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed in a terminal were already routed through appShortcut by xterm (and marked handled).
      if (dialog || e.defaultPrevented) return;
      appShortcut(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [appShortcut, dialog]);

  useEffect(() => {
    const p = active !== 'dashboard' ? profilesRef.current.find((x) => x.id === active) : undefined;
    const t = p ? hosts.get(p.id)?.title : '';
    document.title = p ? `${p.name}${t ? ` — ${t}` : ''} · OmniTerminal` : 'OmniTerminal';
  });

  useEffect(() => setFindOpen(false), [active]);

  // Resource usage of running terminals (process-tree memory), refreshed while anything runs.
  const anyRunning = (state?.sessions ?? []).some((s) => s.state === 'running');
  useEffect(() => {
    if (!anyRunning) {
      setStats({});
      return;
    }
    let stop = false;
    const tick = async () => {
      try {
        const r = await bridge.invoke<Record<string, ResourceStats>>('sessions.stats');
        if (!stop) setStats(r);
      } catch {
        /* manager busy or reconnecting */
      }
    };
    void tick();
    const t = window.setInterval(tick, 4000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [anyRunning]);

  // ----- render -----
  if (!state) {
    return (
      <div className="splash">
        <div className="brand-mark big"><Icon name="terminal" size={28} /></div>
        <div className="splash-title">OmniTerminal</div>
        <div className="muted">{daemon.message}</div>
      </div>
    );
  }

  const activeProfile = active !== 'dashboard' ? profileMap.get(active) : undefined;
  const activeSession = activeProfile ? sessionMap.get(activeProfile.id) : undefined;
  const dialogProfile = dialog && 'id' in dialog ? profileMap.get(dialog.id) : undefined;
  const runningCount = state.sessions.filter((s) => s.state === 'running').length;
  const activity = new Map([...hosts].map(([id, h]) => [id, h.activity] as [string, typeof h.activity]));
  const titles = new Map([...hosts].map(([id, h]) => [id, h.title] as [string, string]));
  const activeHost = activeProfile ? hosts.get(activeProfile.id) : undefined;

  const paletteItems: PaletteItem[] = [
    ...profiles.map((p): PaletteItem => {
      const st = uiStatus(sessionMap.get(p.id), tabs.includes(p.id));
      return {
        id: `t:${p.id}`,
        label: p.name,
        hint: st === 'stopped' || st === 'exited' ? 'start' : st === 'disconnected' ? 'reconnect' : hosts.get(p.id)?.title || 'running',
        icon: 'terminal',
        color: p.color,
        group: 'Terminals',
        run: () => openTerminal(p.id, true),
      };
    }),
    { id: 'a:new', label: 'New Terminal', hint: 'Ctrl+Shift+T', icon: 'plus', group: 'Actions', run: () => setDialog({ kind: 'new' }) },
    { id: 'a:all', label: 'Show All Terminals', hint: 'Ctrl+Shift+A', icon: 'grid', group: 'Actions', run: () => setActive('dashboard') },
    ...(activeProfile
      ? ([
          { id: 'a:restart', label: `Restart ${activeProfile.name}`, icon: 'restart', group: 'Actions', run: () => void restart(activeProfile.id) },
          { id: 'a:stop', label: `Stop ${activeProfile.name}`, icon: 'stop', group: 'Actions', run: () => void stop(activeProfile.id) },
          { id: 'a:settings', label: `Settings: ${activeProfile.name}`, icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'settings', id: activeProfile.id }) },
          { id: 'a:dup', label: `Duplicate ${activeProfile.name} (no credentials)`, icon: 'copy', group: 'Actions', run: () => void duplicate(activeProfile.id) },
          { id: 'a:find', label: 'Find in Terminal', hint: 'Ctrl+Shift+F', icon: 'search', group: 'Actions', run: () => setFindOpen(true) },
          { id: 'a:folder', label: `Open Profile Folder: ${activeProfile.name}`, icon: 'folder', group: 'Actions', run: () => void bridge.openPath(activeProfile.dir) },
        ] as PaletteItem[])
      : []),
    { id: 'a:stopall', label: 'Stop All Terminals', icon: 'stop', group: 'Actions', run: () => setDialog({ kind: 'stop-all' }) },
    {
      id: 'a:import', label: 'Import Terminal Configuration…', icon: 'upload', group: 'Actions',
      run: () => void run(async () => {
        const n = await bridge.importProfiles();
        if (n) toast(`Imported ${n} terminal${n === 1 ? '' : 's'}`);
      }),
    },
    { id: 'a:export', label: 'Export All Terminal Configuration…', icon: 'download', group: 'Actions', run: () => void run(() => bridge.exportProfiles()) },
    { id: 'a:appsettings', label: 'OmniTerminal Settings', icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'app-settings' }) },
    { id: 'a:exit', label: 'Exit Completely (stop everything)', icon: 'power', group: 'Actions', run: () => setDialog({ kind: 'exit' }) },
  ];

  return (
    <div className="app">
      <Sidebar
        profiles={profiles}
        sessions={sessionMap}
        openTabs={tabs}
        active={active}
        daemon={daemon}
        onNew={() => setDialog({ kind: 'new' })}
        onSelect={(id) => openTerminal(id, true)}
        onDashboard={() => setActive('dashboard')}
        onContextMenu={(id, x, y) => setMenu({ id, x, y })}
        onSettings={() => setDialog({ kind: 'app-settings' })}
        onReorder={reorder}
        activity={activity}
      />
      <main className="main">
        <TabBar
          tabs={tabs}
          profiles={profileMap}
          sessions={sessionMap}
          active={active}
          onSelect={setActive}
          onClose={closeTab}
          onNew={() => setDialog({ kind: 'new' })}
          activity={activity}
          titles={titles}
        />
        {activeProfile && (
          <TopBar
            profile={activeProfile}
            session={activeSession}
            shells={state.shells}
            status={uiStatus(activeSession, true)}
            onNew={() => setDialog({ kind: 'new' })}
            onReconnect={() => void reconnect(activeProfile.id)}
            onRestart={() => void restart(activeProfile.id)}
            onStop={() => void stop(activeProfile.id)}
            onSettings={() => setDialog({ kind: 'settings', id: activeProfile.id })}
            onStart={() => openTerminal(activeProfile.id, true)}
            programTitle={activeHost?.title ?? ''}
            stats={stats[activeProfile.id]}
          />
        )}
        <div className="content">
          {active === 'dashboard' && (
            <Dashboard
              profiles={profiles}
              sessions={sessionMap}
              shells={state.shells}
              openTabs={tabs}
              onOpen={(id) => openTerminal(id, true)}
              onStop={(id) => void stop(id)}
              onNew={() => setDialog({ kind: 'new' })}
              onMenu={(id, x, y) => setMenu({ id, x, y })}
              onImport={() => void run(async () => {
                const n = await bridge.importProfiles();
                if (n) toast(`Imported ${n} terminal${n === 1 ? '' : 's'} (configuration only)`);
              })}
              onExportAll={() => void run(() => bridge.exportProfiles())}
              onStopAll={() => setDialog({ kind: 'stop-all' })}
              stats={stats}
              titles={titles}
            />
          )}
          <div className={`terminal-stack ${active === 'dashboard' ? 'hidden' : ''}`}>
            {tabs.map((id) => {
              const p = profileMap.get(id);
              if (!p) return null;
              return (
                <TerminalView
                  key={id}
                  profile={p}
                  active={active === id}
                  autoStart={autoStart.current.get(id) ?? true}
                  onHostState={() => setHostTick((t) => t + 1)}
                  onActivity={onActivity}
                  onAppShortcut={appShortcut}
                />
              );
            })}
            {findOpen && activeHost && <FindBar key={activeProfile?.id} host={activeHost} onClose={() => setFindOpen(false)} />}
            {zoomMsg && active !== 'dashboard' && <div className="zoom-indicator">Font size {zoomMsg}</div>}
          </div>
        </div>
      </main>

      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'new' && (
        <NewTerminalDialog state={state} onClose={() => setDialog(null)} onCreated={async (p: Profile) => { await refresh(); openTerminal(p.id, true); }} />
      )}
      {dialog?.kind === 'settings' && dialogProfile && (
        <ProfileSettingsDialog
          state={state}
          profile={dialogProfile}
          session={sessionMap.get(dialogProfile.id)}
          onClose={() => setDialog(null)}
          onSaved={(p, needsRestart) => {
            void refresh();
            hosts.get(p.id)?.applyAppearance(p.appearance);
            toast(needsRestart ? 'Saved. Restart the terminal to apply shell/environment changes.' : 'Saved');
          }}
        />
      )}
      {dialog?.kind === 'rename' && dialogProfile && (
        <PromptDialog
          title="Rename terminal"
          label="Name"
          initial={dialogProfile.name}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.renameProfile(dialogProfile.id, name);
            scheduleRefresh();
          }}
        />
      )}
      {dialog?.kind === 'delete' && dialogProfile && (
        <ConfirmDialog
          title={`Delete "${dialogProfile.name}"?`}
          danger
          confirmLabel="Delete terminal"
          message={
            <>
              The terminal will be stopped and removed from OmniTerminal.
              <div className="mono small muted" style={{ marginTop: 8 }}>{dialogProfile.dir}</div>
            </>
          }
          checkbox={{ label: 'Also delete its private data (tool logins, credentials, history, logs)', defaultChecked: true }}
          onClose={() => setDialog(null)}
          onConfirm={async (deleteFiles) => {
            closeTab(dialogProfile.id);
            await run(() => api.deleteProfile(dialogProfile.id, deleteFiles), `Deleted "${dialogProfile.name}"`);
          }}
        />
      )}
      {dialog?.kind === 'app-settings' && (
        <AppSettingsDialog state={state} toast={toast} onClose={() => setDialog(null)} onExitCompletely={() => setDialog({ kind: 'exit' })} />
      )}
      {dialog?.kind === 'stop-all' && (
        <ConfirmDialog
          title="Stop all terminals?"
          danger
          confirmLabel={`Stop ${runningCount} terminal${runningCount === 1 ? '' : 's'}`}
          message="Every running terminal and the programs inside them will be stopped. Their settings, logins and history are kept."
          onClose={() => setDialog(null)}
          onConfirm={() => stopAll()}
        />
      )}
      {dialog?.kind === 'exit' && (
        <ConfirmDialog
          title="Exit OmniTerminal completely?"
          danger
          confirmLabel="Stop everything and exit"
          message={
            runningCount > 0
              ? `This stops ${runningCount} running terminal${runningCount === 1 ? '' : 's'} (and every program running inside them) and shuts down the session manager.`
              : 'This shuts down the session manager.'
          }
          onClose={() => setDialog(null)}
          onConfirm={() => bridge.exitCompletely()}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} size={14} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
