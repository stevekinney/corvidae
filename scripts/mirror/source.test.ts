import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';
import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import { committedPlans, corvidaeRoot } from './committed-plans.ts';
import {
  diffReviewStateExports,
  findBareRootComponentImport,
  publicComponentSymbols,
  rewritePublishedComponentExamples,
  rewritePublishedComponentReadme,
} from './component-example-imports.ts';
import { findInternalReadmeMarker } from './packaging.ts';
import {
  additionalSourceRoots,
  applyVersionConstants,
  assertSingleOwner,
  collectPrunablePaths,
  isSourceFile,
  planSource,
  SourceEmissionError,
  validationInputs,
  versionConstants,
} from './source.ts';
import { planSurface } from './surface.ts';
import { type MirrorTarget } from './target-definitions.ts';
import { loadTargetOwnedPolicy, writeTransformOutput } from './target-owned.ts';

const licence = 'MIT License\n\nCopyright (c) 2026 Steve Kinney\n';

test('published component examples use their component subpaths under browser conditions', async () => {
  const { plan } = committedPlans.cinder;
  for (const [workspace, components] of [
    [
      'chat',
      [
        'chat-composer-popover',
        'chat-conversation-header',
        'chat-conversation-list',
        'chat-navigation-rail',
        'chat-sub-session',
      ],
    ],
    [
      'editor',
      ['diff-review', 'diff-review-comments', 'diff-viewer', 'markdown-editor', 'review-editor'],
    ],
  ] as const) {
    const internalManifest = await Bun.file(
      join(corvidaeRoot, 'components', workspace, 'package.json'),
    ).json();
    expect(internalManifest.exports).toEqual({ '.': './src/index.ts' });
    const manifestContents = plan.files[`packages/${workspace}/package.json`];
    expect(manifestContents).toBeDefined();
    const emittedManifest = JSON.parse(
      typeof manifestContents === 'string'
        ? manifestContents
        : new TextDecoder().decode(manifestContents),
    );
    for (const component of components) {
      const subpath = workspace === 'chat' ? component.replace(/^chat-/, '') : component;
      const specifier = `@lostgradient/${workspace}/${subpath}`;
      const emitted =
        plan.source.files[
          `packages/${workspace}/src/lib/components/${component}/${component}.examples.json`
        ];
      expect(emitted).toBeDefined();
      const examples = JSON.parse(
        typeof emitted === 'string' ? emitted : new TextDecoder().decode(emitted),
      );
      expect(emittedManifest.exports[`./${subpath}`]).toBeDefined();
      expect(examples.import).toBe(specifier);
      for (const example of examples.examples) {
        expect(example.code).toContain(`from '${specifier}'`);
        if (
          workspace === 'editor' &&
          (component === 'diff-review' || component === 'diff-review-comments')
        ) {
          expect(example.code).toContain("from '@lostgradient/editor/diff-review-state'");
          expect(example.code).not.toMatch(
            /import(?: type)?\s*\{[^}]*\b(?:createDiffReviewState|reduceDiffReviewState|DiffReviewTargetInput)\b[^}]*\}\s*from\s*'@lostgradient\/editor'/,
          );
        }
      }
    }
  }
});

test('a new public component example refuses emission until its subpath is declared', () => {
  const path = 'packages/chat/src/lib/components/chat-new-panel/chat-new-panel.examples.json';
  const source = new TextEncoder().encode(
    JSON.stringify({ component: 'chat-new-panel', import: '@lostgradient/chat', examples: [] }),
  );
  expect(() => rewritePublishedComponentExamples(source, path)).toThrow('declared subpath');
});

test('published component examples retain multiline imports while routing public types', () => {
  const source = new TextEncoder().encode(
    JSON.stringify({
      component: 'review-editor',
      import: '@lostgradient/editor',
      examples: [
        {
          code: '<script lang="ts">\n  import {\n    ReviewEditor,\n    type Thread,\n  } from \'@lostgradient/editor\';\n</script>\n',
        },
      ],
    }),
  );
  const output = rewritePublishedComponentExamples(
    source,
    'packages/editor/src/lib/components/review-editor/review-editor.examples.json',
  );
  const published = JSON.parse(new TextDecoder().decode(output));
  expect(published.import).toBe('@lostgradient/editor/review-editor');
  expect(published.examples[0].code).toContain(
    "import {\n    ReviewEditor,\n    type Thread,\n  } from '@lostgradient/editor/review-editor';",
  );
});

// COR-1446: the target's package build copies every emitted component README into
// `dist/components/<name>/README.md`, so what the mirror emits here is what npm ships.
test('emitted Chat and Editor component READMEs carry no internal marker and no bare-root component import', () => {
  const { plan } = committedPlans.cinder;
  const readmes = Object.entries(plan.source.files).filter(([path]) =>
    /^packages\/(?:chat|editor)\/src\/lib\/components\/[^/]+\/README\.md$/.test(path),
  );
  expect(readmes.length).toBeGreaterThanOrEqual(11);
  for (const [path, contents] of readmes) {
    const workspace = path.startsWith('packages/chat/') ? 'chat' : 'editor';
    const text = new TextDecoder().decode(contents);
    expect({ path, marker: findInternalReadmeMarker(text) }).toEqual({ path, marker: undefined });
    expect({
      path,
      bareRootImport: findBareRootComponentImport(
        text,
        `@lostgradient/${workspace}`,
        publicComponentSymbols(workspace),
      ),
    }).toEqual({ path, bareRootImport: undefined });
  }
  const markdownEditor = new TextDecoder().decode(
    plan.source.files['packages/editor/src/lib/components/markdown-editor/README.md'] ??
      new Uint8Array(),
  );
  expect(markdownEditor).toContain(
    "import { MarkdownEditor } from '@lostgradient/editor/markdown-editor';",
  );
});

const readmePath = 'packages/editor/src/lib/components/review-editor/README.md';

function rewriteReadme(markdown: string, path = readmePath): string {
  return new TextDecoder().decode(
    rewritePublishedComponentReadme(new TextEncoder().encode(markdown), path),
  );
}

test('a published component README routes fenced imports to their subpaths and keeps root exports', () => {
  const markdown = [
    '# ReviewEditor',
    '',
    "Prose naming `import { toPersistedThreads } from '@lostgradient/editor'` is left alone.",
    '',
    '```svelte',
    '<script lang="ts">',
    "  import { ReviewEditor, toRuntimeThreads } from '@lostgradient/editor';",
    "  import type { ReviewState, Thread } from '@lostgradient/editor';",
    "  import { createDiffReviewState } from '@lostgradient/editor';",
    "  import type { DiffReviewState } from '@lostgradient/editor';",
    '</script>',
    '```',
    '',
  ].join('\n');
  const published = rewriteReadme(markdown);
  expect(published).toContain(
    "Prose naming `import { toPersistedThreads } from '@lostgradient/editor'` is left alone.",
  );
  expect(published).toContain(
    "  import { ReviewEditor } from '@lostgradient/editor/review-editor';",
  );
  expect(published).toContain("  import { toRuntimeThreads } from '@lostgradient/editor';");
  expect(published).toContain("  import type { ReviewState } from '@lostgradient/editor';");
  expect(published).toContain(
    "  import type { Thread } from '@lostgradient/editor/review-editor';",
  );
  expect(published).toContain(
    "  import type { DiffReviewState } from '@lostgradient/editor/diff-review-state';",
  );
  expect(published).toContain(
    "  import { createDiffReviewState } from '@lostgradient/editor/diff-review-state';",
  );
});

test('a published Chat component README rewrites multiline fenced imports', () => {
  const published = rewriteReadme(
    "```ts\nimport {\n  ChatSubSession,\n  createConversation,\n} from '@lostgradient/chat';\n```\n",
    'packages/chat/src/lib/components/chat-sub-session/README.md',
  );
  expect(published).toContain("import { ChatSubSession } from '@lostgradient/chat/sub-session';");
  expect(published).toContain("import { createConversation } from '@lostgradient/chat';");
});

test('a published component README that still carries an internal marker refuses emission', () => {
  expect(() =>
    rewriteReadme('Declare `"@lostgradient/editor": "workspace:*"` in the consuming workspace.\n'),
  ).toThrow('workspace:*');
  expect(() => rewriteReadme('Run it from the Corvidae root.\n')).toThrow('Corvidae');
});

test('a published component README that imports a component from the root outside a fence refuses emission', () => {
  expect(() => rewriteReadme("    import { ReviewEditor } from '@lostgradient/editor';\n")).toThrow(
    'bare @lostgradient/editor root',
  );
});

test('the diff-review-state symbol map names every non-fixture export of that module', async () => {
  const source = await Bun.file(
    join(corvidaeRoot, 'components/editor/src/lib/diff-review-state/index.ts'),
  ).text();
  const exported = [...source.matchAll(/^export (?:type )?\{([^}]+)\} from '\.\/([^']+)';$/gm)]
    .filter(([, , module]) => module !== 'fixtures.js')
    .flatMap(([, names]) => (names ?? '').split(','))
    .map((name) => name.trim())
    .filter(Boolean);
  expect(exported.length).toBeGreaterThan(30);
  expect(exported.toSorted()).toEqual([...diffReviewStateExports].toSorted());
});

test('README rewriting touches only Chat and Editor component READMEs', () => {
  const internal = 'Run it from the Corvidae root.\n';
  for (const path of [
    'packages/editor/README.md',
    'packages/components/src/components/button/README.md',
    'packages/editor/src/lib/components/review-editor/notes.md',
  ]) {
    expect(rewriteReadme(internal, path)).toBe(internal);
  }
});

/** Stand up a throwaway tree, hand it to the body, and remove it however the body ends. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-source-'));
  try {
    for (const [path, contents] of Object.entries(files))
      await Bun.write(join(root, path), contents);
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const editorWorkspace = {
  workspace: '@lostgradient/editor',
  corvidaeDirectory: 'components/editor',
  targetDirectory: 'packages/editor',
} as const;

/**
 * Every path `@lostgradient/weft` declares, from both tables.
 *
 * Built from the tables rather than written out because a declared file corvidae does not carry
 * is a refusal: a fixture that hard-codes the list has to be edited every time an entry is added,
 * which it twice was, and the edit is noise in a test about something else.
 */
const weftDeclarations: readonly string[] = [
  ...(additionalSourceRoots['@lostgradient/weft'] ?? []).flatMap((cluster) => cluster.paths),
  ...(validationInputs['@lostgradient/weft'] ?? []).flatMap((cluster) => cluster.paths),
];

/** Those declarations as fixture files, minus whichever the caller wants missing. */
function weftDeclarationFixture(omitted?: string): Record<string, string> {
  return Object.fromEntries(
    weftDeclarations
      .filter((path) => path !== omitted)
      .map((path) => [`packages/weft/${path}`, `// ${path}\n`]),
  );
}

/**
 * `@lostgradient/weft-ui`'s `bunfig.toml` preloads `tests/setup.ts` (`preload =
 * ["./tests/setup.ts"]`), which is where the `declare module 'bun:test'` augmentation adding
 * `@testing-library/jest-dom`'s matchers to `expect(...)` lives. Every one of the twenty-six
 * `src/routes/` suites that calls a jest-dom matcher (`toBeInTheDocument`, and
 * friends) type-checks against that augmentation, but `tests/setup.ts` was never declared in
 * `additionalSourceRoots['@lostgradient/weft-ui']` — only its sibling `tests/dom-test-support.ts`
 * was — so the file never shipped to the cinder target, and the target's own
 * `typecheck-private` step for weft-ui failed with six `Property 'toBeInTheDocument' does not
 * exist on type 'Assertion<...>'`-shaped errors, one per matcher call site the augmentation would
 * otherwise cover.
 */
describe('weft-ui’s bun:test preload ships with its source', () => {
  test('the real cinder plan emits tests/setup.ts', () => {
    const { plan } = committedPlans.cinder;
    expect(Object.keys(plan.files)).toContain('packages/weft-ui/tests/setup.ts');
  });
});

describe('the documents a workspace declares', () => {
  test('Cinder emits the documents its source tests read and the linked seam audit', () => {
    const emitted = new Set(Object.keys(committedPlans.cinder.plan.files));
    for (const path of [
      'documentation/tokens.md',
      'documentation/focus-ring-policy.md',
      'documentation/theming.md',
      'documentation/css-audit/translucent-border-seams.md',
    ]) {
      expect(emitted.has(`packages/components/${path}`)).toBe(true);
    }
  });

  /**
   * The declared set has to be closed under links, which is a fourth kind of edge and the third
   * one no gate here sees.
   *
   * Four documents were declared because `protocol.test.ts` reads them; two of the four link to a
   * fifth that was not declared and that the target does not carry, so a sync turned two working
   * links into broken ones and the target's own `scripts/verify-documentation.ts` failed — one
   * sync downstream of the change that caused it. This asserts the closure here instead.
   *
   * Scoped to links between documents, because a link out of `documentation/` is a different
   * question: the architecture decision points at `../../../README.md`, which the transform does
   * not emit and the target has always carried, so it resolves there and is none of this set's
   * business.
   */
  test('every link between emitted documents lands on a document that is emitted', () => {
    const { plan } = committedPlans.weft;
    const emitted = new Set(Object.keys(plan.files));
    const dangling: string[] = [];
    for (const path of emitted) {
      if (!path.endsWith('.md') || !path.includes('/documentation/')) continue;
      const contents = plan.files[path];
      const text =
        typeof contents === 'string'
          ? contents
          : new TextDecoder().decode(contents ?? new Uint8Array());
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const href = match[1] ?? '';
        if (/^(?:https?:|mailto:|#)/.test(href)) continue;
        const relative = href.split('#')[0];
        if (relative === undefined || relative === '') continue;
        const resolved = normalize(join(dirname(path), relative));
        if (!resolved.includes('/documentation/') || !resolved.endsWith('.md')) continue;
        if (!emitted.has(resolved)) dangling.push(`${path} -> ${href}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});

describe('the files that check a workspace’s emitted source', () => {
  const declared = (validationInputs['@lostgradient/weft'] ?? []).flatMap(
    (cluster) => cluster.paths,
  );

  test('every declared path is emitted, all eleven of them', () => {
    // Against the real tree rather than a fixture, because the thing that can go wrong is a path
    // that no longer matches what corvidae carries, and a fixture would restate the table's own
    // strings back to itself.
    const { plan } = committedPlans.weft;
    const missing = declared.filter((path) => plan.files[`packages/weft/${path}`] === undefined);
    expect(missing).toEqual([]);
    expect(declared.length).toBe(11);
    // No gate script is declared any more: under COR-1286 the target runs none, and
    // `target-owned.json` retires its copies rather than emission replacing them.
    expect(declared.filter((path) => path.startsWith('scripts/check-'))).toEqual([]);
  });

  test('the generator family goes as a set, since its entry point imports the rest', () => {
    const family = declared.filter((path) => path.startsWith('scripts/operation-client-'));
    expect(family.length).toBe(9);
    expect(declared).toContain('scripts/generate-operation-client.ts');
  });

  test('a declared check corvidae no longer carries is a refusal, not a silent skip', async () => {
    const omitted = 'scripts/operation-client-schema.ts';
    await withTree(
      {
        'packages/weft/src/index.ts': 'export const weft = true;\n',
        ...weftDeclarationFixture(omitted),
      },
      async (root) => {
        const plan = planSource(root, [
          {
            workspace: '@lostgradient/weft',
            corvidaeDirectory: 'packages/weft',
            targetDirectory: 'packages/weft',
          },
        ]);
        expect(await throwingRejectionOf(plan)).toThrow(SourceEmissionError);
        expect(await throwingRejectionOf(plan)).toThrow(omitted);
        // Named so the message points at the table that has to change, not at the sibling one.
        expect(await throwingRejectionOf(plan)).toThrow('validationInputs');
      },
    );
  });
});

/**
 * COR-1196: cinder's artifact generator, declared under `validationInputs` because
 * `packages/components/scripts/build.ts` reaches it through a `bun run components:check`
 * shell-out — invisible to `assertNoSourceEscapes`'s import-specifier scan — rather than through
 * an import edge.
 */
describe('the files that check cinder’s emitted source', () => {
  const declared = (validationInputs['@lostgradient/cinder'] ?? []).flatMap(
    (cluster) => cluster.paths,
  );

  test('every declared path is emitted, all thirty-eight of them', () => {
    const { plan } = committedPlans.cinder;
    const missing = declared.filter(
      (path) => plan.files[`packages/components/${path}`] === undefined,
    );
    expect(missing).toEqual([]);
    // 23 before COR-1196's token-generator closure (7 files), preload (1 file),
    // and the four documents read by emitted token tests or linked from them.
    // Then three more for COR-491: the token runtime's catalogue serializer, base-corpus
    // metadata, and standalone schema-validator generators that `generate-artifacts.ts` imports.
    expect(declared.length).toBe(38);
  });

  test('the generator family goes as a set, since its entry point imports the rest', () => {
    expect(declared).toContain('scripts/generate-component-artifacts.ts');
    expect(declared).toContain('scripts/component-artifact-operations.ts');
    expect(declared).toContain('scripts/generate-manifest.ts');
    // Already emitted by `additionalSourceRoots`, so not repeated here.
    expect(declared).not.toContain('scripts/lib/discover-components.ts');
    expect(declared).not.toContain('scripts/validation-utilities.ts');
  });

  /**
   * `validationInputs`' own promise is narrower than `additionalSourceRoots`': these files are
   * "emitted, not walked for imports" by the planner, so a missing member of the closure is not
   * caught by declaring the entry point alone — the entry point's own missing import would refuse
   * the plan (the test above), but a transitively-missing one two hops down would not. This walks
   * the declared set's own relative imports and asserts every resolved specifier is itself either
   * declared here, emitted from `src/`, or emitted by `additionalSourceRoots` — the same question
   * `findSourceEscapes` asks of an import edge, asked here of a set the planner does not scan for
   * one.
   */
  test('the declared set is closed under its own relative imports', () => {
    const { plan } = committedPlans.cinder;
    const emitted = new Set(Object.keys(plan.files));
    const importPattern = /(?:from\s+['"](\.[^'"]+)['"])|(?:import\(\s*['"](\.[^'"]+)['"]\s*\))/g;
    // `generate-root-metadata-exports.ts` writes a generated file's source as a string literal,
    // and that literal's own `from '../../components.json'` reads as an import edge to a regex
    // that does not parse an AST — it is a string this script emits, not an import this script
    // makes, and `findSourceEscapes`'s real parser does not see it as one either. `generate-
    // artifacts.ts` (COR-1196) has the same shape: it writes the generated token registry
    // module's own source as a template literal, and that literal's first line is
    // `import registry from './registry.generated.json' with { type: 'json' };` — text this
    // script emits into `src/tokens/registry.generated.ts`, not an import `generate-artifacts.ts`
    // itself makes.
    const knownNonImports = new Set([
      'scripts/generate-root-metadata-exports.ts -> ../../components.json',
      'scripts/tokens/generate-artifacts.ts -> ./registry.generated.json',
      // `authoring-catalogue-output.ts` (COR-491) writes the generated catalogue module's source
      // as a template literal whose own `import type` line is text it emits, not an import it makes.
      'scripts/tokens/authoring-catalogue-output.ts -> ./authoring-types.ts',
    ]);
    const unresolved: string[] = [];
    for (const path of declared) {
      const target = `packages/components/${path}`;
      const contents = plan.files[target];
      if (contents === undefined) continue; // reported by the test above
      const text = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
      for (const match of text.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined) continue;
        if (knownNonImports.has(`${path} -> ${specifier}`)) continue;
        const resolved = normalize(join(dirname(target), specifier));
        // A specifier can omit its extension (`moduleResolution: bundler` resolves it), so a miss
        // on the literal path is retried with `.ts` before it counts as unresolved.
        if (emitted.has(resolved) || emitted.has(`${resolved}.ts`)) continue;
        unresolved.push(`${target} -> ${specifier}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  test('a declared check corvidae no longer carries is a refusal, not a silent skip', async () => {
    const omitted = 'scripts/generate-manifest.ts';
    const cinderDeclarations = [
      ...(additionalSourceRoots['@lostgradient/cinder'] ?? []).flatMap((cluster) => cluster.paths),
      ...declared,
    ];
    await withTree(
      {
        'components/cinder/src/index.ts': 'export const cinder = true;\n',
        ...Object.fromEntries(
          cinderDeclarations
            .filter((path) => path !== omitted)
            .map((path) => [`components/cinder/${path}`, `// ${path}\n`]),
        ),
      },
      async (root) => {
        const plan = planSource(root, [
          {
            workspace: '@lostgradient/cinder',
            corvidaeDirectory: 'components/cinder',
            targetDirectory: 'packages/components',
          },
        ]);
        expect(await throwingRejectionOf(plan)).toThrow(SourceEmissionError);
        expect(await throwingRejectionOf(plan)).toThrow(omitted);
        expect(await throwingRejectionOf(plan)).toThrow('validationInputs');
      },
    );
  });
});

describe('what counts as source', () => {
  test('the repository-operating files are not source, wherever they sit', () => {
    expect(isSourceFile('index.ts')).toBe(true);
    expect(isSourceFile('README.md')).toBe(true);
    expect(isSourceFile('AGENTS.md')).toBe(false);
    expect(isSourceFile('CLAUDE.md')).toBe(false);
    expect(isSourceFile('.gitignore')).toBe(false);
    expect(isSourceFile('coverage-ratchet.json')).toBe(false);
    expect(isSourceFile('CHANGELOG.md')).toBe(false);
  });

  test('a workspace’s source is planned at the target’s directory, not corvidae’s', async () => {
    await withTree(
      {
        'components/editor/src/lib/index.ts': 'export const editor = true;\n',
        'components/editor/src/lib/nested/helper.ts': 'export const helper = 1;\n',
        'components/editor/src/AGENTS.md': '# Not source\n',
        'components/editor/src/node_modules/installed/index.js': 'module.exports = {};\n',
        'components/editor/coverage-ratchet.json': '{"lines":90}\n',
        // Not declared anywhere and outside `src/`, so it must stay behind: a package-root
        // README is target-owned by default and `@lostgradient/editor` declares no opt-in.
        'components/editor/README.md': '# editor\n',
        // `validationInputs['@lostgradient/editor']` declares `scripts/preload.ts` (COR-1196), so
        // `planSource` now requires it to exist wherever `editorWorkspace` is planned — including
        // this fixture, which is otherwise about the `src/` emission rule, not about validation
        // inputs at all.
        'components/editor/scripts/preload.ts': 'export {};\n',
      },
      async (root) => {
        const plan = await planSource(root, [editorWorkspace]);
        expect(Object.keys(plan.files).toSorted()).toEqual([
          'packages/editor/scripts/preload.ts',
          'packages/editor/src/lib/index.ts',
          'packages/editor/src/lib/nested/helper.ts',
        ]);
        expect(plan.ownedPrefixes).toEqual(['packages/editor/src']);
        expect(plan.typeScriptWorkspaces).toEqual(['@lostgradient/editor']);
      },
    );
  });

  test('a declared build input corvidae carries is emitted with the source', async () => {
    await withTree(
      {
        'components/editor/src/index.ts': 'export const editor = true;\n',
        'components/editor/scripts/build.ts': 'export const build = true;\n',
        // See the fixture above: `validationInputs['@lostgradient/editor']` (COR-1196) requires
        // `scripts/preload.ts` wherever this workspace is planned.
        'components/editor/scripts/preload.ts': 'export {};\n',
      },
      async (root) => {
        const plan = await planSource(root, [
          {
            ...editorWorkspace,
            entry: {
              build: { requiredInputs: ['scripts/build.ts', 'scripts/pack-for-publish.ts'] },
            } as unknown as Parameters<typeof planSource>[1][number]['entry'],
          },
        ]);
        // The input corvidae has is carried; the one it does not have stays target-owned, which is
        // what `assertBuildInputsPresent` checks for in the clone rather than inventing here.
        expect(Object.keys(plan.files).toSorted()).toEqual([
          'packages/editor/scripts/build.ts',
          'packages/editor/scripts/preload.ts',
          'packages/editor/src/index.ts',
        ]);
      },
    );
  });

  test('a declared file lands at the same workspace-relative path in the target', async () => {
    await withTree(
      {
        'packages/weft/src/index.ts': 'export const weft = true;\n',
        // Outside `src/` and declared nowhere, so it must stay behind.
        'packages/weft/documentation/undeclared.md': '# not emitted\n',
        ...weftDeclarationFixture(),
      },
      async (root) => {
        const plan = await planSource(root, [
          {
            workspace: '@lostgradient/weft',
            corvidaeDirectory: 'packages/weft',
            targetDirectory: 'packages/weft',
          },
        ]);
        // The relative layout is preserved: a declared file outside `src/` sits at the same
        // workspace-relative path in the target, and a neighbour nobody declared is not emitted.
        const files = Object.keys(plan.files);
        expect(files).toContain('packages/weft/README.md');
        expect(files).toContain('packages/weft/src/index.ts');
        expect(files).not.toContain('packages/weft/documentation/undeclared.md');
      },
    );
  });

  test('a declared file corvidae no longer carries is a refusal, not a silent skip', async () => {
    await withTree(
      {
        'packages/weft/src/index.ts': 'export const weft = true;\n',
        ...weftDeclarationFixture('README.md'),
      },
      async (root) => {
        const plan = planSource(root, [
          {
            workspace: '@lostgradient/weft',
            corvidaeDirectory: 'packages/weft',
            targetDirectory: 'packages/weft',
          },
        ]);
        expect(await throwingRejectionOf(plan)).toThrow(SourceEmissionError);
        expect(await throwingRejectionOf(plan)).toThrow('README.md');
      },
    );
  });

  test('the executable bit is carried, because two of corvidae’s entry points have one', async () => {
    await withTree(
      {
        'packages/weft/src/cli-main.ts': '#!/usr/bin/env bun\nexport const main = true;\n',
        'packages/weft/src/library.ts': 'export const library = true;\n',
        // A declared file corvidae does not carry is a refusal, so the fixture carries every
        // path both declaration tables name for this workspace.
        ...weftDeclarationFixture(),
      },
      async (root) => {
        await chmod(join(root, 'packages/weft/src/cli-main.ts'), 0o755);
        const plan = await planSource(root, [
          {
            workspace: '@lostgradient/weft',
            corvidaeDirectory: 'packages/weft',
            targetDirectory: 'packages/weft',
          },
        ]);
        expect(plan.executable).toEqual(['packages/weft/src/cli-main.ts']);
      },
    );
  });

  test('a file that is not text survives, because one source tree holds a PNG fixture', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const root = await mkdtemp(join(tmpdir(), 'corvidae-source-'));
    try {
      await Bun.write(join(root, 'packages/testing/src/__fixtures__/baseline.png'), bytes);
      const plan = await planSource(root, [
        {
          workspace: '@lostgradient/testing',
          corvidaeDirectory: 'packages/testing',
          targetDirectory: 'packages/testing',
        },
      ]);
      expect(plan.files['packages/testing/src/__fixtures__/baseline.png']).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a package-root README.md is target-owned unless declared', () => {
  /**
   * The rule COR-1196 round 10 settled on after a reverted attempt at the opposite: a
   * package-root `README.md` ships from corvidae only for a workspace that declares it in
   * `additionalSourceRoots`, the same as any other file outside `src/`. Every corvidae workspace's
   * own README is internal documentation — `workspace:*` install instructions, references to the
   * corvidae root — that would overwrite a target's public npm front page if emitted blindly.
   * `@lostgradient/weft` is the one declared exception (`source.ts`); this pins the general rule
   * directly against an undeclared workspace, so it keeps failing the same way regardless of
   * which workspace a future declaration might add.
   */
  test('an undeclared workspace’s README.md is never emitted, even when corvidae carries one', async () => {
    expect(additionalSourceRoots['@lostgradient/cryptography']).toBeUndefined();
    await withTree(
      {
        'packages/cryptography/src/index.ts': 'export const cryptography = true;\n',
        'packages/cryptography/README.md': '# Cryptography\n',
      },
      async (root) => {
        const plan = await planSource(root, [
          {
            workspace: '@lostgradient/cryptography',
            corvidaeDirectory: 'packages/cryptography',
            targetDirectory: 'packages/cryptography',
          },
        ]);
        expect(Object.keys(plan.files)).toEqual(['packages/cryptography/src/index.ts']);
      },
    );
  });

  test('@lostgradient/weft’s declared README.md is still emitted', async () => {
    await withTree(
      { ...weftDeclarationFixture(), 'packages/weft/src/index.ts': 'export const weft = true;\n' },
      async (root) => {
        const plan = await planSource(root, [
          {
            workspace: '@lostgradient/weft',
            corvidaeDirectory: 'packages/weft',
            targetDirectory: 'packages/weft',
          },
        ]);
        expect(Object.keys(plan.files)).toContain('packages/weft/README.md');
      },
    );
  });
});

describe('what a sync prunes', () => {
  test('only paths beneath an owned prefix that the plan no longer emits', async () => {
    await withTree(
      {
        'packages/editor/src/index.ts': 'export const editor = true;\n',
        'packages/editor/src/retired.ts': 'export const retired = true;\n',
        'packages/editor/src/AGENTS.md': '# Target-owned, inside a tree the transform owns\n',
        'packages/editor/scripts/build.ts': 'export const build = true;\n',
        'packages/editor/AB-429-final-contract-review.md': '# Unknown working document\n',
        'packages/mcp/src/index.ts': 'export const mcp = true;\n',
      },
      async (target) => {
        const prunable = await collectPrunablePaths(
          target,
          { ownedPrefixes: ['packages/editor/src'] },
          ['packages/editor/src/index.ts'],
        );
        // `retired.ts` alone: the target-owned file inside the prefix is not source, the build
        // input and the working document are outside the prefix, and `packages/mcp` is a
        // workspace this transform does not emit at all.
        expect(prunable).toEqual(['packages/editor/src/retired.ts']);
      },
    );
  });

  test('a target that has never received source has nothing to prune', async () => {
    await withTree({ 'packages/editor/README.md': '# editor\n' }, async (target) => {
      expect(
        await collectPrunablePaths(target, { ownedPrefixes: ['packages/editor/src'] }, []),
      ).toEqual([]);
    });
  });
});

describe('one owner per plan key', () => {
  test('two producers claiming one key is a failure naming both', () => {
    expect(() =>
      assertSingleOwner([
        { owner: 'manifests', paths: ['packages/editor/package.json'] },
        { owner: 'source', paths: ['packages/editor/package.json'] },
      ]),
    ).toThrow(SourceEmissionError);
    try {
      assertSingleOwner([
        { owner: 'typescript-configuration', paths: ['packages/editor/tsconfig.json'] },
        { owner: 'source', paths: ['packages/editor/tsconfig.json'] },
      ]);
    } catch (error) {
      expect((error as Error).message).toContain('packages/editor/tsconfig.json');
      expect((error as Error).message).toContain('typescript-configuration');
      expect((error as Error).message).toContain('source');
    }
  });

  test('disjoint claims pass, which is what the real plan relies on', () => {
    expect(() =>
      assertSingleOwner([
        { owner: 'manifests', paths: ['packages/editor/package.json'] },
        { owner: 'typescript-configuration', paths: ['packages/editor/tsconfig.json'] },
        { owner: 'source', paths: ['packages/editor/src/index.ts'] },
      ]),
    ).not.toThrow();
  });
});

describe('a remapped workspace on disk', async () => {
  /**
   * The remap is what the other assertions in this file take on trust, so it is checked the way a
   * sync would see it: plan the whole surface for a workspace corvidae keeps under `components/`,
   * write the plan through the guard, and read the result off the filesystem.
   */
  const landsAtTargetSOwnDirectoryOutcome = await outcomeOf(async () => {
    const source = 'export const editor = "corvidae";\n';
    await withTree(
      {
        LICENSE: licence,
        'package.json': `${JSON.stringify({
          name: 'corvidae',
          private: true,
          type: 'module',
          license: 'MIT',
          workspaces: ['components/*', 'internal/*'],
          catalog: {},
        })}\n`,
        'internal/typescript/package.json': `${JSON.stringify({
          name: '@lostgradient/typescript',
          private: true,
          type: 'module',
        })}\n`,
        'internal/typescript/base.json': '{"compilerOptions":{"strict":true}}\n',
        'internal/typescript/library.json': '{"extends":"./base.json"}\n',
        'internal/typescript/browser.json': '{"extends":"./base.json"}\n',
        'components/editor/package.json': `${JSON.stringify({
          name: '@lostgradient/editor',
          private: true,
          type: 'module',
          exports: { '.': './src/index.ts' },
          scripts: { typecheck: 'tsc --noEmit' },
        })}\n`,
        'components/editor/tsconfig.json': `${JSON.stringify({
          extends: '@lostgradient/typescript/browser.json',
        })}\n`,
        'components/editor/src/lib/index.ts': source,
        // `validationInputs['@lostgradient/editor']` (COR-1196) declares `scripts/preload.ts`;
        // `planSurface` refuses a plan for this workspace without it, same as the two `planSource`
        // fixtures above.
        'components/editor/scripts/preload.ts': 'export {};\n',
      },
      async (root) => {
        for (const policyFile of ['package-map.json', 'package-surface.json']) {
          await Bun.write(
            join(root, 'scripts/mirror', policyFile),
            await Bun.file(join(import.meta.dir, policyFile)).text(),
          );
        }
        const plan = await planSurface({ corvidaeRoot: root, target: 'cinder' });
        await withTree({}, async (directory) => {
          const policy = await loadTargetOwnedPolicy();
          const { written } = await writeTransformOutput({
            policy,
            target: 'cinder',
            directory,
            files: plan.files,
            executable: plan.source.executable,
          });
          expect(written).toContain('packages/editor/src/lib/index.ts');
          expect(await readFile(join(directory, 'packages/editor/src/lib/index.ts'), 'utf8')).toBe(
            source,
          );
          expect(await Bun.file(join(directory, 'packages/editor/package.json')).exists()).toBe(
            true,
          );
          expect(await Bun.file(join(directory, 'components/editor/package.json')).exists()).toBe(
            false,
          );
          const metadata = await stat(join(directory, 'packages/editor/src/lib/index.ts'));
          expect(metadata.isFile()).toBe(true);
        });
      },
    );
  });
  test('lands at the target’s own directory, read back from the written tree', () =>
    rethrow(landsAtTargetSOwnDirectoryOutcome));
});

describe('the committed workspaces', async () => {
  /**
   * COR-1284 renamed every corvidae workspace to the name it already publishes under, which made
   * the source-side rewrite layer COR-1285 deletes a no-op by construction. Most source remains
   * byte-for-byte. Public Chat and Editor example sidecars are the exception: corvidae's private
   * packages expose one root source entry, while the published browser entries expose individual
   * components through subpaths. Their emitted form is checked above against those subpaths.
   *
   * Scoped to `plan.source.files` rather than the merged surface, so a manifest, an exports map or
   * a vendored tsconfig — none of which corvidae's own tree carries verbatim, all three legitimately
   * rewritten by the other two producers — never has to be filtered out by path; `SourcePlan`
   * already excludes them by construction.
   */
  const byteTargets: MirrorTarget[] = ['cinder', 'weft'];
  const byteOutcomes = new Map<MirrorTarget, unknown>();
  // Compares thousands of emitted files against their sources on disk (no process, but enough I/O to miss five seconds on a loaded host); it runs at module scope, off the per-test clock.
  for (const target of byteTargets) {
    byteOutcomes.set(
      target,
      await outcomeOf(async () => {
        const { plan } = committedPlans[target];
        // A declared version constant is the one sanctioned difference: the transform rewrites its
        // literal to the composed manifest's version (COR-1192), which differs from corvidae's own
        // literal whenever the target's release is newer. It must still match byte-for-byte
        // everywhere else.
        const versionFiles = new Map(
          plan.published.flatMap((entry) => {
            const declared = versionConstants[entry.workspace];
            return declared === undefined
              ? []
              : [[`${entry.directory}/${declared}`, entry.version]];
          }),
        );
        const mismatches: string[] = [];
        for (const [path, contents] of Object.entries(plan.source.files)) {
          if (
            /^packages\/(chat|editor)\/src\/lib\/components\/([^/]+)\/\2\.examples\.json$/.test(
              path,
            ) &&
            path !== 'packages/chat/src/lib/components/chat/chat.examples.json'
          )
            continue;
          // COR-1446: fenced imports in these are routed to their public subpaths; the test above
          // asserts what they become.
          if (/^packages\/(?:chat|editor)\/src\/lib\/components\/[^/]+\/README\.md$/.test(path))
            continue;
          const workspace = plan.emitted
            .filter((candidate) => path.startsWith(`${candidate.targetDirectory}/`))
            .toSorted(
              (left, right) => right.targetDirectory.length - left.targetDirectory.length,
            )[0];
          if (workspace === undefined) {
            mismatches.push(`${path}: no emitted workspace claims this path`);
            continue;
          }
          const corvidaePath = `${workspace.corvidaeDirectory}${path.slice(workspace.targetDirectory.length)}`;
          const onDisk = await Bun.file(join(corvidaeRoot, corvidaePath)).bytes();
          const composedVersion = versionFiles.get(path);
          const expected =
            composedVersion === undefined
              ? Buffer.from(onDisk)
              : Buffer.from(
                  new TextDecoder()
                    .decode(onDisk)
                    .replace(
                      /export const VERSION = '[^']*';\n$/,
                      `export const VERSION = '${composedVersion}';\n`,
                    ),
                );
          const emitted = Buffer.from(contents);
          if (Buffer.compare(expected, emitted) !== 0) {
            mismatches.push(`${path}: differs from corvidae’s ${corvidaePath}`);
          }
        }
        expect(mismatches).toEqual([]);
      }),
    );
  }

  test.each(byteTargets)(
    'the %s plan preserves source bytes except published component examples and READMEs',
    (target) => rethrow(byteOutcomes.get(target)),
  );
});

/**
 * COR-1192: the exported `VERSION` must not contradict the target's manifest. `package.json`'s
 * `version` is target-owned and `src/version.ts` is emitted, so without this the next sync after a
 * target bump ships corvidae's stale literal. The transform rewrites the literal to the version the
 * composed manifest already carries — a declared file per workspace, a strict shape, and a refusal
 * for anything else, so the rewrite can never silently do nothing.
 */
describe('applyVersionConstants', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const documented =
    "/**\n * Current Weft package version.\n */\nexport const VERSION = '0.25.0';\n";
  const published = [
    { workspace: '@lostgradient/weft', directory: 'packages/weft', version: '0.26.0' },
  ];

  test('weft declares src/version.ts, and the committed file has the shape the rewrite expects', () => {
    expect(versionConstants['@lostgradient/weft']).toBe('src/version.ts');
    const emitted = committedPlans.weft.plan.files['packages/weft/src/version.ts'];
    expect(emitted).toBeDefined();
    const text = typeof emitted === 'string' ? emitted : decoder.decode(emitted);
    const version = committedPlans.weft.plan.published.find(
      (entry) => entry.workspace === '@lostgradient/weft',
    )?.version;
    expect(text.endsWith(`export const VERSION = '${version}';\n`)).toBe(true);
  });

  test('rewrites the literal to the composed manifest version and keeps the documentation', () => {
    const files = { 'packages/weft/src/version.ts': encoder.encode(documented) };
    const rewritten = applyVersionConstants(files, published);
    expect(rewritten).toEqual(['packages/weft/src/version.ts']);
    expect(decoder.decode(files['packages/weft/src/version.ts'])).toBe(
      "/**\n * Current Weft package version.\n */\nexport const VERSION = '0.26.0';\n",
    );
  });

  test('rejects an unsafe manifest version before writing executable source', () => {
    const files = { 'packages/weft/src/version.ts': encoder.encode(documented) };
    expect(() =>
      applyVersionConstants(files, [{ ...published[0]!, version: "0.27.1';\nsideEffect();//" }]),
    ).toThrow(SourceEmissionError);
    expect(decoder.decode(files['packages/weft/src/version.ts'])).toBe(documented);
  });

  test('allows a SemVer prerelease with build metadata in the generated source literal', () => {
    const files = { 'packages/weft/src/version.ts': encoder.encode(documented) };
    applyVersionConstants(files, [{ ...published[0]!, version: '0.27.2-next.3+build.1' }]);
    expect(decoder.decode(files['packages/weft/src/version.ts'])).toEndWith(
      "export const VERSION = '0.27.2-next.3+build.1';\n",
    );
  });

  test('a declared file the plan does not carry is a refusal, naming the workspace and path', () => {
    expect(() => applyVersionConstants({}, published)).toThrow(SourceEmissionError);
    expect(() => applyVersionConstants({}, published)).toThrow('packages/weft/src/version.ts');
  });

  test('a declared file whose shape is not the documented export is a refusal, not a silent skip', () => {
    const files = {
      'packages/weft/src/version.ts': encoder.encode('export const VERSION = computeVersion();\n'),
    };
    expect(() => applyVersionConstants(files, published)).toThrow(SourceEmissionError);
    expect(() => applyVersionConstants(files, published)).toThrow('@lostgradient/weft');
  });

  test('a workspace with no declaration is left alone', () => {
    const files = { 'packages/other/src/version.ts': encoder.encode(documented) };
    const rewritten = applyVersionConstants(files, [
      { workspace: '@lostgradient/other', directory: 'packages/other', version: '1.0.0' },
    ]);
    expect(rewritten).toEqual([]);
    expect(decoder.decode(files['packages/other/src/version.ts'])).toBe(documented);
  });
});

/** COR-1192: the package front page ships from corvidae, and carries no version literal. */
describe('the weft package README', () => {
  test('is emitted, and names no release version', () => {
    const emitted = committedPlans.weft.plan.files['packages/weft/README.md'];
    expect(emitted).toBeDefined();
    const text = typeof emitted === 'string' ? emitted : new TextDecoder().decode(emitted);
    expect(text).toContain('# Weft');
    // No release literal: the sentence that carried `0.25.0` is gone, and nothing else in the
    // page names a weft version, so a future literal shows up here before it ships stale.
    expect(text).not.toMatch(/Current release/);
    expect(text).not.toMatch(/@lostgradient\/weft@\d|weft (?:version|release) \d/i);
    expect(text).not.toContain('0.25.0');
  });
});
