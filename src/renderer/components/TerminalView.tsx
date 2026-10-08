import { useEffect, useRef } from 'react';
import type { Profile } from '../../shared/types';
import { TerminalHost, hosts } from '../terminal/terminalHost';

export interface TerminalCallbacks {
  onHostState: () => void;
  onActivity: (sessionKey: string, kind: 'none' | 'output' | 'bell') => void;
  onNeedsAdmin: (sessionKey: string) => void;
  onAppShortcut: (e: KeyboardEvent) => boolean;
  onFocus: (sessionKey: string) => void;
  onUserInput: (sessionKey: string, data: string) => void;
  onCommandDone: (sessionKey: string, durationMs: number) => void;
}

/**
 * React shell around a long-lived TerminalHost. All tabs stay mounted (hidden when inactive),
 * so switching tabs never loses terminal state.
 */
export function TerminalView({
  sessionKey,
  profile,
  active,
  focused,
  autoStart,
  callbacks,
}: {
  /** Session key: the profile id, or "<profileId>~N" for an extra shell of the same terminal. */
  sessionKey: string;
  profile: Profile;
  /** Its tab is on screen. */
  active: boolean;
  /** It is the focused pane of its tab (gets the keyboard). */
  focused: boolean;
  autoStart: boolean;
  callbacks: TerminalCallbacks;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(callbacks);
  cb.current = callbacks;

  useEffect(() => {
    let host = hosts.get(sessionKey);
    const fresh = !host;
    if (!host) {
      host = new TerminalHost(sessionKey, profile.appearance, profile.advanced.scrollback);
      hosts.set(sessionKey, host);
    }
    host.onStateChange = () => cb.current.onHostState();
    host.onActivity = (kind) => cb.current.onActivity(sessionKey, kind);
    host.onNeedsAdmin = () => cb.current.onNeedsAdmin(sessionKey);
    host.onAppShortcut = (e) => cb.current.onAppShortcut(e);
    host.onFocus = () => cb.current.onFocus(sessionKey);
    host.onUserInput = (d) => cb.current.onUserInput(sessionKey, d);
    host.onCommandDone = (ms) => cb.current.onCommandDone(sessionKey, ms);
    if (ref.current) host.mount(ref.current);
    if (fresh) void host.connect(autoStart);
    // Disposal happens when the tab is closed (App), not on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  useEffect(() => {
    hosts.get(sessionKey)?.applyAppearance(profile.appearance);
  }, [sessionKey, profile.appearance]);

  useEffect(() => {
    const host = hosts.get(sessionKey);
    if (!host) return;
    host.setVisible(active);
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      host.fitNow();
      if (focused) host.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, focused, sessionKey]);

  return <div ref={ref} className={`terminal-view ${active ? 'active' : 'inactive'}`} data-profile-id={sessionKey} />;
}
