import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, resolveConfig } from 'prettier';

import { packageMapForFixtures } from './committed-plans.ts';
import { formatEmittedFile, serializeJson } from './json-formatting.ts';
import { planManifests } from './manifests.ts';
import { planSource } from './source.ts';
import { configurationWorkspace, planTypeScriptConfiguration } from './typescript-configuration.ts';

const corvidaeRoot = join(import.meta.dir, '..', '..');

/** The weft target's own prettier configuration, which lives beside the package, not at the root. */
const targetPrettierConfiguration = JSON.stringify({
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'all',
  printWidth: 100,
  endOfLine: 'lf',
  plugins: ['prettier-plugin-organize-imports'],
});

/** A throwaway clone, shaped like the weft target: a package configuration and no root one. */
async function withClone(
  files: Record<string, string>,
  body: (clone: string) => Promise<void>,
): Promise<void> {
  const clone = await mkdtemp(join(tmpdir(), 'mirror-json-clone-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(clone, path), contents);
    }
    await body(clone);
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}

/** A throwaway corvidae tree carrying `internal/typescript` and whatever the test declares. */
async function withTree(
  files: Record<string, string>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-json-source-'));
  try {
    for (const file of ['base.json', 'browser.json', 'library.json']) {
      await Bun.write(join(root, 'internal', 'typescript', file), `{ "marker": "${file}" }\n`);
    }
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(root, path), contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Prettier's own verdict on emitted text, asked exactly the way the target's `format:check` asks. */
async function isPrettierClean(text: string, destination: string): Promise<boolean> {
  const resolved = await resolveConfig(destination);
  return check(text, { ...resolved, plugins: [], filepath: destination });
}

describe('an emitted document with a short array', () => {
  /**
   * The defect COR-1230 found, stated as the target states it.
   *
   * A real sync of the weft target emitted `src/cli/__fixtures__/codegen/typecheck/tsconfig.json`
   * and `src/client/__fixtures__/no-workflow-registry/tsconfig.json`, and the target's
   * `format:check` exited 1 on both. Corvidae's own copies are prettier-clean; the transform's
   * `JSON.stringify` was expanding an `include` that prettier packs onto one line. Reverting
   * `serializeJson` to that stringify fails this test, which is the only reason it is worth
   * having.
   */
  test('is prettier-clean under the target’s configuration', async () => {
    await withTree(
      {
        'packages/weft/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['src'],
        }),
        'packages/weft/src/cli/__fixtures__/codegen/typecheck/tsconfig.json': JSON.stringify({
          extends: `${configurationWorkspace}/library.json`,
          include: ['consumer.ts', 'weft.generated.d.ts'],
        }),
      },
      async (root) => {
        await withClone(
          { 'packages/weft/.prettierrc.json': targetPrettierConfiguration },
          async (clone) => {
            const path = 'packages/weft/src/cli/__fixtures__/codegen/typecheck/tsconfig.json';
            const plan = await planTypeScriptConfiguration({
              corvidaeRoot: root,
              target: 'weft',
              workspaces: [
                { corvidaeDirectory: 'packages/weft', targetDirectory: 'packages/weft' },
              ],
              targetDirectory: clone,
            });
            const emitted = plan.files[path] ?? '';
            expect(await isPrettierClean(emitted, join(clone, path))).toBe(true);
            expect(emitted).toContain('"include": ["consumer.ts", "weft.generated.d.ts"]');
          },
        );
      },
    );
  });

  /**
   * That the formatting is the *target's* and not corvidae's, which a matching configuration
   * cannot demonstrate. Corvidae prints at 100 columns; a target that prints at 40 packs the same
   * array differently, and the emitted bytes have to follow the target.
   */
  test('follows the target’s print width rather than corvidae’s', async () => {
    const document = { include: ['alpha.ts', 'bravo.ts', 'charlie.ts', 'delta.ts'] };
    await withClone({ '.prettierrc.json': JSON.stringify({ printWidth: 40 }) }, async (narrow) => {
      expect(await serializeJson(document, narrow, 'tsconfig.json')).toBe(
        '{\n  "include": [\n    "alpha.ts",\n    "bravo.ts",\n    "charlie.ts",\n    "delta.ts"\n  ]\n}\n',
      );
    });
    await withClone({ '.prettierrc.json': JSON.stringify({ printWidth: 100 }) }, async (wide) => {
      expect(await serializeJson(document, wide, 'tsconfig.json')).toBe(
        '{\n  "include": ["alpha.ts", "bravo.ts", "charlie.ts", "delta.ts"]\n}\n',
      );
    });
  });

  /**
   * A plugin the target names is imported by *this* process, and at plan time the clone has no
   * `node_modules` — the lockfile install is the last thing a sync does. Honoring the list throws
   * `ERR_MODULE_NOT_FOUND` and takes the whole sync down over a line in the repository being
   * transformed, so the resolved `plugins` is dropped.
   */
  test('survives a plugin the target declares and corvidae cannot resolve', async () => {
    await withClone(
      {
        '.prettierrc.json': JSON.stringify({
          printWidth: 100,
          plugins: ['prettier-plugin-nothing-installs-this'],
        }),
      },
      async (clone) => {
        expect(await serializeJson({ include: ['a.ts'] }, clone, 'tsconfig.json')).toBe(
          '{\n  "include": ["a.ts"]\n}\n',
        );
      },
    );
  });
});

/** A markdown table, which is where corvidae's `proseWrap` override and the target's part ways. */
const markdownTable = [
  '# Messages',
  '',
  '| Field | Type | Description |',
  '| --- | --- | --- |',
  '| `type` | `"register"` | Message discriminator. |',
  '',
].join('\n');

const targetMarkdownConfiguration = JSON.stringify({ printWidth: 100, tabWidth: 2 });

describe('an emitted file the target’s prettier governs', () => {
  /**
   * The second instance of the same defect, found in this change before it reached a sync.
   *
   * Corvidae's `*.md` override sets `proseWrap: "never"`, which prints a table compact; the weft
   * target's sets only `tabWidth`, so `proseWrap` falls to `preserve` and prettier pads the
   * columns. Emitting corvidae's bytes put two documents into the target that its own
   * `format:check` refuses — the JSON defect one file class over, which is why the rule asks
   * whether prettier governs the path rather than what kind of file it is.
   */
  test('is formatted, so a markdown table is padded the way the target pads it', async () => {
    await withClone({ '.prettierrc.json': targetMarkdownConfiguration }, async (clone) => {
      const emitted = await formatEmittedFile(
        new TextEncoder().encode(markdownTable),
        clone,
        'documentation/reference/protocol.md',
      );
      const text = new TextDecoder().decode(emitted);
      expect(text).toContain('| Field  | Type         | Description            |');
      expect(await isPrettierClean(text, join(clone, 'documentation/reference/protocol.md'))).toBe(
        true,
      );
    });
  });

  /**
   * `plugins` matters more under the general rule than it did under the JSON one, which is the
   * reason to keep asserting it: the weft target declares `prettier-plugin-organize-imports`, and
   * the rule now reaches the TypeScript that plugin acts on. Resolving it would import a plugin
   * into this process against a clone that has no `node_modules` until the sync's last step.
   */
  test('formats TypeScript without resolving the plugin the target declares', async () => {
    await withClone(
      {
        '.prettierrc.json': JSON.stringify({
          printWidth: 100,
          singleQuote: true,
          plugins: ['prettier-plugin-nothing-installs-this'],
        }),
      },
      async (clone) => {
        const emitted = await formatEmittedFile(
          new TextEncoder().encode('export const value = "quoted";\n'),
          clone,
          'src/index.ts',
        );
        expect(new TextDecoder().decode(emitted)).toBe("export const value = 'quoted';\n");
      },
    );
  });

  /**
   * COR-1196. Cinder is the first target that ships Svelte, and its configuration maps
   * `**\/*.svelte` to the `svelte` parser, which only `prettier-plugin-svelte` supplies. With the
   * target's plugins dropped (above), that parser does not exist in this process, and formatting
   * threw `Couldn't resolve parser "svelte"` on the first component the plan reached, so the whole
   * cinder plan failed. A file whose parser prettier does not ship is copied as bytes: the mirror
   * runs no formatting gate, and guessing at a plugin's output with a different plugin version
   * would be worse than leaving corvidae's bytes alone.
   */
  test('copies bytes for a file whose parser only a target plugin supplies', async () => {
    await withClone(
      {
        '.prettierrc.json': JSON.stringify({
          printWidth: 100,
          plugins: ['prettier-plugin-svelte'],
          overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
        }),
      },
      async (clone) => {
        const component =
          '<script lang="ts">\n  let count = $state(0)\n</script>\n\n<button>{count}</button>\n';
        const contents = new TextEncoder().encode(component);
        const emitted = await formatEmittedFile(contents, clone, 'src/counter.svelte');
        expect(new TextDecoder().decode(emitted)).toBe(component);
      },
    );
  });

  test('is left byte-identical when the target ignores it', async () => {
    await withClone(
      {
        '.prettierrc.json': targetMarkdownConfiguration,
        '.prettierignore': 'documentation/reference/protocol.md\n',
      },
      async (clone) => {
        const contents = new TextEncoder().encode(markdownTable);
        const emitted = await formatEmittedFile(
          contents,
          clone,
          'documentation/reference/protocol.md',
        );
        expect(new TextDecoder().decode(emitted)).toBe(markdownTable);
      },
    );
  });

  /**
   * The byte path is the default and stays that way. One emitted workspace carries a PNG baseline
   * fixture, and prettier infers no parser for it, so the question the rule asks answers itself.
   */
  test('copies bytes for a file prettier does not govern', async () => {
    await withClone({ '.prettierrc.json': targetMarkdownConfiguration }, async (clone) => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      const emitted = await formatEmittedFile(png, clone, 'src/__fixtures__/baseline.png');
      expect([...emitted]).toEqual([...png]);
    });
  });

  test('reaches an emitted document through the source half, not only the helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-json-source-'));
    try {
      await Bun.write(join(root, 'packages/weft/src/index.ts'), 'export const weft = true;\n');
      await Bun.write(join(root, 'packages/weft/documentation/protocol.md'), markdownTable);
      await withClone(
        { 'packages/weft/.prettierrc.json': targetMarkdownConfiguration },
        async (clone) => {
          const plan = await planSource(
            root,
            [
              {
                workspace: '@lostgradient/example',
                corvidaeDirectory: 'packages/weft',
                targetDirectory: 'packages/weft',
                entry: { build: { requiredInputs: ['documentation/protocol.md'] } },
              } as unknown as Parameters<typeof planSource>[1][number],
            ],
            clone,
          );
          const emitted = plan.files['packages/weft/documentation/protocol.md'];
          expect(emitted).toBeDefined();
          const text = new TextDecoder().decode(emitted);
          expect(text).toContain('| Field  | Type         | Description            |');
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('an emitted document with no target configuration to obey', () => {
  test('is left exactly as `JSON.stringify` wrote it', async () => {
    const document = { include: ['a.ts'] };
    await withClone({}, async (clone) => {
      expect(await serializeJson(document, clone, 'package.json')).toBe(
        `${JSON.stringify(document, undefined, 2)}\n`,
      );
    });
    expect(await serializeJson(document, undefined, 'package.json')).toBe(
      `${JSON.stringify(document, undefined, 2)}\n`,
    );
  });

  /**
   * The weft target's root manifest, which this change must not touch.
   *
   * COR-1230's manifest inversion made the emitted root `package.json` byte-for-byte identical to
   * the target's, and the weft target keeps no prettier configuration at its root — its
   * `format:check` is delegated per workspace through turbo, so nothing checks that file. Running
   * it through prettier's defaults would re-pack its arrays at 80 columns and put a churn diff on
   * the one file a previous change worked to stop churning. Being exactly `JSON.stringify`'s
   * output is the statement that it is unchanged, since that is what the transform emitted before
   * this one. The workspace manifest beside it is formatted, because there the target does have a
   * configuration and does check the file.
   */
  test('leaves the emitted root manifest alone and still formats the workspace manifest', async () => {
    await withClone(
      { 'packages/weft/.prettierrc.json': targetPrettierConfiguration },
      async (clone) => {
        // Weft's development edges to Cinder and Markdown (the UI's, COR-1455) resolve through
        // `assertEdgeNotStale`, which refuses while either has unpublished source. Staleness is not
        // this test's subject, so it plans against the current-digest snapshots the committed
        // plans use; the release order (Cinder and Markdown before Weft) is the real sync's.
        const plan = await planManifests({
          corvidaeRoot,
          target: 'weft',
          targetDirectory: clone,
          packageMap: packageMapForFixtures,
        });
        const rootManifest = plan.files['package.json'] ?? '';
        expect(rootManifest).toBe(`${JSON.stringify(JSON.parse(rootManifest), undefined, 2)}\n`);
        const workspaceManifest = plan.files['packages/weft/package.json'] ?? '';
        expect(workspaceManifest).not.toBe('');
        expect(
          await isPrettierClean(workspaceManifest, join(clone, 'packages/weft/package.json')),
        ).toBe(true);
      },
    );
  });
});
