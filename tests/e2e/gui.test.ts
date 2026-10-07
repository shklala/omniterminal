import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '../../src/client/daemonClient';
import { getAppPaths } from '../../src/shared/paths';
import type { AppState } from '../../src/shared/types';
import { tempHome, waitFor } from '../helpers';

const root = path.resolve(__dirname, '..', '..');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const home = tempHome();
const paths = getAppPaths({ ...process.env, OMNITERMINAL_HOME: home });
const shots = process.env.OMNI_SCREENSHOT_DIR;

const apps: ElectronApplication[] = [];

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronExe,
    args: ['.'],
    cwd: root,
    env: { ...process.env, OMNITERMINAL_HOME: home, OMNITERMINAL_IDLE_EXIT_MS: '600000' } as Record<string, string>,
  });
  apps.push(app);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 820 }).catch(() => undefined);
  return { app, page };
}

async function manager(): Promise<DaemonClient> {
  const info = DaemonClient.readInfo(paths);
  if (!info) throw new Error('no daemon info');
  const c = new DaemonClient();
  await c.connect(info, 'e2e-probe');
  return c;
}

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  try {
    const c = await manager();
    await c.call('daemon.shutdown');
    c.close();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('OmniTerminal GUI', () => {
  let profileId = '';

  it('creates a terminal from the GUI and runs an interactive command', async () => {
    const { app, page } = await launch();
    await page.getByText('Create your first terminal').waitFor({ timeout: 30000 });
    await shot(page, '01-empty-dashboard');

    await page.getByRole('button', { name: 'New Terminal' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New Terminal' });
    await dialog.waitFor();
    await dialog.getByPlaceholder('e.g. Claude Account 03').fill('Claude-01');
    await dialog.locator('select').first().selectOption('cmd');
    await dialog.getByText('Environment variables').click();
    await dialog.getByRole('button', { name: 'Add variable' }).click();
    await dialog.getByPlaceholder('NAME').fill('API_ENV');
    await dialog.getByPlaceholder('value').fill('clientA');
    await shot(page, '02-new-terminal-dialog');
    await dialog.getByRole('button', { name: /Create & Launch/ }).click();

    const c = await manager();
    let state!: AppState;
    await waitFor(async () => {
      state = await c.call<AppState>('app.getState');
      return state.sessions.some((s) => s.state === 'running' && s.attachedClients > 0);
    }, 30000);
    profileId = state.profiles.find((p) => p.name === 'Claude-01')!.id;

    // Type into the real xterm.js terminal once the prompt is shown.
    await waitFor(async () => (await c.call<string>('sessions.text', { profileId })).includes('>'), 20000);
    await page.locator('.terminal-view.active .xterm').click();
    await page.keyboard.type('echo GUI_TYPED_%API_ENV%_%OMNITERMINAL_PROFILE%');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await c.call<string>('sessions.text', { profileId })).includes('GUI_TYPED_clientA_Claude-01'), 20000).catch(async (e) => {
      await shot(page, 'fail-typing');
      throw new Error(`${e.message}; screen was:
${(await c.call<string>('sessions.text', { profileId })).trim()}`);
    });
    await page.keyboard.type(String.raw`dir /b C:\Windows\System32\drivers\etc`);
    await page.keyboard.press('Enter');
    await waitFor(async () => (await c.call<string>('sessions.text', { profileId })).includes('hosts'), 20000);
    await shot(page, '03-terminal-running');
    c.close();

    // Close the GUI normally.
    await app.close();
  });

  it('keeps the session alive after the GUI closes', async () => {
    const c = await manager();
    const state = await c.call<AppState>('app.getState');
    const s = state.sessions.find((x) => x.profileId === profileId);
    expect(s?.state).toBe('running');
    expect(s?.attachedClients).toBe(0);
    c.close();
  });

  it('reconnects to the running session when the GUI is reopened', async () => {
    const { app, page } = await launch();
    await page.getByText(/Reconnected to 1 running terminal/).waitFor({ timeout: 30000 });
    const c = await manager();
    await waitFor(async () => {
      const st = await c.call<AppState>('app.getState');
      return (st.sessions.find((x) => x.profileId === profileId)?.attachedClients ?? 0) > 0;
    });
    // The restored screen still shows the earlier output (rendered from the server-side snapshot).
    await page.locator('.terminal-view.active .xterm').click();
    await page.keyboard.type('echo AFTER_REOPEN');
    await page.keyboard.press('Enter');
    await waitFor(async () => {
      const t = await c.call<string>('sessions.text', { profileId });
      return t.includes('GUI_TYPED_clientA_Claude-01') && /AFTER_REOPEN[\s\S]*AFTER_REOPEN/.test(t);
    }, 20000);
    await shot(page, '04-reconnected');

    // Dashboard shows the running terminal; second terminal created from dashboard is independent.
    await page.getByRole('button', { name: /All Terminals/ }).click();
    await page.getByText('Running').first().waitFor();
    await shot(page, '05-dashboard');

    // Settings dialog renders the tool isolation tab.
    await page.locator('.dash-row').filter({ hasText: 'Claude-01' }).getByTitle('More actions').click();
    await page.getByRole('button', { name: 'Settings…' }).click();
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByText('CLAUDE_CONFIG_DIR', { exact: false }).first().waitFor();
    await page.getByText('Supabase access token').first().waitFor();
    await shot(page, '06-settings-tools');
    await page.keyboard.press('Escape');

    // A second terminal; the first one rings the bell in the background → attention dot on its tab.
    await page.getByRole('button', { name: 'New Terminal' }).first().click();
    const d2 = page.getByRole('dialog', { name: 'New Terminal' });
    await d2.getByPlaceholder('e.g. Claude Account 03').fill('Background');
    await d2.locator('select').first().selectOption('cmd');
    await d2.getByRole('button', { name: /Create & Launch/ }).click();
    await d2.waitFor({ state: 'detached' });
    await page.locator('.tab.active', { hasText: 'Background' }).waitFor();
    await new Promise((r) => setTimeout(r, 1000));
    c.notify('sessions.write', { profileId, data: 'echo \x07\r' });
    await page.locator('.tab', { hasText: 'Claude-01' }).locator('.activity-bell').waitFor({ timeout: 10000 });

    // Find bar (Ctrl+Shift+F) and zoom (Ctrl+=) on the active terminal.
    await page.locator('.terminal-view.active .xterm').click();
    await page.keyboard.press('Control+Shift+F');
    await page.getByPlaceholder('Find in terminal').fill('Microsoft');
    await page.locator('.find-count', { hasText: /\d+\/\d+/ }).waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('.terminal-view.active .xterm').click();
    await page.keyboard.press('Control+=');
    await page.getByText('Font size 15px').waitFor();
    await shot(page, '07-activity-and-zoom');

    // Command palette: jump to a terminal by fuzzy name.
    await page.keyboard.press('Control+Shift+P');
    await page.getByPlaceholder('Jump to a terminal or run a command…').fill('cl01');
    await shot(page, '08-command-palette');
    await page.keyboard.press('Enter');
    await page.locator('.tab.active', { hasText: 'Claude-01' }).waitFor({ timeout: 5000 });
    c.close();
    await app.close();
  });
});
