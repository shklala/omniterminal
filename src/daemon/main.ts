// OmniTerminal Session Manager: a small background process that owns every terminal (PTY).
// The GUI connects to it over a named pipe and may come and go without killing sessions.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_VERSION } from '../shared/defaults';
import { getAppPaths } from '../shared/paths';
import { writeFileAtomic } from './fsutil';
import { Logger } from './log';
import { PipeServer } from './server';
import { OmniService } from './service';

const IDLE_EXIT_MS = Number(process.env.OMNITERMINAL_IDLE_EXIT_MS || 10 * 60 * 1000);

async function main(): Promise<void> {
  const paths = getAppPaths();
  fs.mkdirSync(paths.run, { recursive: true });
  const log = new Logger(path.join(paths.logs, 'session-manager.log'), process.env.OMNITERMINAL_LOG_STDERR === '1');
  log.info(`Session manager ${APP_VERSION} starting (pid ${process.pid}, node ${process.versions.node})`);

  process.on('uncaughtException', (e) => log.error('Uncaught exception (session manager keeps running)', e));
  process.on('unhandledRejection', (e) => log.error('Unhandled rejection', e));

  const token = crypto.randomBytes(32).toString('hex');
  const server = new PipeServer(paths.pipe, token, log);
  try {
    await server.listen();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    log.info(`Another session manager already owns the pipe (${code}); exiting`);
    await log.close();
    process.exit(0);
  }

  const service = new OmniService({
    paths,
    log,
    events: {
      onData: (profileId, sessionId, data, clientId) => server.sendData(clientId, profileId, sessionId, data),
      onExit: (profileId, sessionId, exitCode) => server.broadcast('session.exit', { profileId, sessionId, exitCode }),
      onChange: (reason) => {
        server.notifyChanged(reason);
        scheduleIdleCheck();
      },
    },
  });
  try {
    await service.init();
  } catch (e) {
    log.error('Fatal: could not initialise session manager', e);
    await server.close();
    await log.close();
    process.exit(1);
  }
  server.setService(service);

  // Published only after the service is ready, so clients never connect to a half-started manager.
  writeFileAtomic(
    paths.daemonInfo,
    JSON.stringify({ pid: process.pid, pipe: paths.pipe, token, version: APP_VERSION, startedAt: service.startedAt }, null, 2),
  );

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down: ${reason}`);
    try {
      await service.shutdown();
    } catch (e) {
      log.error('Error during shutdown', e);
    }
    try {
      const info = JSON.parse(fs.readFileSync(paths.daemonInfo, 'utf8')) as { pid: number };
      if (info.pid === process.pid) fs.rmSync(paths.daemonInfo, { force: true });
    } catch {
      /* ignore */
    }
    await server.close();
    await log.close();
    process.exit(0);
  };
  service.onShutdownRequested(() => void shutdown('requested by GUI ("Exit completely")'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Idle exit: no GUI, no running terminals, and the user did not ask to keep it resident.
  let idleTimer: NodeJS.Timeout | null = null;
  function scheduleIdleCheck(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const settings = service.getSettings();
      if (server.clientCount === 0 && service.sessions.runningCount === 0 && !settings.keepManagerRunning && !settings.autostart) {
        void shutdown('idle');
      }
    }, IDLE_EXIT_MS);
  }
  server.onClientCountChange = () => scheduleIdleCheck();
  scheduleIdleCheck();

  log.info(`Listening on ${paths.pipe}`);
}

void main();
