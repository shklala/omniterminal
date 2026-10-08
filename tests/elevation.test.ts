import { describe, expect, it } from 'vitest';
import { elevatedShellCommand, getElevationStatus, parseSudoMode } from '../src/daemon/windows/elevation';
import { looksLikeAdminNeeded, supportsElevation } from '../src/renderer/util';

describe('Windows sudo detection', () => {
  it('maps the registry value to a mode', () => {
    const reg = (n: number) => `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo\r\n    Enabled    REG_DWORD    0x${n.toString(16)}\r\n`;
    expect(parseSudoMode(reg(3), true)).toBe('inline');
    expect(parseSudoMode(reg(2), true)).toBe('inputClosed');
    expect(parseSudoMode(reg(1), true)).toBe('newWindow');
    expect(parseSudoMode(reg(0), true)).toBe('disabled');
    expect(parseSudoMode('', true)).toBe('disabled');
    expect(parseSudoMode(reg(3), false)).toBe('unavailable');
  });

  it('reports this machine\'s real status', async () => {
    const s = await getElevationStatus();
    expect(typeof s.managerElevated).toBe('boolean');
    expect(['unavailable', 'disabled', 'newWindow', 'inputClosed', 'inline']).toContain(s.sudo);
  });
});

describe('continue-as-administrator command', () => {
  it('keeps the environment (-E) and re-applies PowerShell history setup', () => {
    const ps = elevatedShellCommand('powershell', String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)!;
    expect(ps).toMatch(/^sudo -E "C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoLogo -NoExit/);
    expect(ps).toContain(`'iex $env:OMNITERMINAL_PS_INIT'`);
    expect(elevatedShellCommand('cmd', String.raw`C:\Windows\system32\cmd.exe`)).toMatch(/^sudo -E "C:\\Windows\\system32\\cmd\.exe" \/D \/K/);
    expect(elevatedShellCommand('gitbash', String.raw`C:\Program Files\Git\bin\bash.exe`)).toBe('sudo.exe -E "C:/Program Files/Git/bin/bash.exe" --login -i');
    expect(elevatedShellCommand('wsl', 'wsl.exe')).toBeNull();
    expect(elevatedShellCommand('custom', 'x.exe')).toBeNull();
  });

  it('only offers elevation for Windows shells', () => {
    expect(['powershell', 'pwsh', 'cmd', 'gitbash'].every(supportsElevation)).toBe(true);
    expect(supportsElevation('wsl')).toBe(false);
    expect(supportsElevation(undefined)).toBe(false);
  });
});

describe('"needs administrator" output detection', () => {
  it.each([
    'Access is denied.',
    'New-Service : Access is denied',
    'The requested operation requires elevation.',
    'Please run this as administrator',
    '\x1b[31mERROR_ELEVATION_REQUIRED\x1b[0m',
    'Set-ExecutionPolicy : Access to the path \'C:\\Windows\\x\' is denied.',
    'System.UnauthorizedAccessException: Attempted to perform an unauthorized operation.',
    'You must be an administrator to run this command.',
  ])('flags %j', (line) => {
    expect(looksLikeAdminNeeded(line)).toBe(true);
  });

  it.each(['git@github.com: Permission denied (publickey).', 'npm install finished', 'Administrator: C:\\Windows\\system32\\cmd.exe'])(
    'ignores %j',
    (line) => {
      expect(looksLikeAdminNeeded(line)).toBe(false);
    },
  );
});

describe('Run as Administrator launch wrapper', () => {
  it('starts the shell through sudo -E, for both argv and raw command lines', async () => {
    const { wrapWithSudo } = await import('../src/daemon/windows/elevation');
    const sudo = String.raw`C:\Windows\System32\sudo.exe`;
    const pwsh = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
    const cmd = String.raw`C:\Windows\system32\cmd.exe`;
    expect(wrapWithSudo(sudo, pwsh, ['-NoLogo', '-NoExit'])).toEqual({ file: sudo, args: ['-E', pwsh, '-NoLogo', '-NoExit'] });
    expect(wrapWithSudo(sudo, cmd, '/D /S /K "echo hi"')).toEqual({ file: sudo, args: `-E "${cmd}" /D /S /K "echo hi"` });
  });
});
