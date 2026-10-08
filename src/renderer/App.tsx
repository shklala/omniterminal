import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, Profile, SessionInfo, Workspace } from '../shared/types';
import type { ResourceStats } from './util';
import { api, bridge, errorMessage, type DaemonStatus, type ElevationStatus, type UpdateStatus } from './api';
import { AccountsDialog } from './components/AccountsDialog';
import { AppSettingsDialog } from './components/AppSettingsDialog';
import { ContextMenu, Sidebar, TabBar, TopBar, type MenuItem } from './components/Chrome';
import { Dashboard } from './components/Dashboard';
import { FindBar } from './components/FindBar';
import { CommandPalette, type PaletteItem } from './components/CommandPalette';
import { ConfirmDialog, PromptDialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { NewTerminalDialog, ProfileSettingsDialog, type NewTerminalPreset } from './components/ProfileDialogs';
import { TerminalView, type TerminalCallbacks } from './components/TerminalView';
import { TerminalHost, hosts } from './terminal/terminalHost';
import { cx, supportsElevation, uiStatus } from './util';
import { baseProfileId, instanceNumber } from '../shared/sessionKey';
import { getLanguage, setLanguage, t } from './i18n';
import { setCustomThemes } from './themes';
import { actionForEvent, effectiveBindings } from './keybindings';

type DialogState =
  | { kind: 'new'; preset?: NewTerminalPreset }
  | { kind: 'settings'; id: string; tab?: 'general' | 'environment' | 'tools' | 'appearance' | 'advanced' }
  | { kind: 'rename'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'app-settings'; tab?: 'general' | 'window' | 'shortcuts' | 'snippets' | 'updates' }
  | { kind: 'exit' }
  | { kind: 'stop-all' }
  | { kind: 'enable-sudo'; id: string; then: 'continue' | 'restart' }
  | { kind: 'run-admin'; id: string }
  | { kind: 'no-sudo'; id: string }
  | { kind: 'accounts'; id: string }
  | { kind: 'save-workspace' }
  | { kind: 'delete-workspace'; workspace: Workspace }
  | { kind: 'install-update'; version: string }
  | null;

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

/** A tab split into panes. Tabs without an entry have one pane (the tab id itself). */
interface TabLayout {
  panes: string[];
  direction: 'row' | 'column';
  /** Flex weights, one per pane. */
  sizes: number[];
  /** Typing in one pane goes to all of them. */
  broadcast: boolean;
}

interface View {
  /** Tab ids: the session key of each tab's first pane. */
  tabs: string[];
  layouts: Record<string, TabLayout>;
}

const MAX_PANES = 4;
let toastId = 1;

/** Removes session keys from all tabs (re-keying a tab whose first pane went away). */
function removeKeys(v: View, keys: Set<string>): View & { renamed: Map<string, string> } {
  const tabs: string[] = [];
  const layouts: Record<string, TabLayout> = {};
  const renamed = new Map<string, string>();
  for (const tab of v.tabs) {
    const L = v.layouts[tab];
    const panes = L?.panes ?? [tab];
    const keep = panes.filter((k) => !keys.has(k));
    if (keep.length === 0) continue;
    const id = keep[0];
    if (id !== tab) renamed.set(tab, id);
    tabs.push(id);
    if (keep.length > 1 && L) layouts[id] = { ...L, panes: keep, sizes: keep.map((k) => L.sizes[panes.indexOf(k)] ?? 1) };
  }
  return { tabs, layouts, renamed };
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return t('{n} s', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('{m} min {s} s', { m, s: s % 60 });
  return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus>({ connected: false, pid: null, message: 'Starting session manager…' });
  const [view, setViewState] = useState<View>({ tabs: [], layouts: {} });
  const viewRef = useRef(view);
  const [focusMap, setFocusMap] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string>('dashboard');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [, setHostTick] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [palette, setPalette] = useState<'all' | 'snippets' | null>(null);
  const [elevation, setElevation] = useState<ElevationStatus | null>(null);
  const [adminHint, setAdminHint] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, ResourceStats>>({});
  const [zoomMsg, setZoomMsg] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const zoomTimer = useRef<number | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusRef = useRef(focusMap);
  focusRef.current = focusMap;
  const profilesRef = useRef<Profile[]>([]);
  /** Terminals the user is stopping on purpose (no "exited" toast for those). */
  const stopping = useRef(new Set<string>());
  const autoStart = useRef(new Map<string, boolean>());
  const initialized = useRef(false);
  const managerLost = useRef(false);
  const tabs = view.tabs;
  const layouts = view.layouts;

  /** Single source of truth for tabs/panes; the ref is updated immediately so chained actions see it. */
  const commitView = useCallback((next: View) => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  const panesOf = (tab: string, v: View = viewRef.current) => v.layouts[tab]?.panes ?? [tab];
  const tabOf = (key: string, v: View = viewRef.current) => v.tabs.find((tab) => panesOf(tab, v).includes(key));
  /** The focused pane of the active tab (the session the top bar and shortcuts act on). */
  const currentOf = (tab: string) => {
    if (tab === 'dashboard') return 'dashboard';
    const f = focusRef.current[tab];
    return f && panesOf(tab).includes(f) ? f : tab;
  };
  const currentKey = currentOf(active);
  const currentRef = useRef(currentKey);
  currentRef.current = currentKey;

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
        if (!stopping.current.delete(d.profileId) && d.profileId !== currentRef.current) {
          const name = profilesRef.current.find((p) => p.id === baseProfileId(d.profileId))?.name ?? 'A terminal';
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

  // ----- tray menu commands, notices and updates from the main process -----
  useEffect(() => {
    const offCmd = bridge.onCommand((name) => {
      if (name === 'new-terminal') setDialog({ kind: 'new' });
      else if (name === 'exit') setDialog({ kind: 'exit' });
    });
    const offNotice = bridge.onNotice((text) => toastRef.current(text, 'error'));
    void bridge.updateStatus().then(setUpdate).catch(() => undefined);
    const offUpdate = bridge.onUpdateStatus(setUpdate);
    return () => {
      offCmd();
      offNotice();
      offUpdate();
    };
  }, []);

  // ----- startup: reconnect to every running session, restoring split panes -----
  useEffect(() => {
    if (!state || initialized.current) return;
    initialized.current = true;
    void (async () => {
      const prefs = await api.getUiPrefs().catch(() => ({}) as Record<string, unknown>);
      const savedTabs = Array.isArray(prefs.openTabs) ? (prefs.openTabs as string[]) : [];
      const savedLayouts = (prefs.layouts && typeof prefs.layouts === 'object' ? prefs.layouts : {}) as Record<string, Partial<TabLayout>>;
      const running = state.sessions.filter((s) => s.state === 'running').map((s) => s.key);
      const used = new Set<string>();
      const next: View = { tabs: [], layouts: {} };
      for (const tab of savedTabs) {
        const L = savedLayouts[tab];
        const all = Array.isArray(L?.panes) ? L.panes : [tab];
        const panes = all.filter((k) => running.includes(k) && !used.has(k)).slice(0, MAX_PANES);
        if (panes.length === 0) continue;
        panes.forEach((k) => used.add(k));
        next.tabs.push(panes[0]);
        if (panes.length > 1) {
          const sizes = panes.length === all.length && Array.isArray(L?.sizes) && L.sizes.length === all.length ? L.sizes.map((x) => Math.max(0.2, Number(x) || 1)) : panes.map(() => 1);
          next.layouts[panes[0]] = { panes, direction: L?.direction === 'column' ? 'column' : 'row', sizes, broadcast: false };
        }
      }
      for (const k of running) if (!used.has(k)) next.tabs.push(k);
      [...used, ...running].forEach((id) => autoStart.current.set(id, false));
      commitView(next);
      const savedActive = typeof prefs.active === 'string' ? prefs.active : '';
      setActive(next.tabs.includes(savedActive) ? savedActive : next.tabs[0] ?? 'dashboard');
      const n = running.length;
      if (n) toast(n === 1 ? t('Reconnected to 1 running terminal') : t('Reconnected to {n} running terminals', { n }));
    })();
  }, [state, toast, commitView]);

  useEffect(() => {
    if (!initialized.current) return;
    void api.setUiPref('openTabs', tabs).catch(() => undefined);
    void api.setUiPref('layouts', layouts).catch(() => undefined);
    void api.setUiPref('active', active).catch(() => undefined);
  }, [tabs, layouts, active]);

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
  const bindings = useMemo(() => effectiveBindings(state?.settings.keybindings ?? {}), [state?.settings.keybindings]);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  TerminalHost.notifyAfterMs = (state?.settings.notifyAfterSeconds ?? 15) * 1000;

  // ----- tabs and panes -----
  /** Drops session keys from tabs; `dispose` also closes their terminal views (sessions keep running). */
  const dropKeys = useCallback(
    (keys: string[], dispose: boolean) => {
      if (keys.length === 0) return;
      if (dispose) {
        keys.forEach((k) => {
          hosts.get(k)?.dispose(true);
          hosts.delete(k);
        });
      }
      const before = viewRef.current;
      const r = removeKeys(before, new Set(keys));
      commitView({ tabs: r.tabs, layouts: r.layouts });
      setFocusMap((f) => {
        const out: Record<string, string> = {};
        for (const [tab, k] of Object.entries(f)) if (!keys.includes(k)) out[r.renamed.get(tab) ?? tab] = k;
        return out;
      });
      setActive((a) => {
        if (a === 'dashboard' || r.tabs.includes(a)) return a;
        const renamed = r.renamed.get(a);
        if (renamed) return renamed;
        const idx = before.tabs.indexOf(a);
        return r.tabs[Math.min(idx, r.tabs.length - 1)] ?? 'dashboard';
      });
    },
    [commitView],
  );

  // Drop panes whose terminal was deleted (e.g. from another window).
  useEffect(() => {
    if (!state) return;
    const gone = viewRef.current.tabs.flatMap((tab) => panesOf(tab)).filter((k) => !profileMap.has(baseProfileId(k)));
    if (gone.length) dropKeys(gone, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, profileMap, dropKeys]);

  const focusPane = (key: string) => {
    const tab = tabOf(key);
    if (!tab) return;
    if (focusRef.current[tab] !== key) setFocusMap((f) => ({ ...f, [tab]: key }));
  };

  const openTerminal = useCallback(
    (id: string, start = true) => {
      const tab = tabOf(id);
      if (!tab) {
        autoStart.current.set(id, start);
        const v = viewRef.current;
        commitView({ tabs: [...v.tabs, id], layouts: v.layouts });
        setActive(id);
        return;
      }
      const h = hosts.get(id);
      if (h && start && (h.state === 'exited' || h.state === 'error')) void h.restart();
      else if (h && h.state === 'detached') void h.connect(start);
      setActive(tab);
      setFocusMap((f) => ({ ...f, [tab]: id }));
      requestAnimationFrame(() => hosts.get(id)?.focus());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitView],
  );

  const closeTab = useCallback((tab: string) => dropKeys(panesOf(tab), true), [dropKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Ctrl+Shift+W: closes the focused pane of a split tab, or the whole tab. */
  const closeCurrent = () => {
    const tab = activeRef.current;
    if (tab === 'dashboard') return false;
    const panes = panesOf(tab);
    if (panes.length > 1) dropKeys([currentOf(tab)], true);
    else closeTab(tab);
    return true;
  };

  /** Puts a terminal into the active tab as a new pane (moving it out of another tab if needed). */
  const splitWith = (key: string, direction: 'row' | 'column') => {
    const tab = activeRef.current;
    if (tab === 'dashboard') return;
    const panes = panesOf(tab);
    if (panes.includes(key)) return focusPane(key);
    if (panes.length >= MAX_PANES) return toast(t('A tab can hold up to {n} panes.', { n: MAX_PANES }), 'error');
    const base = removeKeys(viewRef.current, new Set([key]));
    const L = base.layouts[tab] ?? { panes: [tab], direction, sizes: [1], broadcast: false };
    const nextPanes = [...L.panes, key];
    autoStart.current.set(key, true);
    commitView({ tabs: base.tabs, layouts: { ...base.layouts, [tab]: { ...L, panes: nextPanes, direction, sizes: nextPanes.map(() => 1) } } });
    setFocusMap((f) => ({ ...f, [tab]: key }));
  };

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

  /** "Split right/down": a new shell of the focused terminal, next to it. */
  const splitNew = (direction: 'row' | 'column') => {
    const key = currentRef.current;
    if (key === 'dashboard') return;
    if (panesOf(activeRef.current).length >= MAX_PANES) return toast(t('A tab can hold up to {n} panes.', { n: MAX_PANES }), 'error');
    void run(async () => {
      const info = await bridge.invoke<SessionInfo>('sessions.newInstance', { profileId: baseProfileId(key) });
      await refresh();
      splitWith(info.key, direction);
    });
  };

  const cyclePane = (delta: number) => {
    const tab = activeRef.current;
    const panes = tab === 'dashboard' ? [] : panesOf(tab);
    if (panes.length < 2) return false;
    const i = panes.indexOf(currentOf(tab));
    const next = panes[(i + delta + panes.length) % panes.length];
    setFocusMap((f) => ({ ...f, [tab]: next }));
    hosts.get(next)?.focus();
    return true;
  };

  const toggleBroadcast = () => {
    const tab = activeRef.current;
    const v = viewRef.current;
    const L = v.layouts[tab];
    if (!L || L.panes.length < 2) {
      toast(t('Split this tab first: broadcast types into every pane of a tab.'));
      return;
    }
    commitView({ tabs: v.tabs, layouts: { ...v.layouts, [tab]: { ...L, broadcast: !L.broadcast } } });
  };

  /** Divider drag: moves weight between the two panes next to it. */
  const startResize = (tab: string, i: number, e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const group = e.currentTarget.parentElement;
    const L = viewRef.current.layouts[tab];
    if (!group || !L) return;
    const rect = group.getBoundingClientRect();
    const total = L.sizes.reduce((a, b) => a + b, 0);
    const span = L.direction === 'row' ? rect.width : rect.height;
    const start = L.direction === 'row' ? e.clientX : e.clientY;
    const [a0, b0] = [L.sizes[i], L.sizes[i + 1]];
    const rtl = document.documentElement.dir === 'rtl' && L.direction === 'row';
    const move = (ev: MouseEvent) => {
      const px = (L.direction === 'row' ? ev.clientX : ev.clientY) - start;
      const d = ((rtl ? -px : px) / span) * total;
      const a = Math.max(0.15 * total / L.panes.length, a0 + d);
      const b = Math.max(0.15 * total / L.panes.length, b0 - d);
      if (a + b > a0 + b0 + 0.001) return;
      const v = viewRef.current;
      const cur = v.layouts[tab];
      if (!cur) return;
      const sizes = [...cur.sizes];
      sizes[i] = a;
      sizes[i + 1] = b;
      commitView({ tabs: v.tabs, layouts: { ...v.layouts, [tab]: { ...cur, sizes } } });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove(`resizing-${L.direction}`);
    };
    document.body.classList.add(`resizing-${L.direction}`);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const stop = (id: string) => {
    stopping.current.add(id);
    return run(() => api.stop(id));
  };
  const stopAll = () =>
    run(async () => {
      const ids = (state?.sessions ?? []).filter((s) => s.state === 'running').map((s) => s.key);
      ids.forEach((id) => stopping.current.add(id));
      await Promise.all(ids.map((id) => api.stop(id)));
    }, t('Stopped all terminals'));

  const terminalName = (key: string) => {
    const p = profilesRef.current.find((x) => x.id === baseProfileId(key));
    const n = instanceNumber(key);
    return p ? (n > 1 ? `${p.name} ${n}` : p.name) : 'Terminal';
  };

  /** Shown on screen right now (its tab is active and the window has focus). */
  const onScreen = (key: string) => activeRef.current !== 'dashboard' && panesOf(activeRef.current).includes(key) && document.hasFocus();

  const notify = (title: string, body: string, key: string) => {
    void bridge.attention();
    if (!('Notification' in window)) return;
    const n = new Notification(title, { body, silent: false });
    n.onclick = () => {
      void bridge.focusWindow();
      openTerminal(key, false);
    };
  };

  // Background tab printed output / rang the bell. Bells flash the taskbar and notify when unfocused.
  const onActivity = useCallback((key: string, kind: 'none' | 'output' | 'bell') => {
    setHostTick((t) => t + 1);
    if (kind !== 'bell' || document.hasFocus()) return;
    notify(t('{name} needs attention', { name: terminalName(key) }), hosts.get(key)?.title || t('The program rang the terminal bell.'), key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!status) return toast(t('Could not check administrator support.'), 'error');
    if (status.managerElevated) return toast(t('This terminal already has administrator rights.'));
    if (!supportsElevation(shellKind(id))) {
      return toast(t('Continue as Administrator works in PowerShell, Command Prompt and Git Bash terminals.'), 'error');
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
    if (!status) return toast(t('Could not check administrator support.'), 'error');
    if (status.managerElevated) return toast(t('OmniTerminal already runs as administrator, so every terminal has administrator rights.'));
    if (!supportsElevation(shellKind(id))) {
      return toast(t('Run as Administrator works in PowerShell, Command Prompt and Git Bash terminals.'), 'error');
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
      openTerminal(id, false);
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
    const h = hosts.get(currentRef.current);
    if (!h) return false;
    h.zoom(delta);
    setZoomMsg(`${h.term.options.fontSize}px`);
    if (zoomTimer.current) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => setZoomMsg(null), 900);
    return true;
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
      toast(t('Created "{name}" with the same settings. Logins and secrets were not copied, so sign in there again.', { name: p.name }));
    });

  /** "Open another": a new shell of the same terminal, sharing its accounts and variables. */
  const openAnother = (id: string) =>
    run(async () => {
      const info = await bridge.invoke<SessionInfo>('sessions.newInstance', { profileId: baseProfileId(id) });
      await refresh();
      openTerminal(info.key, false);
    });

  // ----- snippets -----
  const runSnippet = (command: string, enter: boolean) => {
    const key = currentRef.current;
    const h = key === 'dashboard' ? undefined : hosts.get(key);
    if (!h || h.state !== 'attached') return toast(t('Open a running terminal first, then pick the snippet.'), 'error');
    const text = command.replace(/\r?\n/g, '\r') + (enter ? '\r' : '');
    h.sendInput(text);
    mirrorInput(key, text);
    h.focus();
  };

  /** Broadcast: what is typed in one pane also goes to the other panes of its tab. */
  const mirrorInput = (key: string, data: string) => {
    const tab = tabOf(key);
    const L = tab ? viewRef.current.layouts[tab] : undefined;
    if (!L?.broadcast) return;
    for (const k of L.panes) if (k !== key) hosts.get(k)?.sendInput(data);
  };

  // ----- workspaces -----
  const workspaceFromTabs = (): Workspace['tabs'] =>
    viewRef.current.tabs.map((tab) => ({
      direction: viewRef.current.layouts[tab]?.direction ?? 'row',
      panes: panesOf(tab).map((k) => ({ profileId: baseProfileId(k), another: instanceNumber(k) > 1 })),
    }));

  const openWorkspace = (ws: Workspace) =>
    run(async () => {
      const groups: { keys: string[]; direction: 'row' | 'column' }[] = [];
      for (const wt of ws.tabs) {
        const keys: string[] = [];
        for (const pn of wt.panes) {
          if (!profileMap.has(pn.profileId)) continue;
          if (pn.another) keys.push((await bridge.invoke<SessionInfo>('sessions.newInstance', { profileId: pn.profileId })).key);
          else if (!groups.some((g) => g.keys.includes(pn.profileId)) && !keys.includes(pn.profileId)) keys.push(pn.profileId);
        }
        if (keys.length) groups.push({ keys: keys.slice(0, MAX_PANES), direction: wt.direction });
      }
      if (groups.length === 0) throw new Error(t('The terminals in this workspace no longer exist.'));
      await refresh();
      const all = groups.flatMap((g) => g.keys);
      const base = removeKeys(viewRef.current, new Set(all));
      const next: View = { tabs: [...base.tabs], layouts: { ...base.layouts } };
      for (const g of groups) {
        next.tabs.push(g.keys[0]);
        if (g.keys.length > 1) next.layouts[g.keys[0]] = { panes: g.keys, direction: g.direction, sizes: g.keys.map(() => 1), broadcast: false };
      }
      for (const k of all) {
        autoStart.current.set(k, true);
        const h = hosts.get(k);
        if (h && (h.state === 'exited' || h.state === 'error')) void h.restart();
      }
      commitView(next);
      setActive(groups[0].keys[0]);
    }, t('Opened "{name}"', { name: ws.name }));

  // ----- "command finished" notifications -----
  const onCommandDone = (key: string, ms: number) => {
    if (onScreen(key)) return;
    hosts.get(key)?.flagAttention();
    notify(t('{name}: command finished', { name: terminalName(key) }), t('It took {time}.', { time: fmtDuration(ms) }), key);
  };

  const callbacks: TerminalCallbacks = {
    onHostState: () => setHostTick((x) => x + 1),
    onActivity,
    onNeedsAdmin: (key) => {
      if (!elevation?.managerElevated && supportsElevation(shellKind(key))) setAdminHint(key);
    },
    onAppShortcut: (e) => appShortcut(e),
    onFocus: focusPane,
    onUserInput: mirrorInput,
    onCommandDone,
  };

  const menuItems = (key: string): (MenuItem | 'sep')[] => {
    const id = baseProfileId(key);
    const s = sessionMap.get(key);
    const running = s?.state === 'running';
    const open = !!tabOf(key);
    const canSplitHere = active !== 'dashboard' && !panesOf(active).includes(key) && panesOf(active).length < MAX_PANES;
    return [
      { label: t(running ? (open ? 'Show' : 'Reconnect') : 'Open'), icon: running ? 'link' : 'play', onClick: () => openTerminal(key, true) },
      ...(canSplitHere ? [{ label: t('Open next to the current tab'), icon: 'split', onClick: () => splitWith(key, 'row') }] : []),
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
      { label: t('Accounts in this terminal…'), icon: 'user', onClick: () => setDialog({ kind: 'accounts', id }) },
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

  // ----- keyboard shortcuts (customizable; also routed from inside xterm) -----
  const handlers = useRef<Record<string, () => boolean | void>>({});
  const cur = () => currentRef.current;
  const onTerminal = (fn: (key: string) => void) => () => {
    if (cur() === 'dashboard') return false;
    fn(cur());
  };
  handlers.current = {
    'app.palette': () => setPalette('all'),
    'terminal.new': () => setDialog({ kind: 'new' }),
    'terminal.another': onTerminal((k) => void openAnother(k)),
    'tab.close': () => closeCurrent(),
    'tab.next': () => cycleTab(1),
    'tab.prev': () => cycleTab(-1),
    'app.dashboard': () => setActive('dashboard'),
    'terminal.find': onTerminal(() => setFindOpen(true)),
    'pane.splitRight': onTerminal(() => splitNew('row')),
    'pane.splitDown': onTerminal(() => splitNew('column')),
    'pane.focusNext': () => cyclePane(1),
    'pane.focusPrev': () => cyclePane(-1),
    'pane.broadcast': onTerminal(() => toggleBroadcast()),
    'app.snippets': () => setPalette('snippets'),
    'terminal.accounts': onTerminal((k) => setDialog({ kind: 'accounts', id: baseProfileId(k) })),
    'app.settings': () => setDialog({ kind: 'app-settings' }),
    'zoom.in': () => zoom(1),
    'zoom.out': () => zoom(-1),
    'zoom.reset': () => zoom('reset'),
  };
  function cycleTab(delta: number) {
    const order = ['dashboard', ...viewRef.current.tabs];
    const i = order.indexOf(activeRef.current);
    setActive(order[(i + delta + order.length) % order.length]);
  }

  const appShortcut = useCallback((e: KeyboardEvent): boolean => {
    // Ctrl+Alt+1..9 switches to tab N (Windows Terminal convention).
    if (e.ctrlKey && e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      const id = viewRef.current.tabs[Number(e.code.slice(5)) - 1];
      if (!id) return false;
      setActive(id);
      e.preventDefault();
      return true;
    }
    const action = actionForEvent(e, bindingsRef.current);
    if (!action) return false;
    if (handlers.current[action]?.() === false) return false;
    e.preventDefault();
    return true;
  }, []);

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
    const p = currentKey !== 'dashboard' ? profilesRef.current.find((x) => x.id === baseProfileId(currentKey)) : undefined;
    const title = p ? hosts.get(currentKey)?.title : '';
    document.title = p ? `${title ? `${title} - ` : ''}${p.name} - OmniTerminal` : 'OmniTerminal';
  });

  useEffect(() => setFindOpen(false), [currentKey]);

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
    const timer = window.setInterval(tick, 5000);
    window.addEventListener('focus', tick);
    return () => {
      stop = true;
      window.clearInterval(timer);
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

  const activeProfile = currentKey !== 'dashboard' ? profileMap.get(baseProfileId(currentKey)) : undefined;
  const activeSession = activeProfile ? sessionMap.get(currentKey) : undefined;
  const activeInstance = instanceNumber(currentKey);
  const activePanes = active === 'dashboard' ? [] : panesOf(active, view);
  const activeLayout = active === 'dashboard' ? undefined : layouts[active];
  const dialogProfile = dialog && 'id' in dialog ? profileMap.get(baseProfileId(dialog.id)) : undefined;
  const runningCount = state.sessions.filter((s) => s.state === 'running').length;
  const activity = new Map([...hosts].map(([id, h]) => [id, h.activity] as [string, typeof h.activity]));
  // Program titles, minus the terminal's own name (PowerShell titles itself after the profile).
  const titles = new Map([...hosts].map(([id, h]) => [id, h.title === profileMap.get(baseProfileId(id))?.name ? '' : h.title] as [string, string]));
  const activeHost = activeProfile ? hosts.get(currentKey) : undefined;
  // A tab shows activity if any of its panes has some.
  const tabActivity = new Map(tabs.map((tab) => {
    const kinds = panesOf(tab, view).map((k) => activity.get(k) ?? 'none');
    return [tab, kinds.includes('bell') ? 'bell' : kinds.includes('output') ? 'output' : 'none'] as [string, 'none' | 'output' | 'bell'];
  }));
  const extraPanes = new Map(tabs.map((tab) => [tab, panesOf(tab, view).length - 1]));
  const snippetsHere = state.snippets.filter((s) => !s.profileId || (activeProfile && s.profileId === activeProfile.id));

  const snippetItems: PaletteItem[] = snippetsHere.map((s) => ({
    id: `s:${s.id}`,
    label: t('Run snippet: {name}', { name: s.name }),
    hint: s.command.length > 48 ? `${s.command.slice(0, 47)}…` : s.command,
    icon: 'snippet',
    group: 'Snippets',
    run: () => runSnippet(s.command, s.run),
  }));

  const paletteItems: PaletteItem[] = [
    ...profiles.map((p): PaletteItem => {
      const st = uiStatus(sessionMap.get(p.id), !!tabOf(p.id, view));
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
    ...snippetItems,
    ...state.workspaces.map((w): PaletteItem => ({ id: `w:${w.id}`, label: t('Open workspace: {name}', { name: w.name }), icon: 'grid', group: 'Workspaces', run: () => void openWorkspace(w) })),
    { id: 'a:new', label: t('New Terminal'), hint: bindings.get('terminal.new'), icon: 'plus', group: 'Actions', run: () => setDialog({ kind: 'new' }) },
    { id: 'a:all', label: t('Show All Terminals'), hint: bindings.get('app.dashboard'), icon: 'grid', group: 'Actions', run: () => setActive('dashboard') },
    ...(tabs.length ? [{ id: 'a:savews', label: t('Save open tabs as a workspace…'), icon: 'grid', group: 'Workspaces' as const, run: () => setDialog({ kind: 'save-workspace' }) }] : []),
    ...(activeProfile
      ? ([
          { id: 'a:splitr', label: t('Split right'), hint: bindings.get('pane.splitRight'), icon: 'split', group: 'Actions', run: () => splitNew('row') },
          { id: 'a:splitd', label: t('Split down'), hint: bindings.get('pane.splitDown'), icon: 'splitDown', group: 'Actions', run: () => splitNew('column') },
          ...profiles
            .filter((p) => !activePanes.includes(p.id))
            .map((p) => ({ id: `a:splitwith:${p.id}`, label: t('Split with {name}', { name: p.name }), icon: 'split', color: p.color, group: 'Actions' as const, run: () => splitWith(p.id, 'row') })),
          ...(activePanes.length > 1
            ? [{ id: 'a:broadcast', label: activeLayout?.broadcast ? t('Stop typing into all panes') : t('Type into all panes of this tab'), hint: bindings.get('pane.broadcast'), icon: 'broadcast', group: 'Actions' as const, run: toggleBroadcast }]
            : []),
          { id: 'a:accounts', label: t('Accounts in {name}', { name: activeProfile.name }), hint: bindings.get('terminal.accounts'), icon: 'user', group: 'Actions', run: () => setDialog({ kind: 'accounts', id: activeProfile.id }) },
          { id: 'a:another', label: t('Open another {name}', { name: activeProfile.name }), hint: bindings.get('terminal.another'), icon: 'plus', group: 'Actions', run: () => void openAnother(currentKey) },
          { id: 'a:restart', label: t('Restart {name}', { name: activeProfile.name }), icon: 'restart', group: 'Actions', run: () => void restart(currentKey) },
          { id: 'a:stop', label: t('Stop {name}', { name: activeProfile.name }), icon: 'stop', group: 'Actions', run: () => void stop(currentKey) },
          { id: 'a:settings', label: t('Settings: {name}', { name: activeProfile.name }), icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'settings', id: activeProfile.id }) },
          { id: 'a:dup', label: t('Duplicate {name} (no credentials)', { name: activeProfile.name }), icon: 'copy', group: 'Actions', run: () => void duplicate(activeProfile.id) },
          ...(supportsElevation(shellKind(activeProfile.id)) && !elevation?.managerElevated
            ? [
                { id: 'a:runadmin', label: t('Run {name} as Administrator', { name: activeProfile.name }), icon: 'shield', group: 'Actions' as const, run: () => void runAsAdmin(currentKey) },
                { id: 'a:admin', label: t('Continue {name} as Administrator (in place)', { name: activeProfile.name }), icon: 'shield', group: 'Actions' as const, run: () => void continueAsAdmin(currentKey) },
              ]
            : []),
          { id: 'a:find', label: t('Find in Terminal'), hint: bindings.get('terminal.find'), icon: 'search', group: 'Actions', run: () => setFindOpen(true) },
          { id: 'a:folder', label: t('Open Profile Folder: {name}', { name: activeProfile.name }), icon: 'folder', group: 'Actions', run: () => void bridge.openPath(activeProfile.dir) },
        ] as PaletteItem[])
      : []),
    { id: 'a:snippets', label: t('Manage snippets…'), icon: 'snippet', group: 'Snippets', run: () => setDialog({ kind: 'app-settings', tab: 'snippets' }) },
    { id: 'a:stopall', label: t('Stop All Terminals'), icon: 'stop', group: 'Actions', run: () => setDialog({ kind: 'stop-all' }) },
    {
      id: 'a:import', label: t('Import Terminal Configuration…'), icon: 'upload', group: 'Actions',
      run: () => void run(async () => {
        const n = await bridge.importProfiles();
        if (n) toast(n === 1 ? t('Imported 1 terminal') : t('Imported {n} terminals', { n }));
      }),
    },
    { id: 'a:export', label: t('Export All Terminal Configuration…'), icon: 'download', group: 'Actions', run: () => void run(() => bridge.exportProfiles()) },
    { id: 'a:appsettings', label: t('OmniTerminal Settings'), hint: bindings.get('app.settings'), icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'app-settings' }) },
    { id: 'a:shortcuts', label: t('Keyboard shortcuts…'), icon: 'settings', group: 'Actions', run: () => setDialog({ kind: 'app-settings', tab: 'shortcuts' }) },
    { id: 'a:updates', label: t('Check for updates'), icon: 'download', group: 'Actions', run: () => setDialog({ kind: 'app-settings', tab: 'updates' }) },
    { id: 'a:theme-dark', label: t('Theme: Dark'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'dark' }) },
    { id: 'a:theme-light', label: t('Theme: Light'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'light' }) },
    { id: 'a:theme-system', label: t('Theme: Use Windows setting'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'system' }) },
    { id: 'a:theme-midnight', label: t('Theme: Midnight'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'midnight' }) },
    { id: 'a:theme-nord', label: t('Theme: Nord'), icon: 'settings', group: 'Actions', run: () => setAppSetting({ uiTheme: 'nord' }) },
    ...[
      ['en', 'English'], ['ar', 'العربية'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['zh', '简体中文'],
    ].map(([id, native]) => ({ id: `a:lang-${id}`, label: `${t('Language')}: ${native}`, hint: native, icon: 'globe', group: 'Actions' as const, run: () => setAppSetting({ language: id }) })),
    { id: 'a:exit', label: t('Exit Completely (stop everything)'), icon: 'power', group: 'Actions', run: () => setDialog({ kind: 'exit' }) },
  ];

  const moreItems: (MenuItem | 'sep')[] = activeProfile
    ? [
        { label: t('Accounts in this terminal…'), icon: 'user', onClick: () => setDialog({ kind: 'accounts', id: activeProfile.id }) },
        'sep',
        { label: t('Split right'), icon: 'split', disabled: activePanes.length >= MAX_PANES, onClick: () => splitNew('row') },
        { label: t('Split down'), icon: 'splitDown', disabled: activePanes.length >= MAX_PANES, onClick: () => splitNew('column') },
        ...(activePanes.length > 1
          ? [
              { label: activeLayout?.broadcast ? t('Stop typing into all panes') : t('Type into all panes of this tab'), icon: 'broadcast', onClick: toggleBroadcast },
              { label: t('Close this pane (keeps running)'), icon: 'x', onClick: () => dropKeys([currentKey], true) },
            ]
          : []),
        'sep',
        { label: t('Run a snippet…'), icon: 'snippet', onClick: () => setPalette('snippets') },
        { label: t('Open another'), icon: 'plus', onClick: () => void openAnother(currentKey) },
        { label: t('Find in output'), icon: 'search', onClick: () => setFindOpen(true) },
        { label: t('Open profile folder'), icon: 'folder', onClick: () => void bridge.openPath(activeProfile.dir) },
      ]
    : [];

  const showUpdate = update?.state === 'ready' && !updateDismissed;

  return (
    <div className="app">
      <Sidebar
        profiles={profiles}
        sessions={sessionMap}
        openTabs={tabs.flatMap((tab) => panesOf(tab, view))}
        active={currentKey}
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
          activity={tabActivity}
          titles={titles}
          panes={extraPanes}
        />
        {showUpdate && (
          <div className="update-banner" role="status">
            <Icon name="download" size={14} />
            <span>{t('OmniTerminal {v} is ready to install.', { v: update?.version ?? '' })}</span>
            <button className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'install-update', version: update?.version ?? '' })}>{t('Restart and install')}</button>
            <button className="icon-btn small" title={t('Later')} onClick={() => setUpdateDismissed(true)}><Icon name="x" size={13} /></button>
          </div>
        )}
        {activeProfile && (
          <TopBar
            profile={activeInstance > 1 ? { ...activeProfile, name: `${activeProfile.name} ${activeInstance}` } : activeProfile}
            session={activeSession}
            shells={state.shells}
            status={uiStatus(activeSession, true)}
            onNew={() => setDialog({ kind: 'new' })}
            onReconnect={() => void reconnect(currentKey)}
            onRestart={() => void restart(currentKey)}
            onStop={() => void stop(currentKey)}
            onSettings={() => setDialog({ kind: 'settings', id: activeProfile.id })}
            onStart={() => openTerminal(currentKey, true)}
            programTitle={titles.get(currentKey) ?? ''}
            admin={
              elevation?.managerElevated
                ? 'all'
                : activeSession?.elevated && activeSession.state === 'running'
                  ? 'session'
                  : supportsElevation(shellKind(currentKey))
                    ? 'available'
                    : null
            }
            onRunAsAdmin={() => void runAsAdmin(currentKey)}
            onRestartNormal={() => void restartAs(currentKey, false)}
            stats={stats[currentKey]}
            more={moreItems}
            broadcasting={!!activeLayout?.broadcast}
          />
        )}
        <div className="content">
          {active === 'dashboard' && (
            <Dashboard
              profiles={profiles}
              sessions={sessionMap}
              shells={state.shells}
              openTabs={tabs.flatMap((tab) => panesOf(tab, view))}
              onOpen={(id) => openTerminal(id, true)}
              onStop={(id) => void stop(id)}
              onNew={() => setDialog({ kind: 'new' })}
              onMenu={(id, x, y) => setMenu({ id, x, y })}
              onImport={() => void run(async () => {
                const n = await bridge.importProfiles();
                if (n) toast(n === 1 ? t('Imported 1 terminal (configuration only)') : t('Imported {n} terminals (configuration only)', { n }));
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
              workspaces={state.workspaces}
              canSaveWorkspace={tabs.length > 0}
              onOpenWorkspace={(w) => void openWorkspace(w)}
              onSaveWorkspace={() => setDialog({ kind: 'save-workspace' })}
              onDeleteWorkspace={(w) => setDialog({ kind: 'delete-workspace', workspace: w })}
              bindings={bindings}
            />
          )}
          <div className={`terminal-stack ${active === 'dashboard' ? 'hidden' : ''}`}>
            {tabs.map((tab) => {
              const panes = panesOf(tab, view);
              const L = layouts[tab];
              const split = panes.length > 1;
              const focused = currentOf(tab);
              return (
                <div
                  key={tab}
                  className={cx('pane-group', active === tab ? 'active' : 'inactive', L?.direction === 'column' && 'column', split && 'split', L?.broadcast && 'broadcast')}
                >
                  {panes.map((key, i) => {
                    const p = profileMap.get(baseProfileId(key));
                    if (!p) return null;
                    const n = instanceNumber(key);
                    return (
                      <Fragment key={key}>
                        {i > 0 && <div className="pane-divider" onMouseDown={(e) => startResize(tab, i - 1, e)} role="separator" aria-orientation={L?.direction === 'column' ? 'horizontal' : 'vertical'} />}
                        <div className={cx('pane', split && focused === key && 'focused')} style={{ flexGrow: L?.sizes[i] ?? 1 }}>
                          {split && (
                            <div className="pane-head" onMouseDown={() => { focusPane(key); hosts.get(key)?.focus(); }}>
                              <span className="pane-dot" style={{ background: p.color }} />
                              <span className="pane-name">{n > 1 ? `${p.name} ${n}` : p.name}</span>
                              {titles.get(key) && <span className="pane-title">{titles.get(key)}</span>}
                              {L?.broadcast && <Icon name="broadcast" size={11} className="pane-broadcast" />}
                              <button className="icon-btn small" title={t('Close this pane (keeps running)')} onMouseDown={(e) => e.stopPropagation()} onClick={() => dropKeys([key], true)}>
                                <Icon name="x" size={11} />
                              </button>
                            </div>
                          )}
                          <div className="pane-body">
                            <TerminalView
                              sessionKey={key}
                              profile={p}
                              active={active === tab}
                              focused={focused === key}
                              autoStart={autoStart.current.get(key) ?? true}
                              callbacks={callbacks}
                            />
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}
                </div>
              );
            })}
            {adminHint && adminHint === currentKey && (
              <div className="admin-hint" role="status">
                <Icon name="shield" size={15} />
                <span>{t('This looks like it needs administrator rights.')}</span>
                <button className="btn btn-sm btn-primary" onClick={() => void continueAsAdmin(adminHint)}>{t('Continue as Administrator')}</button>
                <button className="icon-btn small" title={t('Dismiss')} onClick={() => setAdminHint(null)}><Icon name="x" size={13} /></button>
              </div>
            )}
            {findOpen && activeHost && <FindBar key={currentKey} host={activeHost} onClose={() => setFindOpen(false)} />}
            {zoomMsg && active !== 'dashboard' && <div className="zoom-indicator">{t('Font size {size}', { size: zoomMsg })}</div>}
          </div>
        </div>
      </main>

      {palette === 'all' && <CommandPalette items={paletteItems} onClose={() => setPalette(null)} />}
      {palette === 'snippets' && (
        <CommandPalette
          items={[...snippetItems, { id: 'a:snippets', label: t('Manage snippets…'), icon: 'snippet', group: 'Snippets', run: () => setDialog({ kind: 'app-settings', tab: 'snippets' }) }]}
          placeholder={t('Run a snippet in the current terminal…')}
          onClose={() => setPalette(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'new' && (
        <NewTerminalDialog state={state} preset={dialog.preset} onClose={() => setDialog(null)} onCreated={async (p: Profile) => { await refresh(); openTerminal(p.id, true); }} />
      )}
      {dialog?.kind === 'settings' && dialogProfile && (
        <ProfileSettingsDialog
          state={state}
          profile={dialogProfile}
          session={sessionMap.get(dialogProfile.id)}
          initialTab={dialog.tab}
          onClose={() => setDialog(null)}
          onSaved={(p, needsRestart) => {
            void refresh();
            for (const [key, h] of hosts) if (baseProfileId(key) === p.id) h.applyAppearance(p.appearance);
            toast(needsRestart ? t('Saved. Restart the terminal to apply shell/environment changes.') : t('Saved'));
          }}
        />
      )}
      {dialog?.kind === 'accounts' && dialogProfile && (
        <AccountsDialog profile={dialogProfile} onClose={() => setDialog(null)} onOpenTools={() => setDialog({ kind: 'settings', id: dialogProfile.id, tab: 'tools' })} />
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
      {dialog?.kind === 'save-workspace' && (
        <PromptDialog
          title={t('Save open tabs as a workspace')}
          label={t('Workspace name')}
          initial=""
          confirmLabel={t('Save workspace')}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await bridge.invoke('workspaces.save', { workspace: { name, tabs: workspaceFromTabs() } });
            await refresh();
            toast(t('Saved workspace "{name}". Open it from All Terminals or the command palette.', { name }));
          }}
        />
      )}
      {dialog?.kind === 'delete-workspace' && (
        <ConfirmDialog
          title={t('Delete workspace "{name}"?', { name: dialog.workspace.name })}
          danger
          confirmLabel={t('Delete workspace')}
          message={t('Only the saved layout is deleted. The terminals in it are not changed.')}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await run(() => bridge.invoke('workspaces.delete', { id: dialog.workspace.id }));
          }}
        />
      )}
      {dialog?.kind === 'install-update' && (
        <ConfirmDialog
          title={t('Install OmniTerminal {v}?', { v: dialog.version })}
          confirmLabel={t('Restart and install')}
          message={
            state.settings.restoreAfterRestart
              ? t('OmniTerminal closes, installs the update and opens again. Running terminals are saved first and reopen afterwards with their earlier output; programs inside them start fresh.')
              : t('OmniTerminal closes, installs the update and opens again. "Reopen terminals after a restart" is off, so running terminals and the programs in them will stop.')
          }
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await run(() => bridge.installUpdate());
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
            dropKeys(viewRef.current.tabs.flatMap((tab) => panesOf(tab)).filter((k) => baseProfileId(k) === dialogProfile.id), true);
            await run(() => api.deleteProfile(dialogProfile.id, deleteFiles), t('Deleted "{name}"', { name: dialogProfile.name }));
          }}
        />
      )}
      {dialog?.kind === 'app-settings' && (
        <AppSettingsDialog state={state} initialTab={dialog.tab} toast={toast} onClose={() => setDialog(null)} onSaved={() => void refresh()} onExitCompletely={() => setDialog({ kind: 'exit' })} />
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
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.tone}`}>
            <Icon name={x.tone === 'error' ? 'alert' : 'check'} size={14} />
            <span>{x.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
