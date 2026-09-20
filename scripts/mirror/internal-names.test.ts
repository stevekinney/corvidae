import { describe, expect, test } from 'bun:test';

import {
  InternalNameError,
  publicSpecifierFor,
  rewriteEmittedSource,
  rewriteInternalSpecifiers,
} from './internal-names.ts';
import { isInternalSpecifier } from './source-escapes.ts';

/** The names `package-map.json` assigns the workspaces these fixtures name. */
const publicNames: ReadonlyMap<string, string> = new Map([
  ['@corvidae/armorer', '@lostgradient/armorer'],
  ['@corvidae/markdown', '@lostgradient/markdown'],
  ['@corvidae/operative', '@lostgradient/operative'],
  ['@corvidae/weft', '@lostgradient/weft'],
]);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe('what counts as an internal name', () => {
  test('the scope, a workspace under it, and a subpath into one', () => {
    expect(isInternalSpecifier('@corvidae/weft')).toBe(true);
    expect(isInternalSpecifier('@corvidae/weft/client')).toBe(true);
    expect(isInternalSpecifier('@corvidae')).toBe(true);
    expect(isInternalSpecifier('@lostgradient/weft')).toBe(false);
    expect(isInternalSpecifier('@corvidaemonium/weft')).toBe(false);
    expect(isInternalSpecifier('./corvidae/weft.ts')).toBe(false);
  });

  test('a subpath is carried through to the public name unchanged', () => {
    expect(publicSpecifierFor('@corvidae/weft', publicNames, 'fixture.ts')).toBe(
      '@lostgradient/weft',
    );
    expect(publicSpecifierFor('@corvidae/weft/client', publicNames, 'fixture.ts')).toBe(
      '@lostgradient/weft/client',
    );
    expect(
      publicSpecifierFor('@corvidae/operative/backend/descriptors', publicNames, 'fixture.ts'),
    ).toBe('@lostgradient/operative/backend/descriptors');
  });

  test('a name the map does not carry fails, naming the file and the workspace', () => {
    expect(() =>
      publicSpecifierFor('@corvidae/ghost', publicNames, 'packages/weft/src/a.ts'),
    ).toThrow(InternalNameError);
    try {
      publicSpecifierFor('@corvidae/ghost', publicNames, 'packages/weft/src/a.ts');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('packages/weft/src/a.ts');
      expect(message).toContain('@corvidae/ghost');
      expect(message).toContain('package-map.json');
    }
  });
});

describe('rewriting one file', () => {
  /**
   * Every form corvidae's emitted source actually uses, plus the three it does not use today but
   * that the same walk reaches — `export … from`, `export type … from` and `import … = require`.
   * The last two lines are the control: a string that merely contains a package name is data, and
   * a transform that rewrote it would be corrupting a runtime registry key.
   */
  test('every specifier form, and nothing that only looks like one', () => {
    const source = [
      "import { a } from '@corvidae/weft';",
      "import type { B } from '@corvidae/weft';",
      "export * from '@corvidae/armorer';",
      "export type { C } from '@corvidae/armorer';",
      "const d = await import('@corvidae/markdown');",
      "type E = import('@corvidae/weft').Engine;",
      "const f = import.meta.resolve('@corvidae/weft');",
      "const g = require('@corvidae/armorer');",
      "import h = require('@corvidae/weft');",
      "declare module '@corvidae/weft' { interface WorkflowRegistry { a: 1 } }",
      "import { sub } from '@corvidae/weft/client';",
      "const key = Symbol.for('@corvidae/operative/backend-descriptors');",
      '// See the docs for @corvidae/weft.',
    ].join('\n');
    expect(rewriteInternalSpecifiers(source, 'packages/weft/src/index.ts', publicNames)).toBe(
      [
        "import { a } from '@lostgradient/weft';",
        "import type { B } from '@lostgradient/weft';",
        "export * from '@lostgradient/armorer';",
        "export type { C } from '@lostgradient/armorer';",
        "const d = await import('@lostgradient/markdown');",
        "type E = import('@lostgradient/weft').Engine;",
        "const f = import.meta.resolve('@lostgradient/weft');",
        "const g = require('@lostgradient/armorer');",
        "import h = require('@lostgradient/weft');",
        "declare module '@lostgradient/weft' { interface WorkflowRegistry { a: 1 } }",
        "import { sub } from '@lostgradient/weft/client';",
        "const key = Symbol.for('@corvidae/operative/backend-descriptors');",
        '// See the docs for @corvidae/weft.',
      ].join('\n'),
    );
  });

  test('a Svelte component’s script blocks and its markup are both rewritten', () => {
    const component = [
      '<script module lang="ts">',
      "  import { registry } from '@corvidae/armorer';",
      '</script>',
      '<script lang="ts">',
      "  import { render } from '@corvidae/markdown';",
      "  import Child from './child.svelte';",
      '</script>',
      "{#await import('@corvidae/weft') then weft}{weft.version}{/await}",
      '<Child {registry} {render} />',
    ].join('\n');
    expect(
      rewriteInternalSpecifiers(component, 'packages/chat/src/widget.svelte', publicNames),
    ).toBe(
      [
        '<script module lang="ts">',
        "  import { registry } from '@lostgradient/armorer';",
        '</script>',
        '<script lang="ts">',
        "  import { render } from '@lostgradient/markdown';",
        "  import Child from './child.svelte';",
        '</script>',
        "{#await import('@lostgradient/weft') then weft}{weft.version}{/await}",
        '<Child {registry} {render} />',
      ].join('\n'),
    );
  });

  /**
   * The form the Svelte-AST walk alone could not see. `markdown-editor.svelte` writes
   * `Pick<typeof import('@corvidae/markdown'), …>` in a type position: a `TSImportType`, not an
   * ESTree `ImportDeclaration`, and TS2307 downstream exactly like a plain import. The `<script>`
   * block's own text is handed to the TypeScript walk for this reason, which brings `declare
   * module` and `import.meta.resolve()` inside a component into scope with it.
   */
  test('a type-position `import()` inside a Svelte script is rewritten too', () => {
    const component = [
      '<script lang="ts">',
      "  import { render } from '@corvidae/markdown';",
      "  type Utilities = Pick<typeof import('@corvidae/markdown'), 'normalize'>;",
      "  const where = import.meta.resolve('@corvidae/armorer');",
      '  let utilities: Utilities | undefined;',
      '</script>',
      '<span>{render}{where}{utilities}</span>',
    ].join('\n');
    expect(
      rewriteInternalSpecifiers(component, 'packages/editor/src/editor.svelte', publicNames),
    ).toBe(
      [
        '<script lang="ts">',
        "  import { render } from '@lostgradient/markdown';",
        "  type Utilities = Pick<typeof import('@lostgradient/markdown'), 'normalize'>;",
        "  const where = import.meta.resolve('@lostgradient/armorer');",
        '  let utilities: Utilities | undefined;',
        '</script>',
        '<span>{render}{where}{utilities}</span>',
      ].join('\n'),
    );
  });

  test('a double-quoted specifier keeps its quotes; only the name between them changes', () => {
    expect(
      rewriteInternalSpecifiers(
        'import { a } from "@corvidae/weft";\n',
        'packages/weft/src/a.ts',
        publicNames,
      ),
    ).toBe('import { a } from "@lostgradient/weft";\n');
  });

  test('two specifiers on one line are both rewritten, longest offset first', () => {
    expect(
      rewriteInternalSpecifiers(
        "const both = [import('@corvidae/weft'), import('@corvidae/armorer')];\n",
        'packages/weft/src/a.ts',
        publicNames,
      ),
    ).toBe("const both = [import('@lostgradient/weft'), import('@lostgradient/armorer')];\n");
  });

  test('an unmapped name in a real import fails the rewrite rather than passing through', () => {
    expect(() =>
      rewriteInternalSpecifiers(
        "import { a } from '@corvidae/ghost';\n",
        'packages/weft/src/a.ts',
        publicNames,
      ),
    ).toThrow(InternalNameError);
  });
});

describe('rewriting one emitted file’s bytes', () => {
  test('a file with no internal name is returned as the identical byte array', () => {
    const contents = encoder.encode("import { a } from './a.ts';\n");
    expect(rewriteEmittedSource(contents, 'packages/weft/src/a.ts', publicNames)).toBe(contents);
  });

  test('a file whose language carries no specifiers is never parsed', () => {
    // A PNG's bytes are not text, and a Markdown file's `@corvidae/*` is prose. Both come back
    // byte-identical, which is what keeps the transform from corrupting either.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(rewriteEmittedSource(png, 'packages/testing/src/baseline.png', publicNames)).toBe(png);
    const markdown = encoder.encode('Install `@corvidae/weft` from the workspace.\n');
    expect(rewriteEmittedSource(markdown, 'packages/weft/src/README.md', publicNames)).toBe(
      markdown,
    );
  });

  test('a file that does carry one comes back rewritten', () => {
    const contents = encoder.encode("import { Engine } from '@corvidae/weft';\n");
    expect(
      decoder.decode(rewriteEmittedSource(contents, 'packages/weft/src/a.ts', publicNames)),
    ).toBe("import { Engine } from '@lostgradient/weft';\n");
  });
});
