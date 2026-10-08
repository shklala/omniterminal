import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Profile, SessionInfo } from '../shared/types';
import type { ResourceStats } from './util';
import { api, bridge, errorMessage, type DaemonStatus, type ElevationStatus } from './api';
import { AppSettingsDialog } from './components/AppSettingsDialog';
import { ContextMenu, Sidebar, TabBar, TopBar, type MenuItem } from './components/Chrome';
import { Dashboard } from './components/Dashboard';
import { FindBar } from './components/FindBar';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { ConfirmDialog, PromptDialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { NewTerminalDialog, ProfileSettingsDialog, type NewTerminalPreset } from './components/ProfileDialogs';
import { TerminalView } from './components/TerminalView';
import { hosts } from './terminal/terminalHost';
import { supportsElevation, uiStatus } from './util';
import { baseProfileId, instanceNumber } from '../shared/sessionKey';
import { getLanguage, setLanguage, t } from './i18n';
import { setCustomThemes } from './themes';

type DialogState =
  | { kind: 'new'; preset?: NewTerminalPreset }
  | { kind: 'settings'; id: string }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'app-settings' }
  | { kind: 'exit' }
  | { kind: 'stop-all' }
  | { kind: 'enable-sudo'; id: string; then: 'continue' | 'restart' }
  | { kind: 'run-admin'; id: string }
  | { kind: 'no-sudo'; id: string }
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
  const [elevation, setElevation] = useState<ElevationStatus | null>(null);
  const [adminHint, setAdminHint] = useState<string | null>(null);
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
          toastRef.current(t('"{name}" exited (code {code})', { name, code: d.exitCode ?? '?' }), d.exitCode ? 'error' : 'info');
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
      const running = state.sessions.filter((s) => s.state === 'running').map((s) => s.key);
      const ordered = [...savedTabs.filter((id) => running.includes(id)), ...running.filter((id) => !savedTabs.includes(id))];
      ordered.forEach((id) => autoStart.current.set(id, false));
      setTabs(ordered);
      const savedActive = typeof prefs.active === 'string' ? prefs.active : '';
      setActive(ordered.includes(savedActive) ? savedActive : ordered[0] ?? 'dashboard');
      if (ordered.length) toast(ordered.length === 1 ? t('Reconnected to 1 running terminal') : t('Reconnected to {n} running terminals', { n: ordered.length }));
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
  /** Live shells by session key. A terminal's first shell uses its profile id as key. */
  const sessionMap = useMemo(() => new Map((state?.sessions ?? []).map((s) => [s.key, s] as [string, SessionInfo])), [state]);
  const instanceMap = useMemo(() => {
    const m = new Map<string, SessionInfo[]>();
    for (const s of state?.sessions ?? []) {
      if (s.instance > 1 && s.state === 'running') m.set(s.profileId, [...(m.get(s.profileId) ?? []), s].sort((a, b) => a.instance - b.instance));
    }
    return m;
  }, [state]);

  // Drop tabs whose profile was deleted (e.g. from another window). Runs only on fresh state,
  // so a tab opened for a just-created profile is never dropped by a stale snapshot.
  useEffect(() => {
    if (!state) return;
    const gone = tabsRef.current.filter((id) => !profileMap.has(baseProfileId(id)));
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
    }, t('Stopped all terminals'));

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

  // ----- administrator rights -----
  useEffect(() => {
    if (!daemon.connected) return;
    void bridge.invoke<ElevationStatus>('system.elevation').then(setElevation).catch(() => undefined);
  }, [daemon.connected]);

  const shellKind = (id: string) => {
    const p = profilesRef.current.find((x) => x.id === baseProfileId(id));
    return state?.shells.find((s) => s.id === p?.shellId)?.kind;
  };

  /** Continue this terminal with administrator rights, in place (Windows sudo, inline mode). */
  const continueAsAdmin = async (id: string) => {
    setAdminHint(null);
    const status = await bridge.invoke<ElevationStatus>('system.elevation').catch(() => null);
    if (status) setElevation(status);
    if (!status) return toast('Could not check administrator support.', 'error');
    if (status.managerElevated) return toast('This terminal already has administrator rights.');
    if (!supportsElevation(shellKind(id))) {
      return toast('Continue as Administrator works in PowerShell, Command Prompt and Git Bash terminals.', 'error');
    }
    if (status.sudo === 'unavailable') return setDialog({ kind: 'no-sudo', id });
    if (status.sudo !== 'inline') return setDialog({ kind: 'enable-sudo', id, then: 'continue' });
    openTerminal(id, false);
    await run(() => bridge.invoke('sessions.elevate', { profileId: id }));
    hosts.get(id)?.focus();
  };

  /** "Run as Administrator": restart the terminal with administrator rights (Windows sudo). */
  const runAsAdmin = async (id: string, confirmed = false) => {
    const status = await bridge.invoke<ElevationStatus>('system.elevation').catch(() => null);
    if (status) setElevation(status);
    if (!status) return toast('Could not check administrator support.', 'error');
    if (status.managerElevated) return toast('OmniTerminal already runs as administrator, so every terminal has administrator rights.');
    if (!supportsElevation(shellKind(id))) {
      return toast('Run as Administrator works in PowerShell, Command Prompt and Git Bash terminals.', 'error');
    }
    if (status.sudo === 'unavailable') return setDialog({ kind: 'no-sudo', id });
    if (status.sudo !== 'inline') return setDialog({ kind: 'enable-sudo', id, then: 'restart' });
    const running = sessionMap.get(id)?.state === 'running';
    if (running && !confirmed) return setDialog({ kind: 'run-admin', id });
    await restartAs(id, true);
  };

  const restartAs = async (id: string, elevated: boolean) => {
    stopping.current.add(id);
    const h = hosts.get(id);
    if (h) {
      setActive(id);
      await run(() => h.restartSession(elevated));
    } else {
      await run(async () => {
        await api.restart(id, undefined, undefined, elevated);
        openTerminal(id, false);
      });
    }
    hosts.get(id)?.focus();
  };

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
      const p = await api.duplicateProfile(baseProfileId(id));
      toast(`Created "${p.name}" with the same settings. Logins and secrets were not copied, so sign in there again.`);
    });

  /** "Open another": a new shell of the same terminal, sharing its accounts and variables. */
  const openAnother = (id: string) =>
    run(async () => {
      const info = await bridge.invoke<SessionInfo>('sessions.newInstance', { profileId: baseProfileId(id) });
      await refresh();
      openTerminal(info.key, false);
    });

  const menuItems = (key: string): (MenuItem | 'sep')[] => {
    const id = baseProfileId(key);
    const s = sessionMap.get(key);
    const running = s?.state === 'running';
    const open = tabs.includes(key);
    return [
      { label: t(running ? (open ? 'Show' : 'Reconnect') : 'Open'), icon: running ? 'link' : 'play', onClick: () => openTerminal(key, true) },
      { label: t('Restart'), icon: 'restart', onClick: () => void restart(key) },
      { label: t('Stop'), icon: 'stop', disabled: !running, onClick: () => void stop(key) },
      ...(supportsElevation(shellKind(id)) && !elevation?.managerElevated
        ? s?.elevated
          ? [{ label: t('Restart normally (not admin)'), icon: 'restart', onClick: () => void restartAs(key, false) }]
          : [
              { label: t('Run as Administrator'), icon: 'shield', onClick: () => void runAsAdmin(key) },
              { label: t('Continue as Administrator (in place)'), icon: 'shield', disabled: !running, onClick: () => void continueAsAdmin(key) },
            ]
        : []),
      { label: t('Open another'), icon: 'plus', onClick: () => void openAnother(key) },
      'sep',
      { label: t('Rename…'), icon: 'edit', onClick: () => setDialog({ kind: 'rename', id }) },
      { label: t('Duplicate (no credentials)'), icon: 'copy', onClick: () => void duplicate(id) },
      { label: t('Settings…'), icon: 'settings', onClick: () => setDialog({ kind: 'settings', id }) },
      { label: t('Export configuration…'), icon: 'download', onClick: () => void run(() => bridge.exportProfiles([id])) },
      { label: t('Open profile folder'), icon: 'folder', onClick: () => { const p = profileMap.get(id); if (p) void bridge.openPath(p.dir); } },
      'sep',
      { label: t('Delete…'), icon: 'trash', danger: true, onClick: () => setDialog({ kind: 'delete', id }) },
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
      } else if (e.shiftKey && key === 'd') {
        if (activeRef.current !== 'dashboard') void openAnother(activeRef.current);
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
    document.title = p ? `${t ? `${t} - ` : ''}${p.name} - OmniTerminal` : 'OmniTerminal';
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
      // Each sample asks Windows for the process table; skip it when nobody is looking.
      if (document.hidden || !document.hasFocus()) return;
      try {
        const r = await bridge.invoke<Record<string, ResourceStats>>('sessions.stats');
        if (!stop) setStats(r);
      } catch {
        /* manager busy or reconnecting */
      }
    };
    void tick();
    const t = window.setInterval(tick, 5000);
    window.addEventListener('focus', tick);
    return () => {
      stop = true;
      window.clearInterval(t);
      window.removeEventListener('focus', tick);
    };
  }, [anyRunning]);

  // Repaint open terminals when a custom theme is created, edited or deleted.
  const customThemesJson = JSON.stringify(state?.customThemes ?? []);
  useEffect(() => {
    setCustomThemes(JSON.parse(customThemesJson));
    for (const h of hosts.values()) h.refreshTheme();
  }, [customThemesJson]);

  // ----- theme -----
  const uiTheme = state?.settings.uiTheme ?? 'dark';
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = uiTheme === 'system' ? (mq.matches ? 'dark' : 'light') : ['light', 'midnight', 'nord'].includes(uiTheme) ? uiTheme : 'dark';
      document.documentElement.dataset.theme = resolved;
      void bridge.setTitleBar(resolved);
    };
    apply();
    if (uiTheme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [uiTheme]);

  const setAppSetting = (patch: Record<string, unknown>) => void run(async () => {
    await api.setSettings(patch);
    await refresh();
  });

  // ----- render -----
  if (state && state.settings.language !== getLanguage()) setLanguage(state.settings.language);
  if (state) setCustomThemes(state.customThemes);
  if (!state) {
    return (
      <div className="splash">
        <div className="brand-mark big"><Icon name="terminal" size={28} /></div>
        <div className="splash-title">OmniTerminal</div>
        <div className="muted">{daemon.message}</div>
      </div>
    );
  }

  const activeProfile = active !== 'dashboard' ? profileMap.get(baseProfileId(active)) : undefined;
  const activeSession = activeProfile ? sessionMap.get(active) : undefined;
  const activeInstance = instanceNumber(active);
  const dialogProfile = dialog && 'id' in dialog ? profileMap.get(baseProfileId(dialog.id)) : undefined;
  const runningCount = state.sessions.filter((s) => s.state === 'running').length;
  const activity = new Map([...hosts].map(([id, h]) => [id, h.activity] as [string, typeof h.activity]));
  // Program titles, minus the terminal's own name (PowerShell titles itself after the profile).
  const titles = new Map([...hosts].map(([id, h]) => [id, h.title === profileMap.get(baseProfileId(id))?.name ? '' : h.title] as [string, string]));
  const activeHost = activeProfile ? hosts.get(activeProfile.id) : undefined;

  const paletteItems: PaletteItem[] = [
    ...profiles.map((p): PaletteItem => {
      const st = uiStatus(sessionMap.get(p.id), tabs.includes(p.id));
      return {
        id: `t:${p.id}`,
        label: p.name,
        hint: st === 'stopped' || st === 'exited' ? t('start') : st === 'disconnected' ? t('reconnect') : titles.get(p.id) || t('running'),
        icon: 'terminal',
        color: p.color,
        group: 'Terminals',
        run: () => openTerminal(p.id, true),
      };
    }),
    { id: 'a:new', label: t('New Terminal'), hint: 'Ctrl+Shift+T', icon: 'plus', group: 'Actions', run: () => setDialog({ kind: 'new' }) },
    { id: 'a:all', label: t('Show All Terminals'), hint: 'Ctrl+Shift+A', icon: 'grid', group: 'Actions', run: () => setActive('dashboard') },
    ...(activeProfile
      ? ([
          { id: 'a:another', label: t('Open another {name}', { name: activeProfile.name }), hint: 'Ctrl+Shift+D', icon: 'plus', group: 'Actions', run: () => void openAnother(active) },
          { id: 'a:restart', label: t('Restart {name}', { name: activeProfile.name }), icon: 'restart', group: 'Actions', run: () => void restart(active) },
          { id: 'a:stop', label: t('Stop {name}', { name: activeProfile.name }), icon: 'stop', group: 'Actions', run: () => void stop(active) },
          { id: 'a:settings', label: t('Settings: {name}', { name: activeProfile.name }), icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'settings', id: activeProfile.id }) },
          { id: 'a:dup', label: t('Duplicate {name} (no credentials)', { name: activeProfile.name }), icon: 'copy', group: 'Actions', run: () => void duplicate(activeProfile.id) },
          ...(supportsElevation(shellKind(activeProfile.id)) && !elevation?.managerElevated
            ? [
                { id: 'a:runadmin', label: t('Run {name} as Administrator', { name: activeProfile.name }), icon: 'shield', group: 'Actions' as const, run: () => void runAsAdmin(active) },
                { id: 'a:admin', label: t('Continue {name} as Administrator (in place)', { name: activeProfile.name }), icon: 'shield', group: 'Actions' as const, run: () => void continueAsAdmin(active) },
              ]
            : []),
          { id: 'a:find', label: t('Find in Terminal'), hint: 'Ctrl+Shift+F', icon: 'search', group: 'Actions', run: () => setFindOpen(true) },
          { id: 'a:folder', label: t('Open Profile Folder: {name}', { name: activeProfile.name }), icon: 'folder', group: 'Actions', run: () => void bridge.openPath(activeProfile.dir) },
        ] as PaletteItem[])
      : []),
    { id: 'a:stopall', label: t('Stop All Terminals'), icon: 'stop', group: 'Actions', run: () => setDialog({ kind: 'stop-all' }) },
    {
      id: 'a:import', label: t('Import Terminal Configuration…'), icon: 'upload', group: 'Actions',
      run: () => void run(async () => {
        const n = await bridge.importProfiles();
        if (n) toast(`Imported ${n} terminal${n === 1 ? '' : 's'}`);
      }),
    },
    { id: 'a:export', label: t('Export All Terminal Configuration…'), icon: 'download', group: 'Actions', run: () => void run(() => bridge.exportProfiles()) },
    { id: 'a:appsettings', label: t('OmniTerminal Settings'), icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'app-settings' }) },
    { id: 'a:theme-dark', label: t('Theme: Dark'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'dark' }) },
    { id: 'a:theme-light', label: t('Theme: Light'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'light' }) },
    { id: 'a:theme-system', label: t('Theme: Use Windows setting'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'system' }) },
    { id: 'a:theme-midnight', label: t('Theme: Midnight'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'midnight' }) },
    { id: 'a:theme-nord', label: t('Theme: Nord'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'nord' }) },
    { id: 'a:lang-en', label: t('Language: English'), hint: 'English', icon: 'globe', group: 'Actions', run: () => setAppSetting({ language: 'en' }) },
    { id: 'a:lang-ar', label: t('Language: Arabic'), hint: 'العربية', icon: 'globe', group: 'Actions', run: () => setAppSetting({ language: 'ar' }) },
    { id: 'a:exit', label: t('Exit Completely (stop everything)'), icon: 'power', group: 'Actions', run: () => setDialog({ kind: 'exit' }) },
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
        shells={state.shells}
        titles={titles}
        instances={instanceMap}
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
            profile={activeInstance > 1 ? { ...activeProfile, name: `${activeProfile.name} ${activeInstance}` } : activeProfile}
            session={activeSession}
            shells={state.shells}
            status={uiStatus(activeSession, true)}
            onNew={() => setDialog({ kind: 'new' })}
            onReconnect={() => void reconnect(active)}
            onRestart={() => void restart(active)}
            onStop={() => void stop(active)}
            onSettings={() => setDialog({ kind: 'settings', id: activeProfile.id })}
            onStart={() => openTerminal(active, true)}
            programTitle={titles.get(active) ?? ''}
            admin={
              elevation?.managerElevated
                ? 'all'
                : activeSession?.elevated && activeSession.state === 'running'
                  ? 'session'
                  : supportsElevation(shellKind(active))
                    ? 'available'
                    : null
            }
            onRunAsAdmin={() => void runAsAdmin(active)}
            onRestartNormal={() => void restartAs(active, false)}
            stats={stats[active]}
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
              onQuickNew={(preset) => setDialog({ kind: 'new', preset })}
              adminLabel={
                elevation?.managerElevated
                  ? 'All terminals'
                  : elevation?.sudo === 'inline'
                    ? 'Ready'
                    : elevation?.sudo === 'unavailable'
                      ? 'Separate window'
                      : 'One-time setup'
              }
              stats={stats}
              titles={titles}
            />
          )}
          <div className={`terminal-stack ${active === 'dashboard' ? 'hidden' : ''}`}>
            {tabs.map((id) => {
              const p = profileMap.get(baseProfileId(id));
              if (!p) return null;
              return (
                <TerminalView
                  key={id}
                  sessionKey={id}
                  profile={p}
                  active={active === id}
                  autoStart={autoStart.current.get(id) ?? true}
                  onHostState={() => setHostTick((t) => t + 1)}
                  onActivity={onActivity}
                  onNeedsAdmin={(pid) => {
                    if (!elevation?.managerElevated && supportsElevation(shellKind(pid))) setAdminHint(pid);
                  }}
                  onAppShortcut={appShortcut}
                />
              );
            })}
            {adminHint && adminHint === active && (
              <div className="admin-hint" role="status">
                <Icon name="shield" size={15} />
                <span>{t('This looks like it needs administrator rights.')}</span>
                <button className="btn btn-sm btn-primary" onClick={() => void continueAsAdmin(adminHint)}>{t('Continue as Administrator')}</button>
                <button className="icon-btn small" title={t('Dismiss')} onClick={() => setAdminHint(null)}><Icon name="x" size={13} /></button>
              </div>
            )}
            {findOpen && activeHost && <FindBar key={activeProfile?.id} host={activeHost} onClose={() => setFindOpen(false)} />}
            {zoomMsg && active !== 'dashboard' && <div className="zoom-indicator">Font size {zoomMsg}</div>}
          </div>
        </div>
      </main>

      {paletteOpen && <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'new' && (
        <NewTerminalDialog state={state} preset={dialog.preset} onClose={() => setDialog(null)} onCreated={async (p: Profile) => { await refresh(); openTerminal(p.id, true); }} />
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
            toast(needsRestart ? t('Saved. Restart the terminal to apply shell/environment changes.') : t('Saved'));
          }}
        />
      )}
      {dialog?.kind === 'rename' && dialogProfile && (
        <PromptDialog
          title={t('Rename terminal')}
          label={t('Name')}
          initial={dialogProfile.name}
          confirmLabel={t('Rename')}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.renameProfile(dialogProfile.id, name);
            scheduleRefresh();
          }}
        />
      )}
      {dialog?.kind === 'delete' && dialogProfile && (
        <ConfirmDialog
          title={t('Delete "{name}"?', { name: dialogProfile.name })}
          danger
          confirmLabel={t('Delete terminal')}
          message={
            <>
              {t('The terminal will be stopped and removed from OmniTerminal.')}
              <div className="mono small muted" style={{ marginTop: 8 }}>{dialogProfile.dir}</div>
            </>
          }
          checkbox={{ label: t('Also delete its private data (tool logins, credentials, history, logs)'), defaultChecked: true }}
          onClose={() => setDialog(null)}
          onConfirm={async (deleteFiles) => {
            closeTab(dialogProfile.id);
            await run(() => api.deleteProfile(dialogProfile.id, deleteFiles), t('Deleted "{name}"', { name: dialogProfile.name }));
          }}
        />
      )}
      {dialog?.kind === 'app-settings' && (
        <AppSettingsDialog state={state} toast={toast} onClose={() => setDialog(null)} onSaved={() => void refresh()} onExitCompletely={() => setDialog({ kind: 'exit' })} />
      )}
      {dialog?.kind === 'enable-sudo' && (
        <ConfirmDialog
          title={t('Turn on Windows sudo?')}
          confirmLabel={t('Turn on (Windows will ask)')}
          message={
            <>
              {t('Administrator terminals use the sudo command built into Windows. Each time a terminal needs administrator rights, Windows asks you first.')}
              <p className="muted" style={{ marginTop: 10 }}>
                {t('This turns sudo on in inline mode, the same switch as Settings > System > For developers > Enable sudo. Windows asks for permission once to change it.')}
              </p>
            </>
          }
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const { id, then } = dialog;
            const r = await bridge.enableSudo();
            setElevation(r.status);
            if (r.status.sudo === 'inline') {
              toast(t('Windows sudo is on.'));
              setTimeout(() => void (then === 'restart' ? runAsAdmin(id) : continueAsAdmin(id)), 50);
            } else {
              toast(t('Sudo was not turned on (the permission prompt was cancelled or declined).'), 'error');
            }
          }}
        />
      )}
      {dialog?.kind === 'run-admin' && dialogProfile && (
        <ConfirmDialog
          title={t('Run "{name}" as Administrator?', { name: dialogProfile.name })}
          confirmLabel={t('Restart as Administrator')}
          message={
            <>
              {t('The terminal restarts with administrator rights. Windows asks for permission once. Programs running in it now will be stopped. It keeps the same folder, variables and accounts.')}
              <p className="muted" style={{ marginTop: 10 }}>
                {t('To keep what is running, use Continue as Administrator (in place) from the right-click menu.')}
              </p>
            </>
          }
          onClose={() => setDialog(null)}
          onConfirm={() => runAsAdmin(dialog.id, true)}
        />
      )}
      {dialog?.kind === 'no-sudo' && dialogProfile && (
        <ConfirmDialog
          title={t('Open an administrator window?')}
          confirmLabel={t('Open administrator PowerShell')}
          message={t("This version of Windows has no built-in sudo (it needs Windows 11 24H2 or later), so a terminal cannot switch to administrator rights in place. You can open a separate administrator PowerShell window in this terminal's folder instead. It will not have this terminal's private settings.")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await bridge.openElevatedWindow(dialogProfile.cwd);
          }}
        />
      )}
      {dialog?.kind === 'stop-all' && (
        <ConfirmDialog
          title={t('Stop all terminals?')}
          danger
          confirmLabel={runningCount === 1 ? t('Stop 1 terminal') : t('Stop {n} terminals', { n: runningCount })}
          message={t('Every running terminal and the programs inside them will be stopped. Their settings, logins and history are kept.')}
          onClose={() => setDialog(null)}
          onConfirm={() => stopAll()}
        />
      )}
      {dialog?.kind === 'exit' && (
        <ConfirmDialog
          title={t('Exit OmniTerminal completely?')}
          danger
          confirmLabel={t('Stop everything and exit')}
          message={
            runningCount > 0
              ? t('This stops {n} running terminals, and every program inside them, and shuts down the session manager.', { n: runningCount })
              : t('This shuts down the session manager.')
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
