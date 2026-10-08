// A terminal can have several live shells ("Open another"). Each shell is addressed by a session key:
//   "<profileId>"      the terminal's first shell
//   "<profileId>~2"    a second shell of the same terminal, "~3" a third, and so on.
// All shells of a terminal share its profile: the same accounts, variables and history.

const KEY_RE = /^([0-9a-f-]{36})(?:~([2-9]|[1-9][0-9]))?$/i;

export function baseProfileId(key: string): string {
  const i = key.indexOf('~');
  return i < 0 ? key : key.slice(0, i);
}

export function instanceNumber(key: string): number {
  const i = key.indexOf('~');
  return i < 0 ? 1 : Number(key.slice(i + 1)) || 1;
}

export function makeSessionKey(profileId: string, instance: number): string {
  return instance <= 1 ? profileId : `${profileId}~${instance}`;
}

/** Accepts plain profile ids (any format, for tests) and "<uuid>~N" instance keys. */
export function isValidSessionKey(key: string): boolean {
  return key.includes('~') ? KEY_RE.test(key) : key.length > 0 && key.length <= 64;
}
