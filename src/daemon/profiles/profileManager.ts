import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_ADVANCED, DEFAULT_APPEARANCE, MAX_SCROLLBACK, PROFILE_COLORS, PROFILE_SUBDIRS } from '../../shared/defaults';
import type {
  AdvancedSettings,
  Appearance,
  CustomMapping,
  EnvVar,
  ExportBundle,
  ExportedProfile,
  Profile,
  ProfileInput,
} from '../../shared/types';
import { TOOL_REGISTRY } from '../../shared/tools';
import {
  ValidationError,
  clampInt,
  isPathInside,
  isValidSlug,
  slugify,
  validateEnvName,
  validateProfileName,
} from '../../shared/validation';
import { applyToolMappings, EnvMap, normalizeEnvVars, resolveCustomMappingPath } from '../env/environmentManager';
import type { SecretStore } from '../credentials/secretStore';
import { ensureDir, readJson, writeFileAtomic } from '../fsutil';
import type { Logger } from '../log';
import type { Db, Row } from '../persistence/db';

/** Fields persisted in the JSON "data" column (everything except indexed columns). */
type StoredData = Omit<Profile, 'id' | 'slug' | 'name' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'sortOrder' | 'dir'>;

export interface ProfileUpdate extends Partial<Omit<Profile, 'id' | 'slug' | 'createdAt' | 'updatedAt' | 'dir'>> {}

export class ProfileManager {
  constructor(
    private readonly db: Db,
    private readonly profilesRoot: string,
    private readonly secrets: SecretStore,
    private readonly log: Logger,
  ) {
    ensureDir(profilesRoot);
  }

  // ---------- reading ----------

  list(): Profile[] {
    return this.db
      .all('SELECT * FROM profiles ORDER BY sort_order ASC, created_at ASC')
      .map((r) => this.fromRow(r));
  }

  get(id: string): Profile {
    const row = this.db.get('SELECT * FROM profiles WHERE id = ?', [id]);
    if (!row) throw new ValidationError('Terminal not found.');
    return this.fromRow(row);
  }

  find(id: string): Profile | null {
    const row = this.db.get('SELECT * FROM profiles WHERE id = ?', [id]);
    return row ? this.fromRow(row) : null;
  }

  private fromRow(r: Row): Profile {
    let data: Partial<StoredData> = {};
    try {
      data = JSON.parse(String(r.data)) as Partial<StoredData>;
    } catch {
      this.log.warn(`Profile ${String(r.id)} has unreadable data; using defaults`);
    }
    const slug = String(r.slug);
    const dir = this.dirFor(slug);
    const secretNames = this.secrets.names(dir);
    return {
      ...this.withDefaults(data),
      env: (data.env ?? []).map((v) =>
        v.secret ? { name: v.name, value: '', secret: true, hasValue: secretNames.has(v.name) } : { name: v.name, value: v.value ?? '', secret: false },
      ),
      id: String(r.id),
      slug,
      name: String(r.name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
      sortOrder: Number(r.sort_order),
      dir,
    };
  }

  private withDefaults(d: Partial<StoredData>): StoredData {
    return {
      description: d.description ?? '',
      color: d.color ?? PROFILE_COLORS[0],
      icon: d.icon ?? 'terminal',
      cwd: d.cwd ?? '',
      shellId: d.shellId ?? 'powershell',
      shellPath: d.shellPath ?? '',
      shellArgs: Array.isArray(d.shellArgs) ? d.shellArgs : [],
      startupCommand: d.startupCommand ?? '',
      restoreCommand: d.restoreCommand ?? '',
      env: d.env ?? [],
      tools: d.tools ?? {},
      customMappings: d.customMappings ?? [],
      appearance: { ...DEFAULT_APPEARANCE, ...(d.appearance ?? {}) },
      advanced: { ...DEFAULT_ADVANCED, ...(d.advanced ?? {}) },
      lastCols: d.lastCols ?? 120,
      lastRows: d.lastRows ?? 30,
    };
  }

  dirFor(slug: string): string {
    if (!isValidSlug(slug)) throw new ValidationError(`Invalid profile directory name: ${slug}`);
    const dir = path.join(this.profilesRoot, slug);
    if (!isPathInside(this.profilesRoot, dir)) throw new ValidationError('Profile directory escapes the profiles root.');
    return dir;
  }

  // ---------- validation ----------

  private assertUniqueName(name: string, exceptId?: string): void {
    const clash = this.db.get('SELECT id FROM profiles WHERE lower(name) = lower(?) AND id != ?', [name, exceptId ?? '']);
    if (clash) throw new ValidationError(`A terminal named "${name}" already exists.`);
  }

  uniqueName(base: string): string {
    const name = validateProfileName(base);
    const taken = new Set(this.db.all('SELECT lower(name) AS n FROM profiles').map((r) => String(r.n)));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const candidate = name.slice(0, 64 - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private uniqueSlug(name: string): string {
    const base = slugify(name);
    const taken = new Set(this.db.all('SELECT slug FROM profiles').map((r) => String(r.slug)));
    const free = (s: string) => !taken.has(s) && !fs.existsSync(path.join(this.profilesRoot, s));
    if (free(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, 44)}-${i}`;
      if (free(candidate)) return candidate;
    }
  }

  private sanitizeAppearance(a: Partial<Appearance> | undefined, current: Appearance): Appearance {
    const merged = { ...current, ...(a ?? {}) };
    return {
      fontFamily: String(merged.fontFamily || DEFAULT_APPEARANCE.fontFamily).slice(0, 200),
      fontSize: clampInt(merged.fontSize, 8, 40, DEFAULT_APPEARANCE.fontSize),
      theme: String(merged.theme || DEFAULT_APPEARANCE.theme).slice(0, 64),
      cursorStyle: ['block', 'underline', 'bar'].includes(merged.cursorStyle) ? merged.cursorStyle : 'block',
      cursorBlink: !!merged.cursorBlink,
    };
  }

  private sanitizeAdvanced(a: Partial<AdvancedSettings> | undefined, current: AdvancedSettings): AdvancedSettings {
    const merged = { ...current, ...(a ?? {}) };
    return {
      persistSession: !!merged.persistSession,
      scrollback: clampInt(merged.scrollback, 100, MAX_SCROLLBACK, DEFAULT_ADVANCED.scrollback),
      transcript: !!merged.transcript,
      useBundledConpty: !!merged.useBundledConpty,
      refreshEnvironment: !!merged.refreshEnvironment,
      unsetVars: (Array.isArray(merged.unsetVars) ? merged.unsetVars : [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .map((s) => validateEnvName(s)),
    };
  }

  private sanitizeMappings(list: unknown, profileDir: string): CustomMapping[] {
    if (!Array.isArray(list)) return [];
    const reserved = new Set(TOOL_REGISTRY.flatMap((t) => t.mappings.map((m) => m.envVar.toUpperCase())));
    return list.map((raw) => {
      const r = raw as Partial<CustomMapping>;
      const envVar = validateEnvName(String(r.envVar ?? '').trim());
      if (reserved.has(envVar.toUpperCase())) {
        throw new ValidationError(`${envVar} is managed by a built-in tool mapping; disable that tool first.`);
      }
      const p = String(r.path ?? '').trim();
      if (!p) throw new ValidationError(`Path for ${envVar} is required.`);
      resolveCustomMappingPath(profileDir, p); // throws on traversal
      return { envVar, path: p, kind: r.kind === 'file' ? 'file' : 'dir' };
    });
  }

  private sanitizeTools(tools: unknown): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    if (tools && typeof tools === 'object') {
      for (const t of TOOL_REGISTRY) {
        const v = (tools as Record<string, unknown>)[t.id];
        if (typeof v === 'boolean') out[t.id] = v;
      }
    }
    return out;
  }

  private sanitizeShell(input: { shellId?: string; shellPath?: string; shellArgs?: unknown }, current: StoredData) {
    const shellId = String(input.shellId ?? current.shellId).slice(0, 100);
    const shellPath = String(input.shellPath ?? current.shellPath ?? '');
    if (shellId === 'custom' && !path.isAbsolute(shellPath)) {
      throw new ValidationError('Custom shell requires an absolute path to an executable.');
    }
    const shellArgs = Array.isArray(input.shellArgs) ? input.shellArgs.map(String) : current.shellArgs;
    return { shellId, shellPath, shellArgs };
  }

  // ---------- writing ----------

  async create(input: ProfileInput): Promise<Profile> {
    const name = validateProfileName(input.name);
    this.assertUniqueName(name);
    const slug = this.uniqueSlug(name);
    const id = crypto.randomUUID();
    const dir = this.dirFor(slug);
    const now = Date.now();
    const defaults = this.withDefaults({});
    const envList = normalizeEnvVars(input.env ?? []);
    const data: StoredData = {
      ...defaults,
      description: String(input.description ?? '').slice(0, 2000),
      color: typeof input.color === 'string' ? input.color.slice(0, 20) : PROFILE_COLORS[this.count() % PROFILE_COLORS.length],
      icon: typeof input.icon === 'string' ? input.icon.slice(0, 30) : 'terminal',
      cwd: String(input.cwd ?? ''),
      ...this.sanitizeShell(input, defaults),
      startupCommand: String(input.startupCommand ?? ''),
      restoreCommand: String(input.restoreCommand ?? ''),
      env: envList.map((v) => (v.secret ? { name: v.name, value: '', secret: true } : v)),
      tools: this.sanitizeTools(input.tools),
      customMappings: this.sanitizeMappings(input.customMappings ?? [], dir),
      appearance: this.sanitizeAppearance(input.appearance, defaults.appearance),
      advanced: this.sanitizeAdvanced(input.advanced, defaults.advanced),
      lastCols: clampInt(input.lastCols, 10, 1000, 120),
      lastRows: clampInt(input.lastRows, 5, 500, 30),
    };
    const maxOrder = Number(this.db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM profiles')?.m ?? 0);

    this.createDirectories(dir);
    this.db.run(
      'INSERT INTO profiles (id, slug, name, data, created_at, updated_at, last_used_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
      [id, slug, name, JSON.stringify(data), now, now, maxOrder + 1],
    );
    const secretValues = Object.fromEntries(envList.filter((v) => v.secret && v.value).map((v) => [v.name, v.value]));
    try {
      await this.secrets.set(dir, id, secretValues);
    } catch (e) {
      this.log.error('Failed to store secrets for new terminal', e);
    }
    const profile = this.get(id);
    applyToolMappings(profile, new EnvMap(), true);
    this.writeMetadata(profile);
    this.log.info(`Created terminal ${id} (${slug})`);
    return profile;
  }

  private createDirectories(dir: string): void {
    ensureDir(dir);
    for (const sub of PROFILE_SUBDIRS) ensureDir(path.join(dir, sub));
    const readme = path.join(dir, 'README.txt');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(
        readme,
        'OmniTerminal private profile directory.\r\n' +
          'config\\       per-tool configuration (CLAUDE_CONFIG_DIR, CLOUDSDK_CONFIG, GH_CONFIG_DIR, ...)\r\n' +
          'credentials\\  DPAPI-encrypted secret variables (readable only by your Windows account)\r\n' +
          'history\\      shell / REPL history for this terminal only\r\n' +
          'logs\\         session lifecycle log and optional transcripts\r\n' +
          'cache\\        terminal-specific cache\r\n' +
          'environment\\  environment snapshot (names only, never values of secrets)\r\n',
      );
    }
  }

  async update(id: string, patch: ProfileUpdate): Promise<Profile> {
    const current = this.get(id);
    const { id: _i, slug: _s, name: _n, createdAt: _c, updatedAt: _u, lastUsedAt: _l, sortOrder: _o, dir: _d, ...currentData } = current;
    const name = patch.name !== undefined ? validateProfileName(patch.name) : current.name;
    if (name !== current.name) this.assertUniqueName(name, id);

    const data: StoredData = {
      ...currentData,
      env: current.env.map((v) => ({ name: v.name, value: v.secret ? '' : v.value, secret: v.secret })),
    };
    if (patch.description !== undefined) data.description = String(patch.description).slice(0, 2000);
    if (patch.color !== undefined) data.color = String(patch.color).slice(0, 20);
    if (patch.icon !== undefined) data.icon = String(patch.icon).slice(0, 30);
    if (patch.cwd !== undefined) data.cwd = String(patch.cwd);
    if (patch.shellId !== undefined || patch.shellPath !== undefined || patch.shellArgs !== undefined) {
      Object.assign(data, this.sanitizeShell(patch, data));
    }
    if (patch.startupCommand !== undefined) data.startupCommand = String(patch.startupCommand);
    if (patch.restoreCommand !== undefined) data.restoreCommand = String(patch.restoreCommand);
    if (patch.tools !== undefined) data.tools = this.sanitizeTools(patch.tools);
    if (patch.customMappings !== undefined) data.customMappings = this.sanitizeMappings(patch.customMappings, current.dir);
    if (patch.appearance !== undefined) data.appearance = this.sanitizeAppearance(patch.appearance, data.appearance);
    if (patch.advanced !== undefined) data.advanced = this.sanitizeAdvanced(patch.advanced, data.advanced);
    if (patch.lastCols !== undefined) data.lastCols = clampInt(patch.lastCols, 10, 1000, data.lastCols);
    if (patch.lastRows !== undefined) data.lastRows = clampInt(patch.lastRows, 5, 500, data.lastRows);

    if (patch.env !== undefined) {
      const list = normalizeEnvVars(patch.env);
      const newSecretValues: Record<string, string> = {};
      for (const v of list) if (v.secret && v.value) newSecretValues[v.name] = v.value;
      // Secrets that were removed, or converted to plain vars, are deleted from the store.
      const keepSecret = new Set(list.filter((v) => v.secret).map((v) => v.name));
      const stale = [...this.secrets.names(current.dir)].filter((n) => !keepSecret.has(n));
      this.secrets.remove(current.dir, stale);
      await this.secrets.set(current.dir, id, newSecretValues);
      data.env = list.map((v) => (v.secret ? { name: v.name, value: '', secret: true } : v));
    }

    const sortOrder = patch.sortOrder !== undefined ? clampInt(patch.sortOrder, 0, 1e9, current.sortOrder) : current.sortOrder;
    this.db.run('UPDATE profiles SET name = ?, data = ?, updated_at = ?, sort_order = ? WHERE id = ?', [
      name,
      JSON.stringify(data),
      Date.now(),
      sortOrder,
      id,
    ]);
    const updated = this.get(id);
    this.writeMetadata(updated);
    return updated;
  }

  rename(id: string, newName: string): Promise<Profile> {
    return this.update(id, { name: newName });
  }

  touch(id: string): void {
    this.db.run('UPDATE profiles SET last_used_at = ? WHERE id = ?', [Date.now(), id]);
  }

  reorder(ids: string[]): void {
    this.db.transaction(() => {
      ids.forEach((id, i) => this.db.run('UPDATE profiles SET sort_order = ? WHERE id = ?', [i + 1, id]));
    });
  }

  delete(id: string, deleteFiles = true): void {
    const p = this.get(id);
    this.db.run('DELETE FROM profiles WHERE id = ?', [id]);
    this.db.run('DELETE FROM sessions WHERE profile_id = ?', [id]);
    if (deleteFiles) {
      // Defence in depth: only ever remove a directory strictly inside the profiles root.
      if (!isPathInside(this.profilesRoot, p.dir)) throw new ValidationError('Refusing to delete outside the profiles root.');
      fs.rmSync(p.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } else {
      this.secrets.clear(p.dir);
    }
    this.log.info(`Deleted terminal ${id} (files ${deleteFiles ? 'removed' : 'kept'})`);
  }

  /**
   * Duplicates configuration only. Credentials are never copied:
   *  - tool config directories (Claude/gcloud/gh/...) start empty,
   *  - secret variables keep their names but have no value,
   *  - history, logs and cache are not copied,
   *  - a fresh git config with a new credential namespace is generated.
   */
  async duplicate(id: string, newName?: string): Promise<Profile> {
    const src = this.get(id);
    const name = newName ? validateProfileName(newName) : this.uniqueName(`${src.name} copy`);
    const created = await this.create({
      ...this.exportOne(src),
      env: [],
      name,
    });
    // Secrets are carried over as names only (no values); the user re-enters them.
    return this.update(created.id, {
      env: src.env.map((v) => ({ name: v.name, value: v.secret ? '' : v.value, secret: v.secret })),
    });
  }

  private count(): number {
    return Number(this.db.get('SELECT count(*) AS c FROM profiles')?.c ?? 0);
  }

  // ---------- import / export ----------

  private exportOne(p: Profile): ExportedProfile {
    return {
      name: p.name,
      description: p.description,
      color: p.color,
      icon: p.icon,
      cwd: p.cwd,
      shellId: p.shellId,
      shellPath: p.shellPath,
      shellArgs: p.shellArgs,
      startupCommand: p.startupCommand,
      restoreCommand: p.restoreCommand,
      env: p.env.map((v) => ({ name: v.name, value: v.secret ? null : v.value, secret: v.secret })),
      tools: { ...p.tools },
      customMappings: p.customMappings.map((m) => ({ ...m })),
      appearance: { ...p.appearance },
      advanced: { ...p.advanced },
    };
  }

  /** Exports configuration only. Secret values and credential files are never included. */
  exportProfiles(ids?: string[]): ExportBundle {
    const profiles = this.list().filter((p) => !ids || ids.length === 0 || ids.includes(p.id));
    return {
      format: 'omniterminal-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      note: 'Configuration only. Secret values, tokens and credential files are not included.',
      profiles: profiles.map((p) => this.exportOne(p)),
    };
  }

  async importProfiles(json: string): Promise<Profile[]> {
    let bundle: ExportBundle;
    try {
      bundle = JSON.parse(json) as ExportBundle;
    } catch {
      throw new ValidationError('Import file is not valid JSON.');
    }
    if (!bundle || bundle.format !== 'omniterminal-export' || bundle.version !== 1 || !Array.isArray(bundle.profiles)) {
      throw new ValidationError('Not an OmniTerminal export file.');
    }
    const created: Profile[] = [];
    for (const p of bundle.profiles) {
      const env: EnvVar[] = (Array.isArray(p.env) ? p.env : []).map((v) => ({
        name: String(v.name),
        // Even if a crafted file contains a secret value, it is ignored.
        value: v.secret ? '' : String(v.value ?? ''),
        secret: !!v.secret,
      }));
      created.push(
        await this.create({
          ...p,
          name: this.uniqueName(validateProfileName(p.name)),
          env,
        }),
      );
    }
    return created;
  }

  // ---------- metadata mirror / recovery ----------

  /** Mirrors non-secret profile metadata to <profile>/metadata.json for crash recovery. */
  writeMetadata(p: Profile): void {
    try {
      const { dir: _dir, ...rest } = p;
      const safe = { ...rest, env: p.env.map((v) => ({ name: v.name, value: v.secret ? '' : v.value, secret: v.secret })) };
      writeFileAtomic(path.join(p.dir, 'metadata.json'), JSON.stringify({ schema: 1, profile: safe }, null, 2));
      writeFileAtomic(
        path.join(p.dir, 'environment', 'variables.json'),
        JSON.stringify(p.env.map((v) => ({ name: v.name, secret: v.secret })), null, 2),
      );
    } catch (e) {
      this.log.warn(`Could not write metadata for ${p.id}`, e);
    }
  }

  /** Rebuilds the profiles table from metadata.json files (used when the DB was lost/corrupted). */
  recoverFromMetadata(): number {
    let recovered = 0;
    if (!fs.existsSync(this.profilesRoot)) return 0;
    for (const entry of fs.readdirSync(this.profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
      const meta = readJson<{ profile?: Profile }>(path.join(this.profilesRoot, entry.name, 'metadata.json'));
      const p = meta?.profile;
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
      if (this.db.get('SELECT id FROM profiles WHERE id = ? OR slug = ?', [p.id, entry.name])) continue;
      const { id, name, createdAt, updatedAt, lastUsedAt, sortOrder, slug: _slug, dir: _dir, ...rest } = p;
      this.db.run(
        'INSERT INTO profiles (id, slug, name, data, created_at, updated_at, last_used_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, entry.name, name, JSON.stringify(rest), createdAt ?? Date.now(), updatedAt ?? Date.now(), lastUsedAt ?? null, sortOrder ?? 0],
      );
      recovered++;
    }
    if (recovered) this.log.warn(`Recovered ${recovered} terminal profile(s) from metadata.json`);
    return recovered;
  }
}
