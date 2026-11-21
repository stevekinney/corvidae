/**
 * The top bar's words (COR-2438). The search field's label clips for its ellipsis, and under the
 * Button's `line-height: 1` its 13px line box cut the descender of the "g" in "Search everything".
 * It takes the breadcrumb trail's own 20px line instead, so the title's words and the search field's
 * words are line boxes of one height on one centre line. The browser specification
 * `tests/e2e/topbar-alignment.spec.ts` measures the result; this keeps the rule from coming back.
 */
import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

/** The declarations of the first rule in `source` whose selector is exactly `selector`. */
function ruleOf(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

describe('the top bar’s search field', () => {
  test('gives its clipped label the trail’s 20px line, which holds the descender', async () => {
    const css = await read('./foundation.css');
    const label = ruleOf(css, '.weft-shell-search-trigger__label');
    expect(label).toContain('overflow: hidden;');
    expect(label).toContain('line-height: 1.25rem;');
    // The 20px line alone made the field 34px beside 32px icon buttons and select; the margin hands
    // 4px back so it keeps a medium Button's height.
    expect(label).toContain('margin-block: -0.125rem;');
    const breadcrumbs = await read(
      '../../../../components/cinder/src/components/breadcrumbs/breadcrumbs.css',
    );
    expect(ruleOf(breadcrumbs, '.cinder-breadcrumbs__list')).toContain('line-height: 1.25rem;');
  });
});
