import { useEffect, useRef } from 'react';
import type { Profile } from '../../shared/types';
import { TerminalHost, hosts } from '../terminal/terminalHost';

/**
 * React shell around a long-lived TerminalHost. All tabs stay mounted (hidden when inactive),
 * so switching tabs never loses terminal state.
 */
export function TerminalView({
  profile,
  active,
  autoStart,
  onHostState,
  onActivity,
  onAppShortcut,
}: {
  profile: Profile;
  active: boolean;
  autoStart: boolean;
  onHostState: () => void;
  onActivity: (profileId: string, kind: 'none' | 'output' | 'bell') => void;
  onAppShortcut: (e: KeyboardEvent) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const shortcutRef = useRef(onAppShortcut);
  shortcutRef.current = onAppShortcut;
  const activityRef = useRef(onActivity);
  activityRef.current = onActivity;

  useEffect(() => {
    let host = hosts.get(profile.id);
    const fresh = !host;
    if (!host) {
      host = new TerminalHost(profile.id, profile.appearance);
      hosts.set(profile.id, host);
    }
    host.onStateChange = onHostState;
    host.onActivity = (kind) => activityRef.current(profile.id, kind);
    host.onAppShortcut = (e) => shortcutRef.current(e);
    if (ref.current) host.mount(ref.current);
    if (fresh) void host.connect(autoStart);
    // Disposal happens when the tab is closed (App), not on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  useEffect(() => {
    hosts.get(profile.id)?.applyAppearance(profile.appearance);
  }, [profile.id, profile.appearance]);

  useEffect(() => {
    const host = hosts.get(profile.id);
    if (!host) return;
    host.setVisible(active);
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      host.fitNow();
      host.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, profile.id]);

  return <div ref={ref} className={`terminal-view ${active ? 'active' : 'inactive'}`} data-profile-id={profile.id} />;
}
