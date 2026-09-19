/**
 * CIN-522: closes two escape hatches left open in `check-virtual-list-dependency-free.ts`.
 *
 * It exercises only what CIN-522 added:
 *
 *   1. `walkDependencyGraph` — following a literal relative import to whatever
 *      file it resolves to, transitively, instead of trusting a relative
 *      specifier just because it is relative. Fixture trees live under a
 *      temporary directory (same `mkdtempSync` pattern the companion test uses
 *      for `loadDeclaredDependencyNames`) so a hop can genuinely land OUTSIDE
 *      the file that wrote it, the way a real escape would.
 *   2. `resolveRelativeSpecifier` — the resolution `walkDependencyGraph` uses to
 *      turn a written specifier into a file on disk.
 *   4. `findDependencyViolations`'s new `treatAsTestFile` override, which
 *      `walkDependencyGraph` uses to classify a transitively-reached file by
 *      how the import graph actually reaches it rather than by its own
 *      filename alone.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  collectScanTargets,
  loadDeclaredDependencyNames,
  resolveRelativeSpecifier,
  walkDependencyGraph,
} from './check-virtual-list-dependency-free-graph.ts';
import {
  FORBIDDEN_SPECIFIER,
  findDependencyViolations,
} from './check-virtual-list-dependency-free-policy.ts';
import { withTemporaryFileTree } from './check-virtual-list-dependency-free-test-utilities.ts';

describe('resolveRelativeSpecifier', () => {
  test('resolves a specifier that already names an existing file exactly', async () => {
    await withTemporaryFileTree({ 'entry.ts': '', 'sibling.css': '' }, async (root) => {
      const resolved = resolveRelativeSpecifier('./sibling.css', join(root, 'entry.ts'));
      expect(resolved).toBe(join(root, 'sibling.css'));
    });
  });

  test('resolves an extensionless specifier by appending .ts', async () => {
    await withTemporaryFileTree({ 'entry.ts': '', 'sibling.ts': '' }, async (root) => {
      const resolved = resolveRelativeSpecifier('./sibling', join(root, 'entry.ts'));
      expect(resolved).toBe(join(root, 'sibling.ts'));
    });
  });

  test('resolves an extensionless specifier by appending .svelte', async () => {
    await withTemporaryFileTree({ 'entry.ts': '', 'widget.svelte': '' }, async (root) => {
      const resolved = resolveRelativeSpecifier('./widget', join(root, 'entry.ts'));
      expect(resolved).toBe(join(root, 'widget.svelte'));
    });
  });

  test('resolves a directory specifier to the index.ts inside it', async () => {
    await withTemporaryFileTree({ 'entry.ts': '', 'folder/index.ts': '' }, async (root) => {
      const resolved = resolveRelativeSpecifier('./folder', join(root, 'entry.ts'));
      expect(resolved).toBe(join(root, 'folder', 'index.ts'));
    });
  });

  test('returns undefined for a specifier that resolves to nothing on disk', async () => {
    await withTemporaryFileTree({ 'entry.ts': '' }, async (root) => {
      expect(resolveRelativeSpecifier('./nowhere', join(root, 'entry.ts'))).toBeUndefined();
    });
  });

  test('returns undefined for a specifier naming an existing directory with no index file of its own', async () => {
    await withTemporaryFileTree({ 'entry.ts': '', 'folder/leaf.ts': '' }, async (root) => {
      expect(resolveRelativeSpecifier('./folder', join(root, 'entry.ts'))).toBeUndefined();
    });
  });
});

describe('findDependencyViolations — import x = require(...) (CIN-522)', () => {
  test('flags an import-equals require of the forbidden package in shipped source', () => {
    const source = `import virtualizer = require('${FORBIDDEN_SPECIFIER}');`;
    const violations = findDependencyViolations(source, 'virtual-list.ts', new Set());

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe(FORBIDDEN_SPECIFIER);
    expect(violations[0]?.reason).toEqual(expect.stringContaining('@tanstack/virtual-core'));
  });

  test('flags an import-equals require of an undeclared package in shipped source', () => {
    const source = "import helper = require('some-dev-only-package');";
    const violations = findDependencyViolations(source, 'virtual-list.ts', new Set());

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('some-dev-only-package');
  });

  test('allows an import-equals require of a devDependency in a TEST file', () => {
    const source = "import testing = require('@testing-library/svelte');";
    expect(findDependencyViolations(source, 'virtual-list.test.ts', new Set())).toEqual([]);
  });

  test('still bans the forbidden package via import-equals require in a TEST file', () => {
    const source = `import virtualizer = require('${FORBIDDEN_SPECIFIER}');`;
    const violations = findDependencyViolations(source, 'virtual-list.test.ts', new Set());

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe(FORBIDDEN_SPECIFIER);
  });

  test('does not flag an import-equals ALIAS of an internal namespace, only the external module form', () => {
    const source = 'namespace Foo {\n  export const value = 1;\n}\nimport Bar = Foo;';
    expect(findDependencyViolations(source, 'virtual-list.ts', new Set())).toEqual([]);
  });
});

describe('findDependencyViolations — treatAsTestFile override (CIN-522)', () => {
  test('treatAsTestFile: true exempts an undeclared bare import even though the filename does not match TEST_FILE_PATTERN', () => {
    const source = "import leftPad from 'left-pad';";
    const violations = findDependencyViolations(source, 'happy-dom.ts', new Set(), {
      treatAsTestFile: true,
    });
    expect(violations).toEqual([]);
  });

  test('treatAsTestFile: false applies the full rule even though the filename matches TEST_FILE_PATTERN', () => {
    const source = "import leftPad from 'left-pad';";
    const violations = findDependencyViolations(source, 'virtual-list.test.ts', new Set(), {
      treatAsTestFile: false,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('left-pad');
  });

  test('omitting the fourth argument entirely behaves exactly like the original three-argument call', () => {
    const source = "import leftPad from 'left-pad';";
    expect(findDependencyViolations(source, 'virtual-list.test.ts', new Set())).toEqual([]);
    expect(findDependencyViolations(source, 'virtual-list.ts', new Set())).toHaveLength(1);
  });
});

describe('walkDependencyGraph — transitive relative import following (CIN-522)', () => {
  test('flags an undeclared bare import reached through a relative hop from a production (non-test) root', async () => {
    await withTemporaryFileTree(
      {
        'entry.ts': "import { helper } from './hop/target.ts';\nexport { helper };\n",
        'hop/target.ts': "import leftPad from 'left-pad';\nexport const helper = leftPad;\n",
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'entry.ts')], new Set());

        expect(result.scannedFilePaths).toContain(join(root, 'hop', 'target.ts'));
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.filePath).toBe(join(root, 'hop', 'target.ts'));
        expect(result.violations[0]?.specifier).toBe('left-pad');
      },
    );
  });

  test('does not flag an undeclared bare import reached ONLY through a relative hop from a test root', async () => {
    await withTemporaryFileTree(
      {
        'entry.test.ts': "import { setup } from './hop/test-helper.ts';\nsetup();\nexport {};\n",
        'hop/test-helper.ts':
          "import leftPad from 'left-pad';\nexport function setup(): void {\n  void leftPad;\n}\n",
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'entry.test.ts')], new Set());

        expect(result.scannedFilePaths).toContain(join(root, 'hop', 'test-helper.ts'));
        expect(result.violations).toEqual([]);
      },
    );
  });

  test('flags the forbidden package reached through a relative hop from a production (non-test) root', async () => {
    await withTemporaryFileTree(
      {
        'entry.ts': "import { helper } from './hop/target.ts';\nexport { helper };\n",
        'hop/target.ts': `import { createVirtualizer } from '${FORBIDDEN_SPECIFIER}';\nexport const helper = createVirtualizer;\n`,
      },
      async (root) => {
        const declared = new Set([FORBIDDEN_SPECIFIER]);
        const result = await walkDependencyGraph([join(root, 'entry.ts')], declared);

        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.specifier).toBe(FORBIDDEN_SPECIFIER);
      },
    );
  });

  test('still flags the forbidden package reached through a relative hop from a test root', async () => {
    await withTemporaryFileTree(
      {
        'entry.test.ts': "import { setup } from './hop/test-helper.ts';\nsetup();\nexport {};\n",
        'hop/test-helper.ts': `import { createVirtualizer } from '${FORBIDDEN_SPECIFIER}';\nexport function setup(): void {\n  void createVirtualizer;\n}\n`,
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'entry.test.ts')], new Set());

        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.specifier).toBe(FORBIDDEN_SPECIFIER);
      },
    );
  });

  test('reports a relative import that does not resolve to a file on disk, instead of throwing', async () => {
    await withTemporaryFileTree(
      { 'entry.ts': "import { missing } from './does-not-exist.ts';\nexport { missing };\n" },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'entry.ts')], new Set());

        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.specifier).toBe('./does-not-exist.ts');
        expect(result.violations[0]?.reason).toEqual(expect.stringContaining('does not resolve'));
      },
    );
  });

  test('terminates on a two-file import cycle instead of looping forever', async () => {
    await withTemporaryFileTree(
      {
        'a.ts': "import './b.ts';\nexport const a = 1;\n",
        'b.ts': "import './a.ts';\nexport const b = 2;\n",
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'a.ts')], new Set());

        expect(result.scannedFilePaths.toSorted()).toEqual(
          [join(root, 'a.ts'), join(root, 'b.ts')].toSorted(),
        );
        expect(result.violations).toEqual([]);
      },
    );
  });

  test('classifies a file reachable from BOTH a production root and a test root as shipped', async () => {
    await withTemporaryFileTree(
      {
        'production-entry.ts': "import { shared } from './shared.ts';\nexport { shared };\n",
        'test-entry.test.ts': "import { shared } from './shared.ts';\nvoid shared;\nexport {};\n",
        'shared.ts': "import leftPad from 'left-pad';\nexport const shared = leftPad;\n",
      },
      async (root) => {
        const roots = [join(root, 'production-entry.ts'), join(root, 'test-entry.test.ts')];
        const result = await walkDependencyGraph(roots, new Set());

        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.filePath).toBe(join(root, 'shared.ts'));
        expect(result.violations[0]?.specifier).toBe('left-pad');
      },
    );
  });

  test('resolves an extensionless relative hop end to end through the walker', async () => {
    await withTemporaryFileTree(
      {
        'entry.ts': "import { helper } from './hop/target';\nexport { helper };\n",
        'hop/target.ts': "import leftPad from 'left-pad';\nexport const helper = leftPad;\n",
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'entry.ts')], new Set());

        expect(result.scannedFilePaths).toContain(join(root, 'hop', 'target.ts'));
        expect(result.violations).toHaveLength(1);
      },
    );
  });
});

describe('walkDependencyGraph — real virtual-list tree (CIN-522)', () => {
  test('walking from the real collectScanTargets() finds no violations', async () => {
    const declaredDependencyNames = await loadDeclaredDependencyNames();
    const rootFilePaths = await collectScanTargets();
    const result = await walkDependencyGraph(rootFilePaths, declaredDependencyNames);

    expect(result.violations).toEqual([]);
    expect(result.scannedFilePaths.length).toBeGreaterThan(rootFilePaths.length);
  });

  test('does not rely on the deleted local happy-dom helper', async () => {
    const declaredDependencyNames = await loadDeclaredDependencyNames();
    const rootFilePaths = await collectScanTargets();
    const result = await walkDependencyGraph(rootFilePaths, declaredDependencyNames);

    const localHappyDomFilePath = result.scannedFilePaths.find((filePath) =>
      filePath.endsWith(join('test', 'happy-dom.ts')),
    );
    expect(localHappyDomFilePath).toBeUndefined();
    expect(result.violations).toEqual([]);
  });
});

describe('the guard follows JavaScript helpers, not only TypeScript ones', () => {
  test('reports a forbidden import reached through a relative .js helper', async () => {
    await withTemporaryFileTree(
      {
        'engine.ts': "import './helper.js';\n",
        'helper.js': "import '@tanstack/virtual-core';\n",
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'engine.ts')], new Set());
        expect(result.violations.map((violation) => violation.specifier)).toContain(
          '@tanstack/virtual-core',
        );
        expect(
          result.violations.some((violation) => violation.filePath.endsWith('helper.js')),
        ).toBe(true);
      },
    );
  });

  test('follows .mjs and .cjs helpers too', async () => {
    for (const extension of ['mjs', 'cjs']) {
      await withTemporaryFileTree(
        {
          'engine.ts': `import './helper.${extension}';\n`,
          [`helper.${extension}`]: "import 'undeclared-package';\n",
        },
        async (root) => {
          const result = await walkDependencyGraph([join(root, 'engine.ts')], new Set());
          expect(result.violations.map((violation) => violation.specifier)).toContain(
            'undeclared-package',
          );
        },
      );
    }
  });

  test('scans a JavaScript helper rather than merely resolving it', async () => {
    await withTemporaryFileTree(
      {
        'engine.ts': "import './helper.js';\n",
        'helper.js': '',
      },
      async (root) => {
        const result = await walkDependencyGraph([join(root, 'engine.ts')], new Set());
        expect(result.scannedFilePaths.some((path) => path.endsWith('helper.js'))).toBe(true);
      },
    );
  });
});
