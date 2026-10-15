import type { EngineInputReport } from '../components/terminal/terminal-engine-adapter.ts';

/**
 * The shapes the engine reports a pointer event in, all of which begin `ESC [`:
 *
 * - SGR (`<` button ; column ; row, ending `M` or `m`) and urxvt (button ; column ; row `M`), plain
 *   decimal text.
 * - The default and UTF-8 encodings: `M` then exactly three characters, each a byte (the engine
 *   reports these as binary) or a code point.
 *
 * The engine has no switch that stops it reporting the mouse without also changing the mode the
 * program set, so the reports are recognised here, whole, and dropped. A report is only ever
 * exactly one of these, and only while the program tracks the mouse.
 */
const PREFIX = '\u001b[';
const TEXT_BODY = /^(?:<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M|M[\s\S]{3})$/u;

export function isMouseReport(report: EngineInputReport): boolean {
  if (!report.data.startsWith(PREFIX)) return false;
  const body = report.data.slice(PREFIX.length);
  if (report.kind === 'text') return TEXT_BODY.test(body);
  // A binary report is one byte per character: `M` and three bytes.
  if (body.length !== 4 || !body.startsWith('M')) return false;
  for (let index = 1; index < body.length; index += 1) {
    if (body.charCodeAt(index) > 0xff) return false;
  }
  return true;
}
