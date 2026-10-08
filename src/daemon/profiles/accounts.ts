import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_REGISTRY, isToolEnabled } from '../../shared/tools';
import type { AccountInfo, Profile, ToolDefinition } from '../../shared/types';
import { safeJoin } from '../../shared/validation';

/**
 * "Who am I": which account each tool in a terminal is signed in to, read from that terminal's
 * own config files. Local reads only (no network, no CLI calls), and token values are never
 * returned — only whether one is set.
 */
export function readAccounts(profile: Profile, secretNames: Set<string>): AccountInfo[] {
  const out: AccountInfo[] = [];
  for (const tool of TOOL_REGISTRY) {
    if (tool.category !== 'cli' || !isToolEnabled(profile.tools, tool)) continue;
    let account: string | null = null;
    try {
      account = READERS[tool.id]?.(toolPath(profile, tool)) ?? null;
    } catch {
      account = null; // unreadable or half-written file: treat as unknown
    }
    const tokens = (tool.tokenVars ?? []).filter((t) => secretNames.has(t.envVar)).map((t) => t.label.replace(/\s*\(optional\)$/i, ''));
    if (!account && tokens.length === 0 && !READERS[tool.id]) continue;
    out.push({
      toolId: tool.id,
      toolName: tool.name,
      account,
      tokens,
      whoami: tool.whoami ?? null,
    });
  }
  return out;
}

/** Absolute path of the tool's first config mapping inside the profile. */
function toolPath(profile: Profile, tool: ToolDefinition): string {
  const m = tool.mappings.find((x) => x.kind !== 'value');
  return m ? safeJoin(profile.dir, m.path) : profile.dir;
}

function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

function readJson(file: string): any {
  const t = readText(file);
  return t ? JSON.parse(t) : null;
}

/** Minimal INI lookup: value of `key` inside `[section]`. */
export function iniValue(text: string, section: string, key: string): string | null {
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = sec[1].trim().toLowerCase();
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && current === section.toLowerCase() && kv[1].trim().toLowerCase() === key.toLowerCase()) return kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/** Decodes the payload of a JWT (no signature check; used only to show the e-mail address). */
function jwtEmail(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return typeof payload.email === 'string' ? payload.email : null;
}

const READERS: Record<string, (p: string) => string | null> = {
  claude: (dir) => {
    const j = readJson(path.join(dir, '.claude.json'));
    const a = j?.oauthAccount;
    if (!a?.emailAddress) return null;
    return a.organizationName ? `${a.emailAddress} (${a.organizationName})` : String(a.emailAddress);
  },
  codex: (dir) => {
    const j = readJson(path.join(dir, 'auth.json'));
    return jwtEmail(j?.tokens?.id_token) ?? (j?.OPENAI_API_KEY ? 'API key' : null);
  },
  gh: (dir) => {
    const t = readText(path.join(dir, 'hosts.yml'));
    if (!t) return null;
    const hosts: string[] = [];
    let host = '';
    for (const line of t.split(/\r?\n/)) {
      const h = /^([^\s#][^:]*):\s*$/.exec(line);
      if (h) host = h[1];
      const u = /^\s{4}user:\s*(\S+)/.exec(line);
      if (u && host) hosts.push(host === 'github.com' ? u[1] : `${u[1]} @ ${host}`);
    }
    return hosts.length ? hosts.join(', ') : null;
  },
  glab: (dir) => {
    const t = readText(path.join(dir, 'config.yml'));
    const m = t ? /^\s+user:\s*(\S+)/m.exec(t) : null;
    return m ? m[1] : null;
  },
  git: (file) => {
    const t = readText(file);
    if (!t) return null;
    const name = iniValue(t, 'user', 'name');
    const email = iniValue(t, 'user', 'email');
    if (!name && !email) return null;
    return name && email ? `${name} <${email}>` : (name ?? email);
  },
  gcloud: (dir) => {
    const active = (readText(path.join(dir, 'active_config')) ?? 'default').trim() || 'default';
    if (!/^[\w.-]+$/.test(active)) return null;
    const t = readText(path.join(dir, 'configurations', `config_${active}`));
    if (!t) return null;
    const account = iniValue(t, 'core', 'account');
    const project = iniValue(t, 'core', 'project');
    if (!account) return null;
    return project ? `${account} (project ${project})` : account;
  },
  azure: (dir) => {
    const j = readJson(path.join(dir, 'azureProfile.json'));
    const subs: any[] = Array.isArray(j?.subscriptions) ? j.subscriptions : [];
    const s = subs.find((x) => x?.isDefault) ?? subs[0];
    if (!s?.user?.name) return null;
    return s.name ? `${s.user.name} (${s.name})` : String(s.user.name);
  },
  aws: (file) => {
    const config = readText(file) ?? '';
    const creds = readText(path.join(path.dirname(file), 'credentials')) ?? '';
    const sso = iniValue(config, 'default', 'sso_account_id');
    if (sso) return `SSO account ${sso}`;
    if (iniValue(creds, 'default', 'aws_access_key_id')) return 'Access key (default profile)';
    return null;
  },
  kube: (file) => {
    const t = readText(file);
    const m = t ? /^current-context:\s*"?([^"\r\n]+)"?/m.exec(t) : null;
    return m && m[1].trim() ? `context ${m[1].trim()}` : null;
  },
  npm: (file) => {
    const t = readText(file);
    if (!t) return null;
    const hosts = [...t.matchAll(/^\s*\/\/([^/:\s]+)[^=]*:_authToken\s*=/gm)].map((m) => m[1]);
    return hosts.length ? `Signed in to ${[...new Set(hosts)].join(', ')}` : null;
  },
};
