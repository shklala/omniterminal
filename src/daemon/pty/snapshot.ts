/**
 * Makes a saved screen safe to replay into a NEW shell after a restart.
 *
 * The serialized screen of a full-screen program (Claude Code, vim) contains its terminal modes:
 * mouse tracking, bracketed paste, keypad modes and the alternate screen. Replayed into a fresh
 * shell those modes stick: the restored conversation lands on the alternate screen (which the new
 * shell then clears, so it looks lost), and mouse movement gets typed into the shell as text.
 *
 * So: the alternate screen's content is written below the normal output instead, and every DEC
 * private mode switch is removed. Colours and text stay.
 */
export function sanitizeSnapshot(text: string): string {
  return (
    text
      // Switch to the alternate screen (+ optional cursor home) -> just continue on a new line.
      .replace(/\x1b\[\?(?:1049|1047|47)h(?:\x1b\[H|\x1b\[1;1H)?/g, '\r\n')
      // Every other DEC private mode set/reset: mouse tracking, bracketed paste, app cursor keys,
      // focus events, hidden cursor, synchronized output, leaving the alternate screen...
      .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
      // Keypad application mode and scroll regions.
      .replace(/\x1b[=>]/g, '')
      .replace(/\x1b\[[0-9]*;?[0-9]*r/g, '')
  );
}
