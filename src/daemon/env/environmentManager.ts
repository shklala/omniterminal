import * as path from 'node:path';
import { TOOL_REGISTRY, isToolEnabled } from '../../shared/tools';
import type { Profile } from '../../shared/types';
import { ValidationError, safeJoin, validateEnvName } from '../../shared/validation';
import { ensureDir, ensureFile } from '../fsutil';
import type { RegistryEnvironment } from '../windows/registryEnv';
import { sshEnvironment } from './ssh';

/** Case-insensitive environment map that preserves the original casing (Windows semantics). */
export class EnvMap {
  private readonly map = new Map<string, { name: string; value: string }>();

  constructor(init?: Record<string, string | undefined>) {
    if (init) for (const [k, v] of Object.entries(init)) if (v !== undefined) this.set(k, v);
  }

  set(name: string, value: string): void {
    const existing = this.map.get(name.toUpperCase());
    this.map.set(name.toUpperCase(), { name: existing?.name ?? name, value });
  }

  get(name: string): string | undefined {
    return this.map.get(name.toUpperCase())?.value;
  }

  delete(name: string): void {
    this.map.delete(name.toUpperCase());
  }

  has(name: string): boolean {
    return this.map.has(name.toUpperCase());
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { name, value } of this.map.values()) out[name] = value;
    return out;
  }
}

/** Variables that belong to the session manager process and must never leak into terminals. */
const STRIP_PREFIXES = ['ELECTRON_', 'OMNITERMINAL_DAEMON', 'VITE_', 'CHROME_CRASHPAD'];
const STRIP_EXACT = ['ORIGINAL_XDG_CURRENT_DESKTOP', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID'];

/** Per-process variables that must not be replaced by registry values. */
const PROCESS_ONLY = new Set(['USERNAME', 'USERDOMAIN', 'USERPROFILE', 'COMPUTERNAME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SESSIONNAME', 'SYSTEMROOT', 'WINDIR']);

function expandVars(value: string, env: EnvMap): string {
  return value.replace(/%([^%]+)%/g, (m, name: string) => env.get(name) ?? m);
}

export interface BuildEnvInput {
  profile: Profile;
  sessionId: string;
  secrets: Record<string, string>;
  baseEnv: NodeJS.ProcessEnv;
  registry: RegistryEnvironment | null;
  extraEnv?: Record<string, string>;
  isWsl?: boolean;
}

export interface BuiltEnv {
  env: Record<string, string>;
  secretNames: Set<string>;
  /** Paths that were redirected, for display/diagnostics. */
  redirected: Record<string, string>;
}

const GITCONFIG_TEMPLATE = (name: string, slug: string, userGitconfig: string) => `# OmniTerminal per-terminal Git configuration for "${name}"
# This file is GIT_CONFIG_GLOBAL for this terminal only. Other terminals never read it.
#
# Git Credential Manager stores HTTPS credentials under a per-terminal namespace,
# so logging in here does not affect any other terminal.
[credential]
\tnamespace = omniterminal-${slug}

# Set this terminal's identity:
# [user]
# \tname = Your Name
# \temail = you@example.com

# Uncomment to also inherit your normal global settings (aliases, core.*, etc.):
# [include]
# \tpath = ${userGitconfig.replace(/\\/g, '/')}
`;

/**
 * Ensures that a tool mapping target exists. Directories are created; files are created empty
 * (git config gets a commented template). Never overwrites existing content.
 */
function materialize(target: string, kind: 'dir' | 'file', profile: Profile, envVar: string): void {
  if (kind === 'dir') {
    ensureDir(target);
    return;
  }
  if (envVar === 'GIT_CONFIG_GLOBAL') {
    const userGitconfig = path.join(process.env.USERPROFILE || '', '.gitconfig');
    ensureFile(target, GITCONFIG_TEMPLATE(profile.name, profile.slug, userGitconfig));
  } else {
    ensureFile(target, '');
  }
}

export function resolveCustomMappingPath(profileDir: string, p: string): string {
  if (path.isAbsolute(p)) return path.normalize(p);
  return safeJoin(profileDir, p);
}

/** Computes tool env redirections for a profile and creates their target dirs/files. */
export function applyToolMappings(profile: Profile, env: EnvMap, create = true): Record<string, string> {
  const redirected: Record<string, string> = {};
  for (const tool of TOOL_REGISTRY) {
    if (!isToolEnabled(profile.tools, tool)) continue;
    for (const m of tool.mappings) {
      if (m.kind === 'value') {
        const v = (m.value ?? '').replace(/\{slug\}/g, profile.slug).replace(/\{id\}/g, profile.id);
        env.set(m.envVar, v);
        redirected[m.envVar] = v;
        continue;
      }
      const target = safeJoin(profile.dir, m.path);
      if (create) materialize(target, m.kind, profile, m.envVar);
      env.set(m.envVar, target);
      redirected[m.envVar] = target;
    }
  }
  for (const cm of profile.customMappings) {
    const name = validateEnvName(cm.envVar);
    const target = resolveCustomMappingPath(profile.dir, cm.path);
    if (create) {
      if (cm.kind === 'dir') ensureDir(target);
      else ensureFile(target, '');
    }
    env.set(name, target);
    redirected[name] = target;
  }
  return redirected;
}

/**
 * Builds the complete, isolated environment block for a terminal session.
 * Order: inherited (fresh from registry) → tool redirections → app vars → user vars (incl. secrets).
 */
export function buildEnvironment(input: BuildEnvInput): BuiltEnv {
  const { profile, registry } = input;
  const env = new EnvMap(input.baseEnv as Record<string, string>);

  for (const key of Object.keys(env.toObject())) {
    const upper = key.toUpperCase();
    if (STRIP_PREFIXES.some((p) => upper.startsWith(p)) || STRIP_EXACT.includes(upper)) env.delete(key);
  }

  if (registry && profile.advanced.refreshEnvironment) {
    for (const scope of [registry.machine, registry.user]) {
      for (const [k, v] of Object.entries(scope ?? {})) {
        if (typeof v !== 'string' || PROCESS_ONLY.has(k.toUpperCase()) || k.toUpperCase() === 'PATH') continue;
        env.set(k, expandVars(v, env));
      }
    }
    const machinePath = Object.entries(registry.machine ?? {}).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
    const userPath = Object.entries(registry.user ?? {}).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
    const merged = [machinePath, userPath].filter(Boolean).map((p) => expandVars(String(p), env)).join(';');
    if (merged) env.set('Path', merged);
  }

  for (const name of profile.advanced.unsetVars) env.delete(name);

  const redirected = applyToolMappings(profile, env, true);
  for (const [k, v] of Object.entries(sshEnvironment(profile))) {
    env.set(k, v);
    redirected[k] = v;
  }

  env.set('OMNITERMINAL', '1');
  env.set('OMNITERMINAL_PROFILE', profile.name);
  env.set('OMNITERMINAL_PROFILE_ID', profile.id);
  env.set('OMNITERMINAL_PROFILE_DIR', profile.dir);
  env.set('OMNITERMINAL_SESSION_ID', input.sessionId);
  env.set('TERM_PROGRAM', 'OmniTerminal');
  env.set('COLORTERM', 'truecolor');

  for (const [k, v] of Object.entries(input.extraEnv ?? {})) env.set(k, v);

  const secretNames = new Set<string>();
  for (const v of profile.env) {
    const name = validateEnvName(v.name);
    if (v.secret) {
      const value = input.secrets[name];
      if (value !== undefined) env.set(name, value);
      secretNames.add(name.toUpperCase());
    } else {
      env.set(name, expandVars(v.value, env));
    }
  }

  if (input.isWsl) {
    // Forward history + user variables into WSL. /p translates Windows paths.
    const forward = new Set((env.get('WSLENV') ?? '').split(':').filter(Boolean));
    if (env.has('HISTFILE')) forward.add('HISTFILE/p');
    for (const v of profile.env) forward.add(v.name);
    forward.add('OMNITERMINAL');
    forward.add('OMNITERMINAL_PROFILE');
    forward.add('OMNITERMINAL_SESSION_ID');
    env.set('WSLENV', [...forward].join(':'));
  }

  return { env: env.toObject(), secretNames, redirected };
}

/** Validates the env var list coming from the GUI. */
export function normalizeEnvVars(list: unknown): { name: string; value: string; secret: boolean }[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: { name: string; value: string; secret: boolean }[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { name?: unknown; value?: unknown; secret?: unknown };
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    validateEnvName(name);
    if (seen.has(name.toUpperCase())) throw new ValidationError(`Duplicate environment variable: ${name}`);
    seen.add(name.toUpperCase());
    out.push({ name, value: typeof r.value === 'string' ? r.value : '', secret: !!r.secret });
  }
  return out;
}

