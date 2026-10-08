import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTool, isToolEnabled } from '../../shared/tools';
import type { Profile, SshKeyStatus } from '../../shared/types';
import { ValidationError } from '../../shared/validation';

/**
 * Per-terminal SSH key. OpenSSH always reads %USERPROFILE%\.ssh, so instead of moving it we point
 * Git at a terminal-specific ssh config (GIT_SSH_COMMAND) that uses only this terminal's key and
 * known_hosts. PowerShell terminals also get ssh/scp/sftp functions that pass the same config.
 * Nothing changes until a key exists, so turning the tool on never breaks existing SSH logins.
 */
export const SSH_TOOL_ID = 'ssh-key';

export function sshDir(profile: Profile): string {
  return path.join(profile.dir, 'config', 'ssh');
}

export function sshKeyFile(profile: Profile): string {
  return path.join(sshDir(profile), 'id_ed25519');
}

/** Forward slashes work for both Windows OpenSSH and Git's bundled ssh. */
function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

export function sshEnabled(profile: Profile): boolean {
  const tool = getTool(SSH_TOOL_ID);
  return !!tool && isToolEnabled(profile.tools, tool);
}

/** Environment for a terminal whose SSH tool is on and has a key; empty otherwise. Writes the config file. */
export function sshEnvironment(profile: Profile): Record<string, string> {
  if (!sshEnabled(profile) || !fs.existsSync(sshKeyFile(profile))) return {};
  const dir = sshDir(profile);
  const config = path.join(dir, 'config');
  const body = [
    '# Written by OmniTerminal for this terminal. Changes are overwritten when the terminal starts;',
    '# put your own host settings in config.local, which is included below.',
    `Include "${fwd(path.join(dir, 'config.local'))}"`,
    '',
    'Host *',
    `  IdentityFile "${fwd(sshKeyFile(profile))}"`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile "${fwd(path.join(dir, 'known_hosts'))}"`,
    '',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'config.local'))) fs.writeFileSync(path.join(dir, 'config.local'), '# Your own Host entries for this terminal.\n');
  if (readOrNull(config) !== body) fs.writeFileSync(config, body);
  return {
    GIT_SSH_COMMAND: `ssh -F "${fwd(config)}"`,
    OMNITERMINAL_SSH_CONFIG: config,
  };
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function sshStatus(profile: Profile): SshKeyStatus {
  const key = sshKeyFile(profile);
  const pub = readOrNull(`${key}.pub`);
  return { enabled: sshEnabled(profile), hasKey: fs.existsSync(key), publicKey: pub ? pub.trim() : null, keyFile: key };
}

function sshKeygenPath(): string {
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'ssh-keygen.exe'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new ValidationError('ssh-keygen was not found. Install the Windows OpenSSH Client (Settings > System > Optional features).');
  return found;
}

/** Creates an ed25519 key for this terminal (no passphrase; add one later with ssh-keygen -p). */
export function createSshKey(profile: Profile): Promise<SshKeyStatus> {
  const key = sshKeyFile(profile);
  if (fs.existsSync(key)) throw new ValidationError('This terminal already has an SSH key.');
  fs.mkdirSync(sshDir(profile), { recursive: true });
  // Start from the hosts the user already trusts (github.com etc.), instead of an empty list
  // that would make the first git push fail with "Host key verification failed".
  const known = path.join(sshDir(profile), 'known_hosts');
  const userKnown = path.join(process.env.USERPROFILE || '', '.ssh', 'known_hosts');
  if (!fs.existsSync(known) && process.env.USERPROFILE && fs.existsSync(userKnown)) fs.copyFileSync(userKnown, known);
  const comment = `${profile.slug}@omniterminal`;
  return new Promise((resolve, reject) => {
    execFile(sshKeygenPath(), ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', key], { windowsHide: true, timeout: 30_000 }, (err, _o, stderr) => {
      if (err) reject(new ValidationError(`ssh-keygen failed: ${String(stderr || err.message).trim()}`));
      else resolve(sshStatus(profile));
    });
  });
}

/** PowerShell functions so plain ssh/scp/sftp use this terminal's config too. */
export const PS_SSH_FUNCTIONS = [
  `if ($env:OMNITERMINAL_SSH_CONFIG) {`,
  `  function global:ssh { & ssh.exe -F $env:OMNITERMINAL_SSH_CONFIG @args }`,
  `  function global:scp { & scp.exe -F $env:OMNITERMINAL_SSH_CONFIG @args }`,
  `  function global:sftp { & sftp.exe -F $env:OMNITERMINAL_SSH_CONFIG @args }`,
  `}`,
];
