import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ALLOWLIST_PATH, findRawDescriptionLists } from './check-cinder-term-value-lists';
import { collectFiles, judgeCounts, repositoryRoot } from './owner-rule-guard-support';

describe('cinder term and value lists', () => {
  test.each([
    ['a bare list', '<dl><dt>Name</dt><dd>x</dd></dl>'],
    ['a list with a class', '<dl class="ib-x__facts">\n  <dt>Name</dt>\n</dl>'],
    ['a list with attributes on a new line', '<dl\n  class="a"\n>\n</dl>'],
  ])('reports %s', (_name, source) => {
    expect(findRawDescriptionLists(`first line\n${source}`)).toEqual(['2 - raw <dl>']);
  });

  test('accepts the Cinder components and ignored text', () => {
    expect(
      findRawDescriptionLists(
        [
          '<DescriptionList items={items} />',
          '<Inspector rows={rows} />',
          '<KeyFacts facts={facts} />',
          '<dd>x</dd><dt>y</dt>',
          '<!-- <dl><dt>x</dt></dl> -->',
          '<script>const markup = "<dl>";</script>',
          '<style>dl { margin: 0; }</style>',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('reports each list on its own line', () => {
    const source = '<dl></dl>\nclean\n<dl></dl>';
    expect(findRawDescriptionLists(source).map((site) => Number.parseInt(site))).toEqual([1, 3]);
  });

  test('the allowlist holds exactly the offenders on the working tree', async () => {
    const allowlist = (await Bun.file(join(repositoryRoot, ALLOWLIST_PATH)).json()) as Record<
      string,
      number
    >;
    const paths: string[] = [];
    collectFiles(
      join(repositoryRoot, 'applications/interborough/src'),
      new Set(['.svelte']),
      paths,
      /\.test-harness\.svelte$/,
    );
    const found = new Map<string, string[]>();
    for (const path of paths) {
      const sites = findRawDescriptionLists(await Bun.file(path).text());
      if (sites.length > 0) found.set(path.slice(repositoryRoot.length + 1), sites);
    }
    expect(judgeCounts(found, allowlist)).toEqual({ problems: [], stale: [] });
  });
});
