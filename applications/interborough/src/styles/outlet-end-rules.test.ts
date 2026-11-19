import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

/** The declarations of the first rule in `source` whose selector is exactly `selector`. */
function ruleOf(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

// The outlet ends in a spacer, not bottom padding (07cb49d17), so a docked bar sticks flush to the
// bottom of what the outlet shows. A page that still reached through the old 24px of padding hung
// its sticky bar 24px below the outlet (the agent editor's Save was cut off) or grew 24px past it
// (a plugin page scrolled). The browser specifications measure the result; these keep a page from
// compensating for padding the outlet no longer has.
describe('the end of the outlet', () => {
  test('is a spacer after the page, and the outlet has no bottom padding', async () => {
    const css = await read('./foundation.css');
    expect(ruleOf(css, '.weft-shell-outlet')).toMatch(
      /padding:\s*var\(--cinder-space-4\) var\(--weft-outlet-gutter\) 0;/,
    );
    expect(ruleOf(css, '.weft-shell-outlet::after')).toMatch(
      /block-size:\s*var\(--cinder-space-6\);/,
    );
  });

  test('no page reaches through the outlet’s old bottom padding', async () => {
    const offenders: string[] = [];
    const glob = new Bun.Glob('**/*.svelte');
    const routes = new URL('../routes/', import.meta.url).pathname;
    for await (const path of glob.scan(routes)) {
      const source = await Bun.file(`${routes}${path}`).text();
      if (/bottom:\s*calc\(-1 \* var\(--cinder-space-6\)\)/.test(source)) {
        offenders.push(`${path}: a sticky bar offset below the outlet`);
      }
      if (/calc\(100% \+ var\(--cinder-space-6\)\)/.test(source)) {
        offenders.push(`${path}: a page taller than the outlet`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
