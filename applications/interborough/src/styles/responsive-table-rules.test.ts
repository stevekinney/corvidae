import { describe, expect, test } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(new URL(path, import.meta.url)).text();

/** The declarations of the first rule in `source` whose selector is exactly `selector`. */
function ruleOf(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('}', start));
}

// Cinder sizes the table in a scroll box to its content (`min-inline-size: max-content`), so one
// long value widens a table to its own length. A table that holds long values opts into Cinder's
// `fit`, which lays it out at the width of its box and ends a cut value with an ellipsis, and sets a
// floor below which it scrolls by its column count (rows 16c and 24b). The browser specification
// `tests/e2e/responsive.spec.ts` measures the result; these keep the rules from being dropped.
describe('the tables that hold long values', () => {
  test('a record table fits its box and stacks on a phone, with no floor of its own', async () => {
    // The floor that made a record table scroll inside its frame is gone (COR-2364): below a
    // phone's width a `fit` table stacks its rows, so no column count makes it scroll.
    const records = await read('./records.css');
    expect(records).not.toContain('.ib-records__table');
    expect(records).not.toMatch(/min-inline-size:\s*36rem/);
    // The record lists are lists of rows (COR-2017), not tables; two tables are left.
    for (const path of [
      '../routes/settings/models/models-section.svelte',
      '../routes/workflow-definitions/internal-workflows.svelte',
    ]) {
      const source = await read(path);
      expect(source, path).toMatch(/<Table\s[^>]*\bfit\b/);
      expect(source, path).not.toContain('ib-records__table');
    }
  });

  test('the engine workflow table keeps its table layout for scoped workflow runs', async () => {
    const table = await read('../routes/workflows/list/workflow-table.svelte');
    expect(table).toContain('{...stackTable ? {} : { stackBelow: false }}');
  });

  test('the workflow table fits its box above a floor no wider than 768px gives it, and its tags are Type’s second line', async () => {
    const floor = /(?:^|\n)\s*min-inline-size:\s*(\d+(?:\.\d+)?)rem/.exec(
      ruleOf(await read('./workflows.css'), '.weft-workflows-table--with-floor'),
    );
    // The 768px container is about 642px, 40.1rem: a wider floor makes the table scroll sideways.
    expect(Number(floor?.[1])).toBeLessThanOrEqual(40);
    const table = await read('../routes/workflows/list/workflow-table.svelte');
    expect(table).toMatch(/<Table\s[\s\S]*?\bfit\b[\s\S]*?weft-workflows-table/);
    expect(table).toContain("stackTable ? '' : ' weft-workflows-table--with-floor'");
    // No Tags column of its own, so Type takes what the fixed columns leave.
    expect(table).not.toMatch(/<Table\.HeaderCell>Tags<\/Table\.HeaderCell>/);
    expect(table).toMatch(/\{#snippet detail\(\)\}[\s\S]*weft-workflows-table__tags/);
    expect(table).not.toContain('hover a time');
  });

  test('the models table gives its narrow columns a width in rem and lets Model take the rest', async () => {
    // At 768px the content column is about 442px: percentage columns gave Allowed 62px for a
    // dot and a word that need 71px, and the cell was cut with no ellipsis. Model clamps to two
    // lines, so it takes what the fixed columns leave.
    const source = await read('../routes/settings/models/models-section.svelte');
    const columns = [...source.matchAll(/<col\b([^>]*)\/>/g)].map((match) => match[1] ?? '');
    expect(columns).toHaveLength(4);
    expect(columns[0]?.trim()).toBe('');
    const widths = columns
      .slice(1)
      .map((column) => /width:\s*(\d+(?:\.\d+)?)rem/.exec(column)?.[1]);
    expect(widths.every((width) => width !== undefined)).toBe(true);
    // The table stays a table down to 26rem (Cinder's `stackBelow` default for stacked flat rows):
    // Model keeps at least 7rem of it, which is two lines of a name.
    expect(widths.reduce((sum, width) => sum + Number(width), 0)).toBeLessThanOrEqual(19);
    // Allowed holds a dot and its longest word (71px measured, at 768px) without a cut.
    expect(Number(widths[2])).toBeGreaterThanOrEqual(5);
  });

  test('a model name ends each line with an ellipsis and keeps the whole of it reachable by focus', async () => {
    const name = await read('../routes/settings/models/model-name.svelte');
    expect(name).toMatch(/<Text as="span" truncate="end" text=\{name\} \/>/);
    expect(name).toMatch(/<Text as="span" truncate="end" text=\{identifier\} \/>/);
  });
});
