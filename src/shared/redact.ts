// Secret redaction for anything that may reach logs, debug output or transcripts.

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g, // Anthropic API keys / OAuth tokens
  /sk-[A-Za-z0-9_\-]{20,}/g, // OpenAI-style keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_\-]{20,}/g, // GitLab
  /xox[abpors]-[A-Za-z0-9\-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ASIA[0-9A-Z]{16}/g,
  /ya29\.[A-Za-z0-9_\-]{20,}/g, // Google OAuth access token
  /1\/\/0[A-Za-z0-9_\-]{20,}/g, // Google refresh token
  /AIza[0-9A-Za-z_\-]{35}/g, // Google API key
  /npm_[A-Za-z0-9]{36}/g,
  /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, // JWT
  /(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
];

export const REDACTED = '[REDACTED]';

/**
 * Redacts well-known token formats plus any explicitly known secret values.
 * Known values shorter than 4 characters are ignored to avoid shredding normal text.
 */
export function redact(text: string, knownSecrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (match, ...groups) => {
      // key=value pattern: keep the key, redact the value.
      if (typeof groups[0] === 'string' && /[=:]\s*$/.test(groups[0])) return `${groups[0]}${REDACTED}`;
      return match.startsWith('-----BEGIN') ? `-----BEGIN PRIVATE KEY----- ${REDACTED}` : REDACTED;
    });
  }
  return out;
}

/** Returns a copy of an environment map with secret values masked, for diagnostics. */
export function maskEnv(env: Record<string, string>, secretNames: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = secretNames.has(k.toUpperCase()) ? REDACTED : redact(v);
  }
  return out;
}
