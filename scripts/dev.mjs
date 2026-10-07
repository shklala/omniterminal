// Development runner: esbuild watch (main/preload/daemon) + Vite dev server + Electron.
// Uses a separate data folder (%LOCALAPPDATA%\OmniTerminal-dev) so dev never touches real profiles.
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { createServer } from 'vite';
import electronPath from 'electron';

const build = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
await new Promise((r) => build.on('close', r));
spawn(process.execPath, ['scripts/build.mjs', '--watch'], { stdio: 'inherit' });

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls.local[0];

const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: url,
  OMNITERMINAL_HOME: process.env.OMNITERMINAL_HOME || path.join(process.env.LOCALAPPDATA, 'OmniTerminal-dev'),
};
const electron = spawn(electronPath, ['.'], { stdio: 'inherit', env });
electron.on('close', () => process.exit(0));
