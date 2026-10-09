import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Command history that survives a restart. cmd.exe keeps its history only in memory (doskey), so
 * OmniTerminal records each command run at a cmd prompt; PowerShell and bash already write theirs.
 */

const PROMPT_RE = /^(?:[A-Za-z]:\\[^>\r\n]*|\\\\[^>\r\n]+)>/;

/**
 * Commands run by this input: what is already typed at the prompt (on screen) plus the text sent
 * up to each Enter. Pastes and snippets send command and Enter together, before any echo.
 */
export function cmdCommandsFromInput(screenLine: string, data: string): string[] {
  if (!PROMPT_RE.test(screenLine)) return [];
  const typed = screenLine.replace(PROMPT_RE, '');
  // Drop escape sequences (arrow keys etc.); text after the last Enter is not run yet.
  const parts = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b[O@-Z\\-_]/g, '').split('\r');
  parts.pop();
  const out: string[] = [];
  parts.forEach((part, i) => {
    const clean = part.replace(/[\x00-\x1f\x7f]/g, '');
    const command = (i === 0 ? typed + clean : clean).trim();
    if (command) out.push(command);
  });
  return out;
}

const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 2000;

/** Appends one command (skipping an immediate repeat); trims the file when it grows large. */
export function appendHistory(file: string, command: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let last = '';
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        fs.writeFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n');
      }
      const tail = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
      last = tail[tail.length - 1] ?? '';
    } catch {
      /* new file */
    }
    if (last !== command) fs.appendFileSync(file, command.replace(/[\r\n]+/g, ' ') + '\n');
  } catch {
    /* history is best effort */
  }
}

/** Newest first, without repeats; PowerShell's multi-line entries (ending in `) are joined. */
export function readHistory(file: string, limit: number): string[] {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: string[] = [];
  let buf = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.endsWith('`')) {
      buf += line.slice(0, -1) + '\n';
      continue;
    }
    const entry = (buf + line).trim();
    buf = '';
    if (entry && !entry.startsWith('#')) entries.push(entry);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    if (seen.has(entries[i])) continue;
    seen.add(entries[i]);
    out.push(entries[i]);
  }
  return out;
}
