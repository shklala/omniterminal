import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "Turn on suggestions" for Windows PowerShell 5.1, which ships PSReadLine 2.0 (no predictions).
 * Downloads PSReadLine 2.3.6 from the PowerShell Gallery into OmniTerminal's own modules folder
 * and puts that folder first in PSModulePath for OmniTerminal terminals only. The user's normal
 * PowerShell, and their installed modules, are not touched.
 */
export const PSREADLINE_VERSION = '2.3.6';
export const PSREADLINE_URL = `https://www.powershellgallery.com/api/v2/package/PSReadLine/${PSREADLINE_VERSION}`;
/** SHA-256 of the gallery package; anything else is rejected. */
export const PSREADLINE_SHA256 = 'b05dcd2e85569f0f941be028e5acaf715824b8ce0ced2a25aa8b2bd775247683';

export function psReadLineDir(modulesDir: string): string {
  return path.join(modulesDir, 'PSReadLine', PSREADLINE_VERSION);
}

export function isPsReadLineInstalled(modulesDir: string): boolean {
  return fs.existsSync(path.join(psReadLineDir(modulesDir), 'PSReadLine.psd1'));
}

export interface InstallSource {
  url: string;
  sha256: string;
}

/** Downloads, verifies and unpacks the module. Safe to call again (replaces the folder). */
export async function installPsReadLine(modulesDir: string, source: InstallSource = { url: PSREADLINE_URL, sha256: PSREADLINE_SHA256 }): Promise<void> {
  const res = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 20 * 1024 * 1024) throw new Error('Download is unexpectedly large.');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  if (hash !== source.sha256) throw new Error('The downloaded file did not match the expected checksum, so it was not installed.');

  fs.mkdirSync(modulesDir, { recursive: true });
  const target = psReadLineDir(modulesDir);
  const tmpZip = path.join(modulesDir, `psreadline-${process.pid}.zip`);
  const staging = `${target}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    fs.writeFileSync(tmpZip, body);
    await extractZip(tmpZip, staging);
    if (!fs.existsSync(path.join(staging, 'PSReadLine.psd1'))) throw new Error('The package does not contain PSReadLine.psd1.');
    // NuGet packaging leftovers.
    for (const junk of ['_rels', 'package', '[Content_Types].xml', 'PSReadLine.nuspec']) fs.rmSync(path.join(staging, junk), { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Windows 10 1803+ ships bsdtar, which reads zip files. */
function extractZip(zip: string, dest: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`Could not unpack the module: ${String(stderr || err.message).trim()}`));
      else resolve();
    });
  });
}
