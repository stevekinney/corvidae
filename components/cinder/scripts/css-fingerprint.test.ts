import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  fingerprintNodes,
  flattenFile,
  flattenStylesheet,
  ruleLines,
  ruleMultiset,
  runFingerprintCommand,
  serializeFlattened,
} from './css-fingerprint.ts';

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'css-fingerprint-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hashOf = (root: string, entry = 'entry.css'): string =>
  fingerprintNodes(flattenFile(join(root, entry)).nodes);

const BASE = `@layer app.base, app.components;
@layer app.components {
  .a { color: red; margin: 0 }
  .b, .c { padding: 1px }
}
`;

describe('css-fingerprint hash', () => {
  test('is stable under comment and whitespace edits', () => {
    const plain = fixture({ 'entry.css': BASE });
    const edited = fixture({
      'entry.css': `/* header */
@layer   app.base ,  app.components ;

@layer app.components {
  /* the a rule */
  .a
  {
    color :  red ;
    margin:0;
  }
  .b ,
  .c { padding : 1px; }
}
`,
    });
    expect(hashOf(edited)).toBe(hashOf(plain));
  });

  test('changes when a declaration changes', () => {
    const before = fixture({ 'entry.css': BASE });
    const after = fixture({ 'entry.css': BASE.replace('color: red', 'color: blue') });
    expect(hashOf(after)).not.toBe(hashOf(before));
  });

  test('changes when a rule is added, removed, or reordered', () => {
    const before = fixture({ 'entry.css': BASE });
    const reordered = fixture({
      'entry.css': `@layer app.base, app.components;
@layer app.components {
  .b, .c { padding: 1px }
  .a { color: red; margin: 0 }
}
`,
    });
    const removed = fixture({
      'entry.css': `@layer app.base, app.components;
@layer app.components {
  .a { color: red; margin: 0 }
}
`,
    });
    expect(hashOf(reordered)).not.toBe(hashOf(before));
    expect(hashOf(removed)).not.toBe(hashOf(before));
  });

  test('changes when an imported stylesheet changes its layer(…)', () => {
    const inLayer = fixture({
      'entry.css': `@import './leaf.css' layer(one);`,
      'leaf.css': '.x { color: red }',
    });
    const inOtherLayer = fixture({
      'entry.css': `@import './leaf.css' layer(two);`,
      'leaf.css': '.x { color: red }',
    });
    const unlayered = fixture({
      'entry.css': `@import './leaf.css';`,
      'leaf.css': '.x { color: red }',
    });
    expect(hashOf(inLayer)).not.toBe(hashOf(inOtherLayer));
    expect(hashOf(inLayer)).not.toBe(hashOf(unlayered));
  });
});

describe('css-fingerprint --rule-multiset', () => {
  test('is stable under rule reordering and differs by exactly the removed rule', () => {
    const before = fixture({ 'entry.css': BASE });
    const reordered = fixture({
      'entry.css': `@layer app.base, app.components;
@layer app.components {
  .b, .c { padding: 1px }
  .a { color: red; margin: 0 }
}
`,
    });
    const removed = fixture({
      'entry.css': `@layer app.base, app.components;
@layer app.components {
  .b, .c { padding: 1px }
}
`,
    });
    const multiset = (root: string): string[] =>
      ruleMultiset(flattenFile(join(root, 'entry.css')).nodes);
    expect(multiset(reordered)).toEqual(multiset(before));
    expect(multiset(before).filter((line) => !multiset(removed).includes(line))).toEqual([
      '@layer app.components :: .a{color:red;margin:0;}',
    ]);
    // `--rules` is the order check: the same lines, in cascade order, differ for the reorder.
    const rules = (root: string): string[] => ruleLines(flattenFile(join(root, 'entry.css')).nodes);
    expect(rules(reordered)).not.toEqual(rules(before));
    expect(rules(reordered).toSorted()).toEqual(rules(before).toSorted());
  });
});

describe('css-fingerprint flattening', () => {
  test('a cross-package @import flattens to the CSS inlined by hand', () => {
    const imported = fixture({
      'node_modules/@fixture/pkg/package.json': JSON.stringify({
        name: '@fixture/pkg',
        exports: { './styles': './styles.css', './x.css': './x.css' },
      }),
      'node_modules/@fixture/pkg/styles.css': '.pkg-styles { color: red }',
      'node_modules/@fixture/pkg/x.css': '.pkg-x { margin: 0 }\n/* note */',
      'entry.css': `@import "@fixture/pkg/styles";
@import "@fixture/pkg/x.css" layer(L);
.own { padding: 1px }
`,
    });
    const inlined = fixture({
      'entry.css': `.pkg-styles { color: red }
@layer L { .pkg-x { margin: 0 } }
.own { padding: 1px }
`,
    });
    const flattened = flattenFile(join(imported, 'entry.css'));
    expect(serializeFlattened(flattened.nodes)).toBe(
      serializeFlattened(flattenFile(join(inlined, 'entry.css')).nodes),
    );
    expect(hashOf(imported)).toBe(hashOf(inlined));
    expect(flattened.leaves.map((path) => path.split('/').slice(-1)[0])).toEqual([
      'styles.css',
      'x.css',
    ]);
  });

  test('follows nested relative imports once and keeps an unresolvable import as a statement', () => {
    const root = fixture({
      'entry.css': `@import './a.css';\n@import url("https://example.test/remote.css");`,
      'a.css': `@import './b.css' supports(display: grid) screen;\n.a { color: red }`,
      'b.css': `@import './a.css';\n.b { color: blue }`,
    });
    const { nodes } = flattenFile(join(root, 'entry.css'));
    expect(serializeFlattened(nodes)).toBe(
      [
        '@supports display: grid{@media screen{.b{color:blue;}}}',
        '.a{color:red;}',
        '@import url("https://example.test/remote.css");',
      ].join('\n'),
    );
  });

  test('flattens through a caller-supplied resolver', () => {
    const sheets = new Map([['/a.css', '.a{color:red}']]);
    const result = flattenStylesheet(
      { id: '/entry.css', source: `@import "/a.css" layer(x);` },
      (specifier) => {
        const source = sheets.get(specifier);
        return source === undefined ? undefined : { id: specifier, source };
      },
    );
    expect(ruleLines(result.nodes)).toEqual(['@layer x :: .a{color:red;}']);
    expect(result.visited).toEqual(['/entry.css', '/a.css']);
  });
});

describe('css-fingerprint command', () => {
  const entries = {
    'src/styles/all.css': BASE,
    'src/styles/index.css': `@import './all.css' layer(app.base);\n.extra { color: blue }`,
  };

  test('prints a value for each of all.css and index.css, then the resolved theme JSON hashes', () => {
    const root = fixture({
      ...entries,
      'src/tokens/resolved/dark.json': '{"a":1}',
      'src/tokens/resolved/light.json': '{"a":2}',
      'src/tokens/resolved/notes.txt': 'not json',
    });
    const lines = runFingerprintCommand([], root).trimEnd().split('\n');
    expect(lines).toEqual([
      '# src/styles/all.css',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      '# src/styles/index.css',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      '# resolved theme JSON',
      `src/tokens/resolved/dark.json ${createHash('sha256').update('{"a":1}').digest('hex')}`,
      `src/tokens/resolved/light.json ${createHash('sha256').update('{"a":2}').digest('hex')}`,
    ]);
    expect(lines[1]).not.toBe(lines[3]);
  });

  test('a changed theme JSON changes the output while the stylesheet hashes stay', () => {
    const before = fixture({ ...entries, 'src/tokens/resolved/dark.json': '{"a":1}' });
    const after = fixture({ ...entries, 'src/tokens/resolved/dark.json': '{"a":3}' });
    const [first, second] = [before, after].map((root) =>
      runFingerprintCommand([], root).trimEnd().split('\n'),
    );
    expect(first!.slice(0, 4)).toEqual(second!.slice(0, 4));
    expect(first!.at(-1)).not.toBe(second!.at(-1));
  });

  test('prints the rules, or the sorted rules, of both entries or of the named one', () => {
    const root = fixture(entries);
    const rules = runFingerprintCommand(['--rules'], root).split('\n');
    expect(rules).toContain('# src/styles/all.css');
    expect(rules).toContain('# src/styles/index.css');
    expect(rules).toContain('@layer app.components :: .a{color:red;margin:0;}');
    expect(rules).toContain('.extra{color:blue;}');
    const multiset = runFingerprintCommand(['--rule-multiset', 'src/styles/index.css'], root);
    expect(multiset.split('\n')[0]).toBe('# src/styles/index.css');
    expect(multiset).toContain(
      '@layer app.base > @layer app.components :: .a{color:red;margin:0;}',
    );
    expect(multiset).not.toContain('# src/styles/all.css');
    expect(runFingerprintCommand(['--package-root', root], '/nonexistent')).toBe(
      runFingerprintCommand([], root),
    );
  });
});
