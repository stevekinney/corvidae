/**
 * Byte programs a scripted session replays. Each is plain text with escape sequences, so a reader
 * can see exactly what the engine is asked to render. Nothing here is random or clock-dependent.
 */

const ESC = '\u001b';
export const CSI = `${ESC}[`;
export const OSC = `${ESC}]`;
export const BEL = '\u0007';
export const ST = `${ESC}\\`;

/** A short, colored shell transcript that ends at an empty prompt with the cursor visible. */
export const TRANSCRIPT = [
  `${CSI}1;32mdeveloper@corvidae${CSI}0m:${CSI}1;34m~/terminal${CSI}0m$ bun run build`,
  `resolving workspace`,
  `${CSI}32m✓${CSI}0m compiled 12 modules`,
  `${CSI}33m!${CSI}0m 1 warning: unused export`,
  `${CSI}31m✗${CSI}0m 0 errors`,
  `${CSI}1;32mdeveloper@corvidae${CSI}0m:${CSI}1;34m~/terminal${CSI}0m$ `,
].join('\r\n');

/** Output a read-only observer sees: the same transcript without a live prompt. */
export const READ_ONLY_TRANSCRIPT = [
  `${CSI}1;32mdeveloper@corvidae${CSI}0m:${CSI}1;34m~/terminal${CSI}0m$ bun test`,
  `${CSI}32m✓${CSI}0m 42 passed`,
  `ran in 1.2 s`,
].join('\r\n');

export const EXITED_TRANSCRIPT = [
  `$ bun run deploy`,
  `${CSI}32m✓${CSI}0m deploy finished`,
  `exit status 0`,
].join('\r\n');

export const FAILED_TRANSCRIPT = [
  `$ bun run start`,
  `${CSI}31merror:${CSI}0m the process lost its session`,
].join('\r\n');

/** The sixteen base colors and a truecolor ramp, each as visible text. */
export const COLOR_SAMPLE = [
  ...Array.from({ length: 8 }, (_, index) => `${CSI}${30 + index}mcolor ${index}${CSI}0m`),
  ...Array.from({ length: 8 }, (_, index) => `${CSI}${90 + index}mbright ${index}${CSI}0m`),
  `${CSI}38;2;255;128;0mtruecolor orange${CSI}0m ${CSI}48;5;24m${CSI}97m 256-color background ${CSI}0m`,
  `${CSI}1mbold${CSI}0m ${CSI}3mitalic${CSI}0m ${CSI}4munderline${CSI}0m ${CSI}7mreverse${CSI}0m ${CSI}9mstrike${CSI}0m ${CSI}2mfaint${CSI}0m`,
].join('\r\n');

export const ENTER_ALTERNATE_SCREEN = `${CSI}?1049h`;
export const LEAVE_ALTERNATE_SCREEN = `${CSI}?1049l`;

/** A full-screen program: it clears the alternate screen, draws a body and a reverse-video bar. */
export const ALTERNATE_SCREEN_PROGRAM = [
  `${ENTER_ALTERNATE_SCREEN}${CSI}2J${CSI}H`,
  `${CSI}1;1HALTERNATE SCREEN BODY`,
  `${CSI}3;1Hline three of the full-screen program`,
  `${CSI}5;1H${CSI}7m -- INSERT -- ${CSI}0m`,
].join('');

export const BRACKETED_PASTE_ON = `${CSI}?2004h`;
export const BRACKETED_PASTE_OFF = `${CSI}?2004l`;

/** Mouse tracking with the SGR encoding, which is what a modern full-screen program asks for. */
export const MOUSE_TRACKING_SGR = `${CSI}?1000h${CSI}?1006h`;
export const MOUSE_TRACKING_OFF = `${CSI}?1000l${CSI}?1006l`;

/**
 * Numbered lines padded to a fixed width, so a modest number of rows holds more than the 64 KiB
 * snapshot bound without the engine parsing and painting thousands of rows.
 */
export function wideLines(count: number, width = 64): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1} `.padEnd(width, '.')).join(
    '\r\n',
  );
}

export const PASTE_SAMPLE = 'echo one\necho two\u001b[31m\n';
