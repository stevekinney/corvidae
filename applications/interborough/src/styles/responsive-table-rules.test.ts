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
  test('a record table fits its box, above a floor', async () => {
    expect(ruleOf(await read('./records.css'), '.ib-records__table')).toMatch(
      /min-inline-size:\s*36rem/,
    );
    for (const path of [
      '../routes/hooks/hook-table.svelte',
      '../routes/workflow-definitions/workflow-list.svelte',
      '../routes/workflows/runs/run-list.svelte',
      '../routes/settings/models/models-section.svelte',
    ]) {
      expect(await read(path), path).toMatch(/<Table [^>]*\bfit\b[^>]*class="ib-records__table"/);
    }
  });

  test('the workflow table fits its box, above a floor, and keeps its Tags column', async () => {
    expect(ruleOf(await read('./workflows.css'), '.weft-workflows-table')).toMatch(
      /min-inline-size:\s*41rem/,
    );
    const table = await read('../routes/workflows/list/workflow-table.svelte');
    expect(table).toMatch(/<Table [^>]*\bfit\b[^>]*class="weft-workflows-table"/);
    expect(table).toMatch(/<Table\.HeaderCell>Tags<\/Table\.HeaderCell>/);
  });

  test('a model name ends each line with an ellipsis and keeps the whole of it in the title', async () => {
    const name = await read('../routes/settings/models/model-name.svelte');
    expect(name).toMatch(/<Text as="span" truncate="end" text=\{name\} \/>/);
    expect(name).toMatch(/<Text as="span" truncate="end" text=\{identifier\} \/>/);
  });
});
