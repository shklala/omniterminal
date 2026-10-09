import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { CMD_CWD_PROMPT, powershellBootstrap } from '../src/daemon/pty/shells';
import { claudeWasRunning, planElevatedRestore, restoreCommandFor, type SnapshotMeta } from '../src/daemon/sessions/restore';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { createLinkProvider, lastLink } from '../src/renderer/terminal/links';
import { parseVersion } from '../src/daemon/windows/toolCheck';
import { appendHistory, cmdCommandsFromInput, readHistory } from '../src/daemon/sessions/history';
import { diffEnvironment } from '../src/daemon/windows/processEnv';

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

describe('program title cleanup', () => {
  it('extracts the running command and drops plain shell titles', async () => {
    const { cleanTitle, statsSummary } = await import('../src/renderer/util');
    expect(cleanTitle(String.raw`Administrator: C:\WINDOWS\system32\cmd.exe - python  -q`)).toBe('python -q');
    expect(cleanTitle(String.raw`C:\WINDOWS\system32\cmd.exe`)).toBe('');
    expect(cleanTitle(String.raw`C:\Program Files\PowerShell\7\pwsh.exe`)).toBe('');
    expect(cleanTitle('claude')).toBe('claude');
    expect(cleanTitle('Client X', 'Client X')).toBe('');
    expect(statsSummary({ memory: 300 * 1024 * 1024, processes: 2, children: ['claude'] }, 'claude')).toBe('300 MB');
    expect(statsSummary({ memory: 300 * 1024 * 1024, processes: 2, children: ['node'] }, 'claude')).toBe('node, 300 MB');
  });
});

describe('command palette noise filter', () => {
  it('does not match letters scattered across a long label', async () => {
    const { fuzzyScore } = await import('../src/renderer/components/CommandPalette');
    expect(fuzzyScore('cli', 'Exit Completely (stop everything)')).toBeNull();
    expect(fuzzyScore('cli', 'Client X · Supabase')).toBe(0);
  });
});

describe('PowerShell suggestions setting', () => {
  it('adds the list-view prediction setup only when enabled', () => {
    const on = powershellBootstrap('C:\h.txt', '', 'T', true);
    const off = powershellBootstrap('C:\h.txt', '', 'T', false);
    expect(on).toContain('-PredictionViewStyle ListView');
    expect(on).toContain("-ge [version]'2.1.0'");
    expect(off).not.toContain('Prediction');
  });
});

describe('Links in terminal output', () => {
  const write = (term: InstanceType<typeof HeadlessTerminal>, s: string) => new Promise<void>((r) => term.write(s, () => r()));

  it('joins a URL that a program broke over full-width lines (Claude sign-in link)', async () => {
    const term = new HeadlessTerminal({ cols: 40, rows: 20, allowProposedApi: true });
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=https%3A%2F%2Fplatform.claude.com&state=xyz';
    // Hard line breaks exactly at the terminal width, like Ink-based TUIs print.
    let text = ' Sign in:\r\n';
    for (let i = 0; i < url.length; i += 40) text += url.slice(i, i + 40) + (i + 40 < url.length ? '\r\n' : '');
    await write(term, text + '\r\n\r\nPaste code here > ');
    expect(lastLink(term as unknown as Parameters<typeof lastLink>[0])).toBe(url);
    const provider = createLinkProvider(term as unknown as Parameters<typeof createLinkProvider>[0], () => undefined, () => true);
    const links = await new Promise<{ text: string; range: { start: { y: number }; end: { y: number } } }[] | undefined>((r) => provider.provideLinks(3, r as never));
    expect(links?.[0].text).toBe(url);
    expect(links?.[0].range.start.y).toBe(2);
    expect(links?.[0].range.end.y).toBe(2 + Math.ceil(url.length / 40) - 1);
  });

  it('keeps separate lines separate and drops trailing punctuation', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 10, allowProposedApi: true });
    await write(term, 'See https://example.com/docs. And (https://example.org/a_(b)).\r\nnext line https://second.example\r\n');
    expect(lastLink(term as unknown as Parameters<typeof lastLink>[0])).toBe('https://second.example');
    const provider = createLinkProvider(term as unknown as Parameters<typeof createLinkProvider>[0], () => undefined, () => true);
    const links = await new Promise<{ text: string }[] | undefined>((r) => provider.provideLinks(1, r as never));
    expect(links?.map((l) => l.text)).toEqual(['https://example.com/docs', 'https://example.org/a_(b)']);
  });
});

describe('Installed tools: version parsing', () => {
  it('reads the version from typical --version output', () => {
    expect(parseVersion('git version 2.53.0.windows.2\n')).toBe('2.53.0.windows.2');
    expect(parseVersion('v22.11.0')).toBe('22.11.0');
    expect(parseVersion('Python 3.12.1')).toBe('3.12.1');
    expect(parseVersion('WARNING: update available\nClient Version: v1.34.1\nKustomize Version: v5')).toBe('1.34.1');
    expect(parseVersion('2.1.293 (Claude Code)')).toBe('2.1.293');
    expect(parseVersion('')).toBeNull();
  });
});

describe('Restoring after a restart: what to run', () => {
  const meta = (m: Partial<SnapshotMeta>): SnapshotMeta => ({ cwd: 'C:\\x', title: '', programs: [], elevated: false, savedAt: 1, ...m });
  it('resumes Claude Code only when it was running', () => {
    expect(claudeWasRunning(meta({ programs: ['claude'] }))).toBe(true);
    expect(claudeWasRunning(meta({ programs: ['node'], title: 'claude' }))).toBe(true); // npm install
    expect(claudeWasRunning(meta({ programs: [], title: 'claude' }))).toBe(false); // title left over after exit
    expect(claudeWasRunning(meta({ programs: null, title: 'C:\\Windows\\system32\\cmd.exe - claude' }))).toBe(true);
    expect(claudeWasRunning(meta({ programs: ['ping'] }))).toBe(false);
    expect(claudeWasRunning(null)).toBe(false);
  });
  it('prefers the terminal\'s own restore command, then claude --continue', () => {
    expect(restoreCommandFor({ restoreCommand: 'npm run dev' }, meta({ programs: ['claude'] }), true)).toBe('npm run dev');
    expect(restoreCommandFor({ restoreCommand: '' }, meta({ programs: ['claude'] }), true)).toBe('claude --continue');
    expect(restoreCommandFor({ restoreCommand: '' }, meta({ programs: ['claude'] }), false)).toBeNull();
    expect(restoreCommandFor({ restoreCommand: '  ' }, meta({ programs: [] }), true)).toBeNull();
  });
  it('asks for administrator rights again only when Windows sudo can do it in the tab', () => {
    expect(planElevatedRestore({ managerElevated: false, sudo: 'inline' })).toBe('elevated');
    expect(planElevatedRestore({ managerElevated: true, sudo: 'disabled' })).toBe('already');
    expect(planElevatedRestore({ managerElevated: false, sudo: 'disabled' })).toBe('normal');
    expect(planElevatedRestore(null)).toBe('normal');
  });
  it('makes shells report their folder', () => {
    expect(CMD_CWD_PROMPT).toBe('$E]9;9;$P$E\\');
    const ps = powershellBootstrap('C:\\h.txt', '', 'T');
    expect(ps).toContain(']9;9;');
    expect(ps).toContain("Write-Error 'x' -ErrorAction Ignore"); // keeps $? for the user's prompt
  });
});

describe('Command history and session variables across a restart', () => {
  it('records the command run at a cmd prompt, typed or pasted', () => {
    expect(cmdCommandsFromInput('C:\\work>dir /s', '\r')).toEqual(['dir /s']); // typed, then Enter
    expect(cmdCommandsFromInput('C:\\work>', 'npm test\r')).toEqual(['npm test']); // pasted with Enter
    expect(cmdCommandsFromInput('C:\\work>', 'a\rb\rc')).toEqual(['a', 'b']); // "c" not run yet
    expect(cmdCommandsFromInput('C:\\work>', '\x1b[A\r')).toEqual([]); // up-arrow recall: shown on screen next time
    expect(cmdCommandsFromInput('> claude prompt', 'hello\r')).toEqual([]); // not at a cmd prompt
    expect(cmdCommandsFromInput('\\\\server\\share>', 'dir\r')).toEqual(['dir']);
  });

  it('keeps history newest first without repeats', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-hist-'));
    const file = path.join(dir, 'cmd_history.txt');
    for (const c of ['a', 'b', 'b', 'c', 'a']) appendHistory(file, c);
    expect(fs.readFileSync(file, 'utf8')).toBe('a\nb\nc\na\n'); // immediate repeat skipped
    expect(readHistory(file, 10)).toEqual(['a', 'c', 'b']);
    fs.writeFileSync(path.join(dir, 'ps.txt'), 'Get-Item x\nfunction f {`\n  1`\n}\n');
    expect(readHistory(path.join(dir, 'ps.txt'), 10)).toEqual(['function f {\n  1\n}', 'Get-Item x']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds what the user set or removed in the shell', () => {
    const d = diffEnvironment({ Path: 'C:\\a', HOME: 'x', OLD: '1', OMNITERMINAL_SESSION_ID: 's1' }, { PATH: 'C:\\a;C:\\b', HOME: 'x', NEW: 'v', '=C:': 'C:\\w', OMNITERMINAL_SESSION_ID: 's2' });
    expect(d.set).toEqual({ PATH: 'C:\\a;C:\\b', NEW: 'v' });
    expect(d.unset).toEqual(['OLD']);
  });
});
