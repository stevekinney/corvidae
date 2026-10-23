import { describe, expect, it } from 'bun:test';

import { A2UI_BASIC_CATALOG_ID, a2uiCatalogOf } from './catalogs';
import {
  A2UI_MAX_COMPONENTS,
  A2UI_MAX_DEPTH,
  checkBindings,
  checkEvents,
  checkGraph,
  pointerSegments,
} from './graph';
import { panelComponents } from './a2ui.test-support';

const catalog = a2uiCatalogOf(A2UI_BASIC_CATALOG_ID)!;
const column = (id: string, children: string[]) => ({ id, component: 'Column', children });

describe('the component graph', () => {
  it('finds the reference properties from the catalog itself', () => {
    expect([...catalog.referenceKeys]).toEqual(
      expect.arrayContaining(['child', 'children', 'tabs', 'trigger', 'content']),
    );
  });

  it('accepts a whole tree', () => {
    const report = checkGraph(panelComponents(), catalog, true);
    expect(report).toMatchObject({ issues: [], dangling: [], rooted: true });
  });

  it('lets a progressive surface lack its root, and reports what is missing', () => {
    const partial = [column('a', ['b'])];
    expect(checkGraph(partial, catalog, false)).toMatchObject({
      issues: [],
      dangling: ['b'],
      rooted: false,
    });
    const strict = checkGraph(partial, catalog, true);
    expect(strict.issues.map((issue) => issue.message).join(' ')).toContain('no "root"');
    expect(strict.issues.map((issue) => issue.message).join(' ')).toContain(
      '"b", which is not defined',
    );
  });

  it('refuses cycles and self-references, complete or not', () => {
    const cycle = [column('root', ['a']), column('a', ['b']), column('b', ['a'])];
    expect(checkGraph(cycle, catalog, false).issues[0]?.message).toContain('cycle');
    expect(checkGraph([column('root', ['root'])], catalog, false).issues.length).toBeGreaterThan(0);
  });

  it('refuses a component the root does not reach, when complete', () => {
    const orphan = [column('root', []), { id: 'lost', component: 'Text', text: 'x' }];
    expect(checkGraph(orphan, catalog, true).issues[0]?.message).toContain('not reachable');
    expect(checkGraph(orphan, catalog, false).issues).toEqual([]);
  });

  it('follows list templates and tabs', () => {
    const components = [
      { id: 'root', component: 'Tabs', tabs: [{ title: 'One', child: 'list' }] },
      { id: 'list', component: 'List', children: { componentId: 'row', path: '/items' } },
      { id: 'row', component: 'Text', text: { path: 'name' } },
    ];
    expect(checkGraph(components, catalog, true)).toMatchObject({ issues: [], dangling: [] });
  });

  it('bounds depth and size', () => {
    const chain = Array.from({ length: A2UI_MAX_DEPTH + 3 }, (_, index) =>
      column(index === 0 ? 'root' : `n${index}`, [`n${index + 1}`]),
    );
    expect(checkGraph(chain, catalog, false).issues[0]?.message).toContain('levels deep');
    const wide = Array.from({ length: A2UI_MAX_COMPONENTS + 1 }, (_, index) => ({
      id: `t${index}`,
      component: 'Text',
      text: 'x',
    }));
    expect(checkGraph(wide, catalog, false).issues[0]?.message).toContain('at most');
  });
});

describe('bindings', () => {
  it('accepts well-formed absolute and relative paths', () => {
    expect(
      checkBindings([
        { id: 'a', component: 'Text', text: { path: '/user/name' } },
        { id: 'b', component: 'Text', text: { path: 'name' } },
      ]),
    ).toEqual([]);
  });

  it('refuses malformed pointers', () => {
    const issues = checkBindings([
      { id: 'a', component: 'Text', text: { path: '/a~2b' } },
      { id: 'b', component: 'Text', text: { path: '/__proto__/x' } },
      { id: 'c', component: 'Text', text: { path: '' } },
    ]);
    expect(issues.map((issue) => issue.path)).toEqual(['a/text', 'b/text', 'c/text']);
  });

  it('parses pointers per RFC 6901', () => {
    expect(pointerSegments('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(pointerSegments('')).toEqual([]);
    expect(pointerSegments('a')).toBeUndefined();
  });
});

describe('events', () => {
  it('lets a component raise only a declared action', () => {
    const components = panelComponents();
    expect(checkEvents(components, new Set(['confirm']))).toEqual([]);
    expect(checkEvents(components, new Set(['other']))[0]).toMatchObject({ path: 'go' });
  });
});
