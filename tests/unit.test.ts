import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redact, REDACTED } from '../src/shared/redact';
import { FrameDecoder, encodeFrame, type Frame } from '../src/shared/protocol';
import { getAppPaths } from '../src/shared/paths';
import {
  ValidationError,
  isPathInside,
  isValidSlug,
  safeJoin,
  slugify,
  validateEnvName,
  validateProfileName,
} from '../src/shared/validation';

describe('profile name validation', () => {
  it('accepts and normalizes normal names', () => {
    expect(validateProfileName('  Terminal   01 ')).toBe('Terminal 01');
    expect(validateProfileName('Claude Account 03')).toBe('Claude Account 03');
    expect(validateProfileName('Client X — ü 日本')).toBe('Client X — ü 日本');
  });

  it.each([
    ['', 'empty'],
    ['    ', 'whitespace'],
    ['a'.repeat(65), 'too long'],
    ['bad\u0000name', 'NUL'],
    ['bad\nname', 'newline'],
    ['bad\u001b[31mname', 'escape sequence'],
  ])('rejects %j (%s)', (name) => {
    expect(() => validateProfileName(name)).toThrow(ValidationError);
  });

  it('rejects non-strings', () => {
    expect(() => validateProfileName(42)).toThrow(ValidationError);
    expect(() => validateProfileName(undefined)).toThrow(ValidationError);
  });
});

describe('slugify / directory names', () => {
  it('produces safe slugs', () => {
    expect(slugify('Terminal 01')).toBe('terminal-01');
    expect(slugify('Company A')).toBe('company-a');
    expect(slugify('../../Windows/System32')).toBe('windows-system32');
    expect(slugify('..\\..\\evil')).toBe('evil');
    expect(slugify('C:\\Users\\x')).toBe('c-users-x');
    expect(slugify('日本語')).toBe('terminal');
    expect(slugify('...')).toBe('terminal');
  });

  it('avoids Windows reserved device names', () => {
    expect(slugify('CON')).toBe('con-1');
    expect(slugify('nul')).toBe('nul-1');
    expect(slugify('com1')).toBe('com1-1');
    expect(isValidSlug('con')).toBe(false);
  });

  it('always yields a valid slug', () => {
    for (const n of ['a', 'Z-', '-x-', 'hello world!!', '🙂 smile', 'x'.repeat(200)]) {
      expect(isValidSlug(slugify(n))).toBe(true);
    }
  });
});

describe('path traversal protection', () => {
  const base = path.resolve('C:\\omni\\profiles\\term');

  it('allows nested relative paths', () => {
    expect(safeJoin(base, 'config/claude')).toBe(path.join(base, 'config', 'claude'));
    expect(safeJoin(base, 'config\\git\\.gitconfig')).toBe(path.join(base, 'config', 'git', '.gitconfig'));
  });

  it.each(['..', '../x', 'config/../../x', '..\\..\\Windows', 'C:\\Windows', '/etc/passwd', '\\\\server\\share', 'a\0b', ''])(
    'rejects %j',
    (p) => {
      expect(() => safeJoin(base, p)).toThrow(ValidationError);
    },
  );

  it('isPathInside is strict', () => {
    expect(isPathInside(base, path.join(base, 'a'))).toBe(true);
    expect(isPathInside(base, base)).toBe(false);
    expect(isPathInside(base, base + '-sibling')).toBe(false);
    expect(isPathInside(base, path.join(base, '..', 'other'))).toBe(false);
  });

  it('validates env var names', () => {
    expect(validateEnvName('API_ENV')).toBe('API_ENV');
    expect(() => validateEnvName('1BAD')).toThrow();
    expect(() => validateEnvName('A=B')).toThrow();
    expect(() => validateEnvName('A B')).toThrow();
  });
});

describe('secret redaction', () => {
  it('redacts well-known token formats', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'AKIAABCDEFGHIJKLMNOP',
      'ya29.a0AfH6SMBabcdefghijklmnopqrstuv',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ];
    for (const s of samples) {
      const out = redact(`token is ${s} ok`);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain(s);
    }
  });

  it('redacts key=value secrets but keeps the key', () => {
    expect(redact('password=hunter22')).toBe(`password=${REDACTED}`);
    expect(redact('API_KEY: "abc123xyz"')).toBe(`API_KEY: ${REDACTED}`);
  });

  it('redacts private keys', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(pem)).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  it('redacts explicitly known secret values', () => {
    expect(redact('value is MyCustomSecret!', ['MyCustomSecret!'])).toBe(`value is ${REDACTED}`);
  });

  it('leaves normal text alone', () => {
    expect(redact('git commit -m "fix tokenizer" && npm test')).toBe('git commit -m "fix tokenizer" && npm test');
  });
});

describe('wire protocol', () => {
  it('round-trips frames split across chunks, including newlines in payloads', () => {
    const frames: Frame[] = [];
    const dec = new FrameDecoder((f) => frames.push(f));
    const a = encodeFrame({ t: 'evt', event: 'session.data', data: { data: 'line1\r\nline2\u001b[31m' } });
    const b = encodeFrame({ t: 'req', id: 7, method: 'ping' });
    const all = a + b;
    dec.push(all.slice(0, 10));
    dec.push(all.slice(10, 50));
    dec.push(all.slice(50));
    expect(frames).toHaveLength(2);
    expect((frames[0] as { data: { data: string } }).data.data).toBe('line1\r\nline2\u001b[31m');
    expect(frames[1]).toEqual({ t: 'req', id: 7, method: 'ping' });
  });

  it('derives a per-home pipe name', () => {
    const a = getAppPaths({ OMNITERMINAL_HOME: 'C:\\a', USERNAME: 'u' });
    const b = getAppPaths({ OMNITERMINAL_HOME: 'C:\\b', USERNAME: 'u' });
    expect(a.pipe).not.toBe(b.pipe);
    expect(a.pipe.startsWith('\\\\.\\pipe\\omniterminal-u-')).toBe(true);
    expect(a.profiles).toBe(path.join('C:\\a', 'profiles'));
  });
});

describe('tool registry', () => {
  it('has unique ids and valid, non-colliding variable names', async () => {
    const { TOOL_REGISTRY } = await import('../src/shared/tools');
    const ids = TOOL_REGISTRY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const vars = TOOL_REGISTRY.flatMap((t) => [...t.mappings.map((m) => m.envVar), ...(t.tokenVars ?? []).map((v) => v.envVar)]);
    expect(new Set(vars).size).toBe(vars.length);
    for (const v of vars) expect(() => validateEnvName(v)).not.toThrow();
  });

  it('offers a per-terminal Supabase access token', async () => {
    const { getTool } = await import('../src/shared/tools');
    expect(getTool('supabase')?.tokenVars?.[0].envVar).toBe('SUPABASE_ACCESS_TOKEN');
  });
});

describe('program title filter', () => {
  it('hides shell-path titles but keeps program titles', async () => {
    const { SHELL_PATH_TITLE } = await import('../src/renderer/util');
    for (const t of [
      String.raw`Administrator: C:\WINDOWS\system32\cmd.exe`,
      String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`,
      String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
      '/usr/bin/bash',
      'MINGW64:/c/Users/me',
    ]) expect(SHELL_PATH_TITLE.test(t), t).toBe(true);
    for (const t of ['claude', 'vim notes.txt', '✳ Fix the login bug', 'npm run dev']) expect(SHELL_PATH_TITLE.test(t), t).toBe(false);
  });
});

describe('command palette fuzzy match', () => {
  it('ranks direct substring matches first and rejects non-matches', async () => {
    const { fuzzyScore } = await import('../src/renderer/components/CommandPalette');
    expect(fuzzyScore('claude', 'Claude-01')).toBe(0);
    expect(fuzzyScore('cl01', 'Claude-01')).not.toBeNull();
    expect(fuzzyScore('cl01', 'Claude-01')!).toBeGreaterThan(fuzzyScore('01', 'Claude-01')!);
    expect(fuzzyScore('xyz', 'Claude-01')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
});
