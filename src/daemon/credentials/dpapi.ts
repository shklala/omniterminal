import { parseJsonOutput, runPowerShell } from '../windows/powershell';

/**
 * Windows DPAPI (CurrentUser scope) via System.Security.Cryptography.ProtectedData.
 * Ciphertext can only be decrypted by the same Windows user on the same machine.
 * Plaintext travels over stdin only; it never appears on a command line or in logs.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$entropy = [Text.Encoding]::UTF8.GetBytes([string]$req.entropy)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
$out = New-Object System.Collections.Generic.List[string]
foreach ($item in @($req.items)) {
  if ($req.op -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$item)
    $out.Add([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)))
  } else {
    $bytes = [Convert]::FromBase64String([string]$item)
    $out.Add([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)))
  }
}
[Console]::Out.Write('<<JSON>>' + (ConvertTo-Json -InputObject @($out.ToArray()) -Compress) + '<</JSON>>')
`;

async function run(op: 'protect' | 'unprotect', items: string[], entropy: string): Promise<string[]> {
  if (items.length === 0) return [];
  const out = await runPowerShell(SCRIPT, JSON.stringify({ op, items, entropy }));
  const result = parseJsonOutput<string[] | string>(out);
  const arr = Array.isArray(result) ? result : [result];
  if (arr.length !== items.length) throw new Error('DPAPI helper returned an unexpected number of items');
  return arr;
}

export function dpapiProtect(plaintexts: string[], entropy: string): Promise<string[]> {
  return run('protect', plaintexts, entropy);
}

export function dpapiUnprotect(blobs: string[], entropy: string): Promise<string[]> {
  return run('unprotect', blobs, entropy);
}
