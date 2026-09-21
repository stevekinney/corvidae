import { describe, expect, test } from 'bun:test';

import {
  InternalNameError,
  publicNameInProse,
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

describe('an internal name a comment mentions', () => {
  /**
   * The defect this pass exists for.
   *
   * The specifier walk is blind to comments, so every `@example` in the emitted weft target told
   * a consumer to import from `@corvidae/weft`. The target compiles those examples against the
   * package's public face in `verify:jsdoc:doctests`, and 907 of 1,021 manifest entries failed on
   * a name that resolves nowhere downstream.
   */
  test('an `@example` import is rewritten, root face and subpath face alike', () => {
    const source = [
      '/**',
      ' * @example',
      " * import { start } from '@corvidae/weft';",
      " * import { harness } from '@corvidae/weft/storage/testing';",
      ' */',
      'export const start = 1;',
      '',
    ].join('\n');
    const rewritten = decoder.decode(
      rewriteEmittedSource(encoder.encode(source), 'packages/weft/src/index.ts', publicNames),
    );
    expect(rewritten).toContain("import { start } from '@lostgradient/weft';");
    expect(rewritten).toContain("import { harness } from '@lostgradient/weft/storage/testing';");
    expect(rewritten).not.toContain('@corvidae/');
  });

  test('prose outside an example is rewritten too, since hover documentation shows it', () => {
    const source = [
      '/** Documented in `@corvidae/weft`, and re-exported from @corvidae/weft/client. */',
      '// Run `bun run --filter=@corvidae/weft test` first.',
      'export const value = 1;',
      '',
    ].join('\n');
    const rewritten = decoder.decode(
      rewriteEmittedSource(encoder.encode(source), 'packages/weft/src/value.ts', publicNames),
    );
    expect(rewritten).toContain('`@lostgradient/weft`');
    expect(rewritten).toContain('@lostgradient/weft/client.');
    expect(rewritten).toContain('--filter=@lostgradient/weft');
  });

  /**
   * Two of these exist in the emitted weft target — a `describe()` name and an error message that
   * interpolates the package name — and both are corvidae's own statements about corvidae. A
   * transform that rewrites a string because it looks like a package name corrupts data.
   */
  test('a name inside a string literal is left exactly as it is', () => {
    const source = [
      "describe('@corvidae/weft barrel re-exports', () => {});",
      'const message = `Failed to build @corvidae/weft for browser`;',
      "const symbol = Symbol.for('@corvidae/operative/backend-descriptors');",
      '',
    ].join('\n');
    const rewritten = decoder.decode(
      rewriteEmittedSource(encoder.encode(source), 'packages/weft/src/barrel.test.ts', publicNames),
    );
    expect(rewritten).toBe(source);
  });

  test('a name the map does not know is left alone in prose, where a specifier throws', () => {
    const source = [
      '/** Internal only: @corvidae/typescript carries the shared options. */',
      '',
    ].join('\n');
    const rewritten = decoder.decode(
      rewriteEmittedSource(encoder.encode(source), 'packages/weft/src/notes.ts', publicNames),
    );
    expect(rewritten).toContain('@corvidae/typescript');
    expect(() =>
      rewriteInternalSpecifiers(
        "import '@corvidae/typescript';\n",
        'packages/weft/src/notes.ts',
        publicNames,
      ),
    ).toThrow(InternalNameError);
  });

  test('sentence punctuation is trimmed before the map is asked, and put back after', () => {
    expect(publicNameInProse('@corvidae/weft', publicNames)).toBe('@lostgradient/weft');
    expect(publicNameInProse('@corvidae/weft.', publicNames)).toBe('@lostgradient/weft.');
    expect(publicNameInProse('@corvidae/weft/storage.', publicNames)).toBe(
      '@lostgradient/weft/storage.',
    );
    expect(publicNameInProse('@corvidae/absent', publicNames)).toBeUndefined();
  });

  /**
   * The documents weft's protocol suite reads ship downstream, and the target extracts fenced
   * TypeScript out of them and compiles it. A fence is documentation the same way an `@example`
   * is, so a Markdown file has nothing to protect: prose and fence alike are rewritten.
   */
  test('a Markdown document is rewritten in its prose and inside its fences', () => {
    const source = [
      '# Remote workers',
      '',
      'The public contract is exported from `@corvidae/weft`, and the storage harness from',
      '`@corvidae/weft/storage/testing`.',
      '',
      '```ts',
      "import { RemoteWorker } from '@corvidae/weft';",
      '```',
      '',
    ].join('\n');
    const rewritten = decoder.decode(
      rewriteEmittedSource(
        encoder.encode(source),
        'packages/weft/documentation/guides/remote-workers.md',
        publicNames,
      ),
    );
    expect(rewritten).toContain('`@lostgradient/weft`');
    expect(rewritten).toContain('`@lostgradient/weft/storage/testing`');
    expect(rewritten).toContain("import { RemoteWorker } from '@lostgradient/weft';");
    expect(rewritten).not.toContain('@corvidae/');
  });

  test('a Markdown document naming an unmapped workspace is left exactly as it is', () => {
    const source = '# Notes\n\nThe shared options live in `@corvidae/typescript`.\n';
    const rewritten = decoder.decode(
      rewriteEmittedSource(
        encoder.encode(source),
        'packages/weft/documentation/notes.md',
        publicNames,
      ),
    );
    expect(rewritten).toBe(source);
  });

  test('a comment inside a Svelte script is rewritten and its markup is not', () => {
    const source = [
      '<script lang="ts">',
      '  // Pair this with `@corvidae/markdown` for the full pipeline.',
      "  const label = '@corvidae/markdown';",
      '</script>',
      '',
      '<p>Run <code>bun add @corvidae/markdown</code> to install.</p>',
      '',
    ].join('\n');
    const rewritten = decoder.decode(
      rewriteEmittedSource(
        encoder.encode(source),
        'packages/chat/src/lib/thing.svelte',
        publicNames,
      ),
    );
    expect(rewritten).toContain('Pair this with `@lostgradient/markdown`');
    expect(rewritten).toContain("const label = '@corvidae/markdown';");
    expect(rewritten).toContain('<code>bun add @corvidae/markdown</code>');
  });
});

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

  test('a file whose language carries no specifiers is never parsed for them', () => {
    // A PNG's bytes are not text, so nothing here reads them at all. A Markdown file is text and
    // is documentation throughout, so it takes the prose pass — but never the specifier pass,
    // which would try to parse a document as TypeScript. This test used to assert that Markdown
    // came back untouched; the emitted weft documents shipped `@corvidae/weft` downstream to a
    // reader and to the target's markdown doctest extractor, which is what changed the ruling.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(rewriteEmittedSource(png, 'packages/testing/src/baseline.png', publicNames)).toBe(png);
    const markdown = encoder.encode('Install `@corvidae/weft` from the workspace.\n');
    expect(
      decoder.decode(rewriteEmittedSource(markdown, 'packages/weft/src/README.md', publicNames)),
    ).toBe('Install `@lostgradient/weft` from the workspace.\n');
    const untranslatable = encoder.encode('Install `@corvidae/typescript`.\n');
    expect(rewriteEmittedSource(untranslatable, 'packages/weft/src/README.md', publicNames)).toBe(
      untranslatable,
    );
  });

  test('a file that does carry one comes back rewritten', () => {
    const contents = encoder.encode("import { Engine } from '@corvidae/weft';\n");
    expect(
      decoder.decode(rewriteEmittedSource(contents, 'packages/weft/src/a.ts', publicNames)),
    ).toBe("import { Engine } from '@lostgradient/weft';\n");
  });
});
