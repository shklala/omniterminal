import * as path from 'node:path';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_NAME_LENGTH = 64;

/** Validates and normalizes a human-visible terminal name. Throws ValidationError. */
export function validateProfileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('Name must be a string.');
  if (CONTROL_CHARS.test(raw)) throw new ValidationError('Name cannot contain control characters.');
  const name = raw.trim().replace(/ {2,}/g, ' ');
  if (!name) throw new ValidationError('Name cannot be empty.');
  if (name.length > MAX_NAME_LENGTH) throw new ValidationError(`Name cannot exceed ${MAX_NAME_LENGTH} characters.`);
  return name;
}

/**
 * Converts a display name into a filesystem-safe directory slug.
 * Only [a-z0-9-] survive; separators, dots and traversal sequences are stripped.
 */
export function slugify(name: string): string {
  let slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (!slug) slug = 'terminal';
  if (WINDOWS_RESERVED.test(slug)) slug = `${slug}-1`;
  return slug;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug) && !WINDOWS_RESERVED.test(slug);
}

/** True when `child` resolves to a path strictly inside `parent` (case-insensitive on Windows). */
export function isPathInside(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  const rel = path.relative(p, c);
  if (!rel || rel === '') return false;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/** Resolves a path relative to `base`, refusing anything that escapes it. */
export function safeJoin(base: string, relative: string): string {
  if (typeof relative !== 'string' || !relative) throw new ValidationError('Path is required.');
  if (relative.includes('\0')) throw new ValidationError('Path contains a NUL byte.');
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\\\')) {
    throw new ValidationError('Expected a relative path.');
  }
  const segments = relative.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) throw new ValidationError('Path traversal ("..") is not allowed.');
  const resolved = path.resolve(base, relative);
  if (!isPathInside(base, resolved)) throw new ValidationError('Path escapes the profile directory.');
  return resolved;
}

export function validateEnvName(name: unknown): string {
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) {
    throw new ValidationError(`Invalid environment variable name: ${JSON.stringify(name)}`);
  }
  return name;
}

export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
