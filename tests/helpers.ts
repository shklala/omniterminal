import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAppPaths, type AppPaths } from '../src/shared/paths';
import type { SecretCrypto } from '../src/daemon/credentials/secretStore';
import { Logger } from '../src/daemon/log';
import { OmniService } from '../src/daemon/service';

/** Reversible fake "encryption" so most tests do not spawn PowerShell. Clearly not plaintext. */
export const fakeCrypto: SecretCrypto = {
  async protect(values, entropy) {
    return values.map((v) => Buffer.from(`${entropy}|${v}`).toString('base64').split('').reverse().join(''));
  },
  async unprotect(blobs, entropy) {
    return blobs.map((b) => {
      const s = Buffer.from(b.split('').reverse().join(''), 'base64').toString();
      if (!s.startsWith(`${entropy}|`)) throw new Error('entropy mismatch');
      return s.slice(entropy.length + 1);
    });
  },
};

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-test-'));
}

export interface TestContext {
  service: OmniService;
  paths: AppPaths;
  events: { data: string[]; exits: { profileId: string; exitCode: number | null }[]; changes: string[] };
  cleanup(): Promise<void>;
}

/** Tests never ask Windows for administrator rights: by default sudo looks switched off. */
export type FakeElevation = () => Promise<{ managerElevated: boolean; sudo: 'unavailable' | 'disabled' | 'newWindow' | 'inputClosed' | 'inline'; sudoPath: string }>;
const noSudo: FakeElevation = async () => ({ managerElevated: false, sudo: 'disabled', sudoPath: '' });

export async function makeService(home = tempHome(), crypto: SecretCrypto = fakeCrypto, elevation: FakeElevation = noSudo): Promise<TestContext> {
  const paths = getAppPaths({ ...process.env, OMNITERMINAL_HOME: home });
  const log = new Logger(path.join(paths.logs, 'test.log'));
  const events: TestContext['events'] = { data: [], exits: [], changes: [] };
  const service = new OmniService({
    paths,
    log,
    crypto,
    skipRegistryEnv: true,
    elevation,
    events: {
      onData: (_p, _s, d) => events.data.push(d),
      onExit: (profileId, _s, exitCode) => events.exits.push({ profileId, exitCode }),
      onChange: (r) => events.changes.push(r),
    },
  });
  await service.init();
  return {
    service,
    paths,
    events,
    async cleanup() {
      await service.shutdown();
      await log.close();
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 20000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}
