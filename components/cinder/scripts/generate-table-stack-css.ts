/**
 * Writes Table's stacked forms into `src/components/table/table.css`, between its
 * `BEGIN GENERATED STACK RULES` and `END GENERATED STACK RULES` markers, from
 * `src/components/table/table-stack-rules.ts` (COR-2771). Prettier reformats the block afterwards;
 * `table-stack-rules.test.ts` compares the parsed rules, so formatting never matters, and fails
 * whenever the two disagree.
 *
 *   bun scripts/generate-table-stack-css.ts && bunx prettier --write src/components/table/table.css
 */

import { stylesheetStackRules } from '../src/components/table/table-stack-fixtures.ts';

const BEGIN = '/* BEGIN GENERATED STACK RULES */';
const END = '/* END GENERATED STACK RULES */';

const path = new URL('../src/components/table/table.css', import.meta.url);

/** `css` with the generated block between its markers replaced by `generated`. */
function withGeneratedStackRules(css: string, generated: string): string {
  const start = css.indexOf(BEGIN);
  const end = css.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('table.css must hold one BEGIN and one END GENERATED STACK RULES marker.');
  }
  return `${css.slice(0, start + BEGIN.length)}\n${generated}\n  ${css.slice(end)}`;
}

const css = await Bun.file(path).text();
await Bun.write(path, withGeneratedStackRules(css, stylesheetStackRules()));
process.stdout.write('wrote src/components/table/table.css; run prettier on it\n');
