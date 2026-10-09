import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJson, writeFileAtomic } from '../fsutil';
import { dpapiProtect, dpapiUnprotect } from './dpapi';

interface SecretFile {
  version: 1;
  algorithm: 'dpapi-currentuser';
  entries: Record<string, string>;
}

export interface SecretCrypto {
  protect(values: string[], entropy: string): Promise<string[]>;
  unprotect(blobs: string[], entropy: string): Promise<string[]>;
}

export const dpapiCrypto: SecretCrypto = { protect: dpapiProtect, unprotect: dpapiUnprotect };

/**
 * Per-terminal secret storage: <profile>/credentials/secrets.dpapi.json.
 * Values are DPAPI-encrypted with a per-profile entropy so blobs cannot be swapped between terminals.
 * Nothing secret is ever stored in SQLite or returned to the GUI.
 */
export class SecretStore {
  constructor(private readonly crypto: SecretCrypto = dpapiCrypto) {}

  private file(profileDir: string): string {
    return path.join(profileDir, 'credentials', 'secrets.dpapi.json');
  }

  private entropy(profileId: string): string {
    return `OmniTerminal/v1/${profileId}`;
  }

  private read(profileDir: string): SecretFile {
    const data = readJson<SecretFile>(this.file(profileDir));
    if (data && data.version === 1 && data.entries && typeof data.entries === 'object') return data;
    return { version: 1, algorithm: 'dpapi-currentuser', entries: {} };
  }

  names(profileDir: string): Set<string> {
    return new Set(Object.keys(this.read(profileDir).entries));
  }

  async set(profileDir: string, profileId: string, values: Record<string, string>): Promise<void> {
    const names = Object.keys(values);
    if (names.length === 0) return;
    const blobs = await this.crypto.protect(names.map((n) => values[n]), this.entropy(profileId));
    const file = this.read(profileDir);
    names.forEach((n, i) => (file.entries[n] = blobs[i]));
    writeFileAtomic(this.file(profileDir), JSON.stringify(file, null, 2));
  }

  remove(profileDir: string, names: string[]): void {
    const file = this.read(profileDir);
    let changed = false;
    for (const n of names) {
      if (n in file.entries) {
        delete file.entries[n];
        changed = true;
      }
    }
    if (changed) writeFileAtomic(this.file(profileDir), JSON.stringify(file, null, 2));
  }

  /** Decrypts the requested secrets (only at session launch). */
  async getAll(profileDir: string, profileId: string, names: string[]): Promise<Record<string, string>> {
    const file = this.read(profileDir);
    const present = names.filter((n) => n in file.entries);
    const plain = await this.crypto.unprotect(present.map((n) => file.entries[n]), this.entropy(profileId));
    const out: Record<string, string> = {};
    present.forEach((n, i) => (out[n] = plain[i]));
    return out;
  }

  /** DPAPI-encrypts text for this terminal only (used for variables saved across a restart). */
  async seal(profileId: string, text: string): Promise<string> {
    return (await this.crypto.protect([text], `${this.entropy(profileId)}/session`))[0];
  }

  async unseal(profileId: string, blob: string): Promise<string> {
    return (await this.crypto.unprotect([blob], `${this.entropy(profileId)}/session`))[0];
  }

  clear(profileDir: string): void {
    try {
      fs.rmSync(this.file(profileDir), { force: true });
    } catch {
      /* ignore */
    }
  }
}
