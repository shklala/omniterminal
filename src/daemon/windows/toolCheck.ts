import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { InstalledTool } from '../../shared/types';
import { readRegistryEnvironment } from './registryEnv';

/**
 * "Installed tools": which command-line tools are on PATH, and their versions. Uses the current
 * PATH from the registry (like a new terminal would), so tools installed after the session manager
 * started are found too. Only `--version`-style commands are run.
 */
interface Check {
  id: string;
  name: string;
  group: InstalledTool['group'];
  /** Executable name looked up on PATH. */
  command: string;
  /** Arguments that print the version. */
  versionArgs: string;
  url: string;
}

const CHECKS: Check[] = [
  { id: 'claude', name: 'Claude Code', group: 'ai', command: 'claude', versionArgs: '--version', url: 'https://docs.anthropic.com/en/docs/claude-code/setup' },
  { id: 'codex', name: 'OpenAI Codex CLI', group: 'ai', command: 'codex', versionArgs: '--version', url: 'https://github.com/openai/codex' },
  { id: 'gemini', name: 'Gemini CLI', group: 'ai', command: 'gemini', versionArgs: '--version', url: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'git', name: 'Git', group: 'code', command: 'git', versionArgs: '--version', url: 'https://git-scm.com/download/win' },
  { id: 'gh', name: 'GitHub CLI', group: 'code', command: 'gh', versionArgs: '--version', url: 'https://cli.github.com' },
  { id: 'glab', name: 'GitLab CLI', group: 'code', command: 'glab', versionArgs: '--version', url: 'https://gitlab.com/gitlab-org/cli' },
  { id: 'gcloud', name: 'Google Cloud SDK', group: 'cloud', command: 'gcloud', versionArgs: '--version', url: 'https://cloud.google.com/sdk/docs/install' },
  { id: 'az', name: 'Azure CLI', group: 'cloud', command: 'az', versionArgs: '--version', url: 'https://learn.microsoft.com/cli/azure/install-azure-cli-windows' },
  { id: 'aws', name: 'AWS CLI', group: 'cloud', command: 'aws', versionArgs: '--version', url: 'https://aws.amazon.com/cli/' },
  { id: 'kubectl', name: 'kubectl', group: 'cloud', command: 'kubectl', versionArgs: 'version --client', url: 'https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/' },
  { id: 'docker', name: 'Docker', group: 'cloud', command: 'docker', versionArgs: '--version', url: 'https://docs.docker.com/desktop/setup/install/windows-install/' },
  { id: 'helm', name: 'Helm', group: 'cloud', command: 'helm', versionArgs: 'version --short', url: 'https://helm.sh/docs/intro/install/' },
  { id: 'terraform', name: 'Terraform', group: 'cloud', command: 'terraform', versionArgs: '-version', url: 'https://developer.hashicorp.com/terraform/install' },
  { id: 'pulumi', name: 'Pulumi', group: 'cloud', command: 'pulumi', versionArgs: 'version', url: 'https://www.pulumi.com/docs/install/' },
  { id: 'oci', name: 'Oracle Cloud CLI', group: 'cloud', command: 'oci', versionArgs: '--version', url: 'https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm' },
  { id: 'doctl', name: 'DigitalOcean CLI', group: 'cloud', command: 'doctl', versionArgs: 'version', url: 'https://docs.digitalocean.com/reference/doctl/how-to/install/' },
  { id: 'supabase', name: 'Supabase CLI', group: 'deploy', command: 'supabase', versionArgs: '--version', url: 'https://supabase.com/docs/guides/local-development/cli/getting-started' },
  { id: 'netlify', name: 'Netlify CLI', group: 'deploy', command: 'netlify', versionArgs: '--version', url: 'https://docs.netlify.com/cli/get-started/' },
  { id: 'flyctl', name: 'Fly.io', group: 'deploy', command: 'flyctl', versionArgs: 'version', url: 'https://fly.io/docs/flyctl/install/' },
  { id: 'wrangler', name: 'Cloudflare Wrangler', group: 'deploy', command: 'wrangler', versionArgs: '--version', url: 'https://developers.cloudflare.com/workers/wrangler/install-and-update/' },
  { id: 'railway', name: 'Railway CLI', group: 'deploy', command: 'railway', versionArgs: '--version', url: 'https://docs.railway.com/guides/cli' },
  { id: 'heroku', name: 'Heroku CLI', group: 'deploy', command: 'heroku', versionArgs: '--version', url: 'https://devcenter.heroku.com/articles/heroku-cli' },
  { id: 'eas', name: 'Expo / EAS CLI', group: 'deploy', command: 'eas', versionArgs: '--version', url: 'https://docs.expo.dev/eas/' },
  { id: 'stripe', name: 'Stripe CLI', group: 'services', command: 'stripe', versionArgs: '--version', url: 'https://docs.stripe.com/stripe-cli' },
  { id: 'sentry-cli', name: 'Sentry CLI', group: 'services', command: 'sentry-cli', versionArgs: '--version', url: 'https://docs.sentry.io/cli/installation/' },
  { id: 'ngrok', name: 'ngrok', group: 'services', command: 'ngrok', versionArgs: 'version', url: 'https://ngrok.com/download' },
  { id: 'node', name: 'Node.js', group: 'runtimes', command: 'node', versionArgs: '--version', url: 'https://nodejs.org/' },
  { id: 'npm', name: 'npm', group: 'runtimes', command: 'npm', versionArgs: '--version', url: 'https://nodejs.org/' },
  { id: 'python', name: 'Python', group: 'runtimes', command: 'python', versionArgs: '--version', url: 'https://www.python.org/downloads/windows/' },
  { id: 'pwsh', name: 'PowerShell 7', group: 'runtimes', command: 'pwsh', versionArgs: '--version', url: 'https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows' },
  { id: 'cargo', name: 'Rust (cargo)', group: 'runtimes', command: 'cargo', versionArgs: '--version', url: 'https://www.rust-lang.org/tools/install' },
  { id: 'deno', name: 'Deno', group: 'runtimes', command: 'deno', versionArgs: '--version', url: 'https://docs.deno.com/runtime/getting_started/installation/' },
  { id: 'databricks', name: 'Databricks CLI', group: 'data', command: 'databricks', versionArgs: '--version', url: 'https://docs.databricks.com/dev-tools/cli/install.html' },
  { id: 'kaggle', name: 'Kaggle CLI', group: 'data', command: 'kaggle', versionArgs: '--version', url: 'https://github.com/Kaggle/kaggle-api' },
];

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 512 * 1024, cwd: env.USERPROFILE || undefined }, (err, stdout, stderr) => {
      resolve({ out: `${stdout ?? ''}\n${stderr ?? ''}`, code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) ?? 1 : 0 });
    });
  });
}

/** The environment a new terminal would get: PATH re-read from the registry. */
async function freshEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const reg = await readRegistryEnvironment().catch(() => null);
  if (!reg) return env;
  const expand = (v: string) => v.replace(/%([^%]+)%/g, (m, n: string) => env[n] ?? process.env[n] ?? m);
  const get = (scope: Record<string, string> | undefined) => Object.entries(scope ?? {}).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const merged = [get(reg.machine), get(reg.user)].filter(Boolean).map(expand).join(';');
  if (merged) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
    env.Path = merged;
  }
  return env;
}

/** Parses "git version 2.53.0.windows.2" / "v22.11.0" / "Python 3.12.1" into a short version. */
export function parseVersion(text: string): string | null {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(WARNING|warning|Update available|DEBUG)/.test(l)) ?? '';
  const m = /v?(\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?)/.exec(first);
  return m ? m[1] : first ? first.slice(0, 40) : null;
}

/** Runs `fn` over items with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

let cache: { at: number; value: Promise<InstalledTool[]> } | null = null;

export function checkInstalledTools(force = false): Promise<InstalledTool[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = (async () => {
    const env = await freshEnv();
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    // One `where` call finds every tool on PATH (missing ones are simply not printed).
    const where = await run(path.join(sys, 'where.exe'), CHECKS.map((c) => c.command), env, 15_000);
    const found = new Map<string, string>();
    for (const line of where.out.split(/\r?\n/)) {
      const p = line.trim();
      if (!/^[A-Za-z]:\\/.test(p)) continue;
      const base = path.basename(p).replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
      // Prefer the first hit per name (PATH order), and real executables over extensionless shims.
      if (!found.has(base) && /\.(exe|cmd|bat|com)$/i.test(p)) found.set(base, p);
    }
    const cmd = path.join(sys, 'cmd.exe');
    return pool(CHECKS, 6, async (c): Promise<InstalledTool> => {
      const where = found.get(c.command.toLowerCase()) ?? null;
      // Windows' "python" placeholder only opens the Microsoft Store.
      if (!where || /\\WindowsApps\\python/i.test(where)) return { id: c.id, name: c.name, group: c.group, command: c.command, path: null, version: null, url: c.url };
      // cmd.exe runs .cmd shims (npm-installed CLIs) the same way a terminal does.
      const r = await run(cmd, ['/d', '/s', '/c', `${c.command} ${c.versionArgs}`], env, 20_000);
      return { id: c.id, name: c.name, group: c.group, command: c.command, path: where, version: parseVersion(r.out), url: c.url };
    });
  })();
  cache = { at: Date.now(), value };
  value.catch(() => (cache = null));
  return value;
}
