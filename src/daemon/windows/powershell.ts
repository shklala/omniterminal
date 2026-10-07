import { spawn } from 'node:child_process';
import * as path from 'node:path';

export function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Runs a PowerShell script via -EncodedCommand (no quoting issues, not subject to execution policy).
 * Sensitive input is passed on stdin, never on the command line.
 */
export function runPowerShell(script: string, stdin = '', timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      windowsPowerShellPath(),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('PowerShell helper timed out'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      // Never include stdin (may hold secrets) in errors; stderr is from our own script.
      else reject(new Error(`PowerShell helper failed (exit ${code}): ${err.split('\n')[0]?.slice(0, 300) ?? ''}`));
    });
    child.stdin.end(stdin, 'utf8');
  });
}

/** Extracts the last JSON document printed by a helper script. */
export function parseJsonOutput<T>(out: string): T {
  const start = out.indexOf('<<JSON>>');
  const end = out.lastIndexOf('<</JSON>>');
  if (start < 0 || end < 0) throw new Error('PowerShell helper produced no result');
  return JSON.parse(out.slice(start + 8, end)) as T;
}
