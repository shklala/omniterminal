import { useEffect, useRef } from 'react';
import type { Profile } from '../../shared/types';
import { TerminalHost, hosts } from '../terminal/terminalHost';

/**
 * React shell around a long-lived TerminalHost. All tabs stay mounted (hidden when inactive),
 * so switching tabs never loses terminal state.
 */
export function TerminalView({
  sessionKey,
  profile,
  active,
  autoStart,
  onHostState,
  onActivity,
  onNeedsAdmin,
  onAppShortcut,
}: {
  /** Session key: the profile id, or "<profileId>~N" for an extra shell of the same terminal. */
  sessionKey: string;
  profile: Profile;
  active: boolean;
  autoStart: boolean;
  onHostState: () => void;
  onActivity: (profileId: string, kind: 'none' | 'output' | 'bell') => void;
  onNeedsAdmin: (profileId: string) => void;
  onAppShortcut: (e: KeyboardEvent) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const shortcutRef = useRef(onAppShortcut);
  shortcutRef.current = onAppShortcut;
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;
  const adminRef = useRef(onNeedsAdmin);
  adminRef.current = onNeedsAdmin;

  useEffect(() => {
    let host = hosts.get(sessionKey);
    const fresh = !host;
    if (!host) {
      host = new TerminalHost(sessionKey, profile.appearance, profile.advanced.scrollback);
      hosts.set(sessionKey, host);
    }
    host.onStateChange = onHostState;
    host.onActivity = (kind) => activityRef.current(sessionKey, kind);
    host.onNeedsAdmin = () => adminRef.current(sessionKey);
    host.onAppShortcut = (e) => shortcutRef.current(e);
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
      host.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, sessionKey]);

  return <div ref={ref} className={`terminal-view ${active ? 'active' : 'inactive'}`} data-profile-id={sessionKey} />;
}
