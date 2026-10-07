import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AppPaths {
  home: string;
  profiles: string;
  db: string;
  run: string;
  daemonInfo: string;
  logs: string;
  pipe: string;
}

/**
 * Resolves all on-disk locations. OMNITERMINAL_HOME overrides the root (used by tests),
 * otherwise %LOCALAPPDATA%\OmniTerminal.
 */
export function getAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const base =
    env.OMNITERMINAL_HOME ||
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OmniTerminal');
  const home = path.resolve(base);
  const user = (env.USERNAME || os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
  const hash = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 10);
  return {
    home,
    profiles: path.join(home, 'profiles'),
    db: path.join(home, 'omniterminal.db'),
    run: path.join(home, 'run'),
    daemonInfo: path.join(home, 'run', 'daemon.json'),
    logs: path.join(home, 'logs'),
    pipe: `\\\\.\\pipe\\omniterminal-${user}-${hash}`,
  };
}
