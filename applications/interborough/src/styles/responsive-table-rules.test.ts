import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

/** The declarations of the first rule in `source` whose selector is exactly `selector`. */
function ruleOf(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

// Cinder sizes the table in a scroll box to its content (`min-inline-size: max-content`). A cell
// that only wraps (`overflow-wrap: anywhere`) lowers its min-content, not its max-content, so
// without these rules one long value widens a table to its own length. The browser specification
// `tests/e2e/responsive.spec.ts` measures the result; these keep the rules from being dropped.
describe('the tables that rely on wrapping', () => {
  test('a table whose cells wrap is sized to what it cannot wrap', async () => {
    const rule = ruleOf(await read('./records.css'), '.ib-records__table');
    expect(rule).toMatch(/min-inline-size:\s*min-content/);
    for (const path of [
      '../routes/hooks/hook-table.svelte',
      '../routes/workflow-definitions/workflow-list.svelte',
      '../routes/workflow-definitions/internal-workflows.svelte',
    ]) {
      expect(await read(path), path).toMatch(/<Table [^>]*class="ib-records__table"/);
    }
  });

  test('the workflow table is not sized to a flexible column that has no content width', async () => {
    const css = await read('./workflows.css');
    expect(ruleOf(css, '.weft-workflows-table')).toMatch(/min-inline-size:\s*0/);
    const table = await read('../routes/workflows/list/workflow-table.svelte');
    expect(table).not.toMatch(/<col\s*\/>/);
    expect(table).not.toMatch(/<col style=/);
  });

  test('the workflow table drops its Tags column on a phone', async () => {
    const css = await read('./workflows.css');
    const phone = css.slice(css.indexOf('@media (max-width: 39.99rem)'));
    expect(phone).toMatch(/\.weft-workflows-table__col-tags\s*\{\s*display:\s*none/);
  });

  test('a model in a table is at most 20rem wide and clips its identifier with an ellipsis', async () => {
    const name = await read('../routes/settings/models/model-name.svelte');
    expect(name).toMatch(/\[data-layout='stacked'\] \{[^}]*max-inline-size:\s*20rem/);
    expect(name).toMatch(/__identifier \{[^}]*text-overflow:\s*ellipsis/);
  });
});
