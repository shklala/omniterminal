import { parseJsonOutput, runPowerShell } from './powershell';

export interface RegistryEnvironment {
  machine: Record<string, string>;
  user: Record<string, string>;
}

let cache: { at: number; value: RegistryEnvironment } | null = null;

/**
 * Reads the current Machine and User environment from the registry, like Windows Terminal does
 * for new tabs, so terminals see PATH changes made after the session manager started.
 */
export async function readRegistryEnvironment(maxAgeMs = 10_000): Promise<RegistryEnvironment | null> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  try {
    const out = await runPowerShell(
      `$m = [Environment]::GetEnvironmentVariables('Machine'); $u = [Environment]::GetEnvironmentVariables('User');
       [Console]::Out.Write('<<JSON>>' + (ConvertTo-Json -Compress -InputObject @{ machine = $m; user = $u }) + '<</JSON>>')`,
      '',
      15_000,
    );
    const value = parseJsonOutput<RegistryEnvironment>(out);
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return null;
  }
}
