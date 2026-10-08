import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaemonClient } from '../../src/client/daemonClient';
import { getAppPaths } from '../../src/shared/paths';
import type { AppState, Profile } from '../../src/shared/types';
import { tempHome, waitFor } from '../helpers';

// Drives the real window: split panes, broadcast, snippets, workspaces, accounts, shortcuts,
// "command finished" notifications and the SSH key panel.

const root = path.resolve(__dirname, '..', '..');
const electronExe = createRequire(import.meta.url)('electron') as string;
const home = tempHome();
const paths = getAppPaths({ ...process.env, OMNITERMINAL_HOME: home });
const shots = process.env.OMNI_SCREENSHOT_DIR;

let app: ElectronApplication;
let page: Page;
let c: DaemonClient;
let A: Profile;
let B: Profile;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (key: string) => c.call<string>('sessions.text', { profileId: key }).catch(() => '');
const panes = () => page.locator('.pane-group.active .pane');
/** Header of the visible pane for a terminal (any of its shells: "Api", "Api 2"...). */
const paneHead = (name: string) => page.locator('.pane-group.active .pane-head').filter({ has: page.locator('.pane-name', { hasText: new RegExp(`^${name}( \\d+)?$`) }) });
/** Session key of the visible pane for a terminal. */
const paneKey = async (name: string) =>
  (await page
    .locator('.pane-group.active .pane')
    .filter({ has: page.locator('.pane-name', { hasText: new RegExp(`^${name}( \\d+)?$`) }) })
    .locator('.terminal-view')
    .getAttribute('data-profile-id')) ?? '';

async function shot(name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function typeLine(s: string) {
  await page.keyboard.type(s);
  await page.keyboard.press('Enter');
}

beforeAll(async () => {
  app = await electron.launch({
    executablePath: electronExe,
    args: ['.'],
    cwd: root,
    env: { ...process.env, OMNITERMINAL_HOME: home, OMNITERMINAL_IDLE_EXIT_MS: '600000' } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 }).catch(() => undefined);
  await page.getByText('Create your first terminal').waitFor({ timeout: 30000 });
  const info = DaemonClient.readInfo(paths);
  if (!info) throw new Error('no daemon info');
  c = new DaemonClient();
  await c.connect(info, 'e2e-features');
  A = await c.call<Profile>('profiles.create', { profile: { name: 'Api', shellId: 'cmd' } });
  B = await c.call<Profile>('profiles.create', { profile: { name: 'Web', shellId: 'cmd' } });
  await page.locator('.profile-item', { hasText: 'Api' }).first().waitFor();
});

afterAll(async () => {
  await app?.close().catch(() => undefined);
  try {
    await c.call('daemon.shutdown');
    c.close();
  } catch {
    /* ignore */
  }
  await sleep(1500);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

describe('OmniTerminal 1.3 features in the window', () => {
  it('splits a tab, broadcasts typing to every pane and closes a pane', async () => {
    await page.locator('.profile-item', { hasText: 'Api' }).first().click();
    await page.locator('.pane-group.active .terminal-view .xterm').first().click();
    await waitFor(async () => /[A-Z]:\\.*>/.test(await text(A.id)), 20000);

    await page.keyboard.press('Alt+Shift+Equal'); // Split right: a second shell of "Api"
    await waitFor(async () => (await panes().count()) === 2, 15000);
    expect(await page.locator('.tab.active .tab-panes').textContent()).toBe('+1');
    const second = `${A.id}~2`;
    await waitFor(async () => /[A-Z]:\\.*>/.test(await text(second).catch(() => '')), 20000);

    await page.keyboard.press('Control+Shift+B'); // broadcast on
    await page.locator('.broadcast-pill').waitFor();
    await typeLine('echo BCAST_%OMNITERMINAL_INSTANCE%_DONE');
    await waitFor(async () => (await text(A.id)).includes('BCAST_1_DONE') && (await text(second)).includes('BCAST_2_DONE'), 15000);
    await shot('split-broadcast');
    await page.keyboard.press('Control+Shift+B'); // off
    expect(await page.locator('.broadcast-pill').count()).toBe(0);

    // Alt+Left moves focus to the other pane; typing only goes there now.
    await page.keyboard.press('Alt+ArrowLeft');
    await typeLine('echo ONLY_IN_FIRST');
    await waitFor(async () => (await text(A.id)).includes('ONLY_IN_FIRST'), 10000);
    expect(await text(second)).not.toContain('ONLY_IN_FIRST');

    // Closing a pane keeps its shell running.
    await page.keyboard.press('Control+Shift+W');
    await waitFor(async () => (await panes().count()) === 1, 10000);
    const st = await c.call<AppState>('app.getState');
    expect(st.sessions.filter((s) => s.profileId === A.id && s.state === 'running')).toHaveLength(2);
  });

  it('runs a snippet from Ctrl+Shift+S', async () => {
    await c.call('snippets.save', { snippet: { name: 'Say hello', command: 'echo SNIPPET_RAN_%OMNITERMINAL_PROFILE%', profileId: null, run: true } });
    await sleep(500);
    await page.locator('.pane-group.active .terminal-view .xterm').first().click();
    await page.keyboard.press('Control+Shift+S');
    const input = page.getByPlaceholder('Run a snippet in the current terminal…');
    await input.waitFor();
    await input.fill('hello');
    await page.keyboard.press('Enter');
    // Ctrl+Shift+W above closed the first shell, so the tab now shows "Api 2".
    await waitFor(async () => (await text(`${A.id}~2`)).includes('SNIPPET_RAN_Api'), 10000);
  });

  it('saves the open tabs as a workspace and opens it again', async () => {
    // Put "Web" next to "Api" from the command palette.
    await page.keyboard.press('Control+Shift+P');
    await page.getByPlaceholder('Jump to a terminal or run a command…').fill('split with web');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await panes().count()) === 2, 15000);
    await waitFor(async () => /[A-Z]:\\.*>/.test(await text(B.id).catch(() => '')), 20000);

    await page.getByRole('button', { name: /All Terminals/ }).click();
    await page.getByRole('button', { name: 'Save open tabs as a workspace…' }).click();
    const dlg = page.getByRole('dialog', { name: 'Save open tabs as a workspace' });
    await dlg.locator('input').fill('Client A');
    await dlg.getByRole('button', { name: 'Save workspace' }).click();
    await page.locator('.workspace-row', { hasText: 'Client A' }).waitFor();
    await shot('workspaces');

    // Close every tab, then open the workspace: the split comes back.
    while ((await page.locator('.tab').count()) > 0) {
      await page.locator('.tab .tab-close').first().click({ force: true });
      await sleep(150);
    }
    await page.locator('.workspace-row', { hasText: 'Client A' }).getByRole('button', { name: 'Open' }).click();
    await waitFor(async () => (await panes().count()) === 2, 15000);
    // "Api 2" was an extra shell, so the workspace opens a new extra shell of Api next to Web.
    const names = (await page.locator('.pane-group.active .pane-name').allTextContents()).sort();
    expect(names[0]).toMatch(/^Api \d+$/);
    expect(names[1]).toBe('Web');
  });

  it('shows the accounts signed in to a terminal', async () => {
    fs.mkdirSync(path.join(A.dir, 'config', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(A.dir, 'config', 'claude', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'api@example.com' } }));
    await paneHead('Api').click();
    await page.keyboard.press('Control+Shift+I');
    const dlg = page.getByRole('dialog', { name: 'Accounts in Api' });
    await dlg.getByText('api@example.com').waitFor();
    await shot('accounts');
    await page.keyboard.press('Escape');
  });

  it('notifies when a long command finishes in a background tab', async () => {
    await c.call('settings.set', { settings: { notifyAfterSeconds: 2 } });
    await sleep(500);
    await paneHead('Api').click();
    await page.locator('.pane-group.active .pane.focused .xterm').click();
    const key = await paneKey('Api');
    await typeLine('ping -n 5 127.0.0.1 >nul & echo PING_FINISHED');
    await page.getByRole('button', { name: /All Terminals/ }).click(); // look away
    await waitFor(async () => (await text(key)).includes('PING_FINISHED'), 20000);
    await page.locator('.tab').first().locator('.activity-bell').waitFor({ timeout: 10000 });
  });

  it('lets a shortcut be changed in Settings', async () => {
    await page.keyboard.press('Control+Comma');
    const dlg = page.getByRole('dialog', { name: 'OmniTerminal Settings' });
    await dlg.waitFor();
    await dlg.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
    await dlg.locator('.shortcut-row', { hasText: 'Command palette' }).locator('.shortcut-input').click();
    await page.keyboard.press('Control+K');
    expect(await dlg.locator('.shortcut-row', { hasText: 'Command palette' }).locator('kbd').textContent()).toBe('Ctrl+K');
    await shot('settings-shortcuts');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await waitFor(async () => ((await c.call<AppState>('app.getState')).settings.keybindings['app.palette'] ?? '') === 'Ctrl+K', 5000);
    await page.locator('.tab').first().click();
    await page.locator('.pane-group.active .xterm').first().click();
    await page.keyboard.press('Control+K');
    await page.getByPlaceholder('Jump to a terminal or run a command…').waitFor();
    await page.keyboard.press('Escape');
  });

  it('creates a per-terminal SSH key from the Tools tab', async () => {
    await page.getByRole('button', { name: /All Terminals/ }).click();
    await page.locator('.dash-row').filter({ hasText: 'Web' }).getByTitle('More actions').click();
    await page.getByRole('button', { name: 'Settings…' }).click();
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const card = page.locator('.tool-card').filter({ has: page.locator('.tool-name', { hasText: /^SSH key for this terminal$/ }) });
    await card.locator('.switch').click();
    await card.getByRole('button', { name: 'Create SSH key for this terminal' }).click();
    await card.getByText(/^ssh-ed25519 /).waitFor({ timeout: 15000 });
    await shot('ssh-key');
    await page.getByRole('dialog', { name: 'Web settings' }).getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(async () => (await c.call<AppState>('app.getState')).profiles.find((p) => p.id === B.id)?.tools['ssh-key'] === true, 5000);
  });

  it('offers to turn on suggestions for Windows PowerShell', async () => {
    await page.keyboard.press('Control+Comma');
    const dlg = page.getByRole('dialog', { name: 'OmniTerminal Settings' });
    await dlg.getByRole('button', { name: 'Turn on for Windows PowerShell' }).waitFor();
    await dlg.getByRole('button', { name: 'Updates and data', exact: true }).click();
    await dlg.getByText('Development build: updates are off.').waitFor();
    await page.keyboard.press('Escape');
  });
});
