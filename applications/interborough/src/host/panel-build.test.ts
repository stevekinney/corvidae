/**
 * The panel build (COR-2216): what it does with more than one output, which `svelte` and
 * `@lostgradient/cinder` it resolves, and how it finds them. The builds here bundle small scripts;
 * the ones against the real Cinder panel kit take seconds and are in `panel-build.slow.test.ts`.
 */
import { compileSvelteComponentForBun, compileSvelteRuneModuleForBun } from '@lostgradient/testing';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HOST_DEPENDENCIES } from './folder-plugins.ts';
import {
  DECOY_FILES,
  DECOY_SVELTE,
  buildTwiceThroughCache,
  panelBuildFixtures,
} from './panel-build.test-support.ts';
import {
  buildPanelPage,
  compileSveltePanelComponent,
  compileSveltePanelModule,
  panelBuildCodeDigest,
  resolveHostPanelPackage,
} from './panel-build.ts';

const { fixture, build, cleanup } = panelBuildFixtures();
const emptyDirectories: string[] = [];

afterEach(async () => {
  await cleanup();
  for (const directory of emptyDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function emptyDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-panel-empty-'));
  emptyDirectories.push(directory);
  return directory;
}

describe('buildPanelPage with more than one output (COR-2216)', () => {
  test('a stylesheet beside the script is inlined, not a failure', async () => {
    const directory = await fixture({
      'panel.ts': `import './panel.css';\ndocument.body.textContent = 'plain';\n`,
      'panel.css': '.fixture-sheet { color: rebeccapurple; }\n',
    });
    const { html } = await build(directory, 'panel.ts');
    expect(html).toMatch(/<style>[^<]*fixture-sheet[^<]*<\/style>/);
    expect(html).not.toMatch(/<link\b/);
  });

  test('a file the page would have to load from beside it still fails the build', async () => {
    const directory = await fixture({
      'panel.ts': `import url from './logo.png';\ndocument.body.textContent = url;\n`,
      'logo.png': 'not really a png',
    });
    expect(await throwingRejectionOf(build(directory, 'panel.ts'))).toThrow(
      /did not build into one script/,
    );
  });
});

describe('buildPanelPage resolves svelte from the host (COR-2216)', () => {
  test('a plugin script that imports svelte reaches the host runtime, not its own copy', async () => {
    const directory = await fixture({
      'panel.ts': `import { mount } from 'svelte';\nexport { mount };\ndocument.body.textContent = String(mount);\n`,
      ...DECOY_FILES,
    });
    const { html } = await build(directory, 'panel.ts');
    expect(html).not.toContain(DECOY_SVELTE);
  });

  test('a build against a host with no svelte fails and says which file is missing', async () => {
    const directory = await fixture({
      'panel.ts': `import { mount } from 'svelte';\ndocument.body.textContent = String(mount);\n`,
    });
    const dependencies = await emptyDirectory();
    expect(
      await throwingRejectionOf(
        buildPanelPage({
          entry: pathToFileURL(join(directory, 'panel.ts')).href,
          title: 'Fixture panel',
          styles: '',
          dependencies,
        }),
      ),
    ).toThrow(/has no svelte to build a panel with/);
  });

  test('a build against a host with svelte and no Cinder fails inside the bundle and says so', async () => {
    const directory = await fixture({
      'panel.ts': `import { mountPanel } from '@lostgradient/cinder/panel';\nmountPanel;\n`,
    });
    const dependencies = await emptyDirectory();
    await symlink(join(HOST_DEPENDENCIES, 'svelte'), join(dependencies, 'svelte'), 'dir');
    const failure = await buildPanelPage({
      entry: pathToFileURL(join(directory, 'panel.ts')).href,
      title: 'Fixture panel',
      styles: '',
      dependencies,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const messages = (failure as AggregateError).errors.map((entry: { message?: string }) =>
      String(entry.message),
    );
    expect(messages.join('\n')).toContain('has no @lostgradient/cinder to build a panel with');
  });
});

describe('a real build through the cache (COR-2219)', () => {
  test('is stored once and served the second time without building', async () => {
    const directory = await fixture({
      'panel.ts': `import './panel.css';\nimport { label } from './label.ts';\ndocument.body.textContent = label;\n`,
      'panel.css': '.fixture-sheet { color: rebeccapurple; }\n',
      'label.ts': "export const label = 'cached';\n",
    });
    const { builds, stored, first, second } = await buildTwiceThroughCache(directory, 'panel.ts');
    expect(stored).toHaveLength(1);
    expect(builds).toBe(1);
    expect(second).toEqual(first);
  });

  test('the files the real build reports are real files, so an entry is never refused as newer', async () => {
    const directory = await fixture({
      'panel.ts': `import { label } from './label.ts';\ndocument.body.textContent = label;\n`,
      'label.ts': "export const label = 'cached';\n",
    });
    const page = await buildPanelPage({
      entry: pathToFileURL(join(directory, 'panel.ts')).href,
      title: 'Fixture panel',
      styles: '',
    });
    const names = page.inputs.map((path) => path.slice(path.lastIndexOf('/') + 1));
    expect(names.toSorted()).toEqual(['label.ts', 'panel.ts']);
    for (const path of page.inputs) expect(await Bun.file(path).exists(), path).toBe(true);
  });
});

describe('the Svelte compile of a panel', () => {
  const component = `<script lang="ts">
  let { label }: { label: string } = $props();
  let count = $state(0);
</script>

<button onclick={() => (count += 1)}>{label} {count}</button>

<style>
  button { color: rebeccapurple; }
</style>
`;

  test('is the compile the application build makes, byte for byte', async () => {
    const compiler = await import(
      pathToFileURL(resolveHostPanelPackage(HOST_DEPENDENCIES, 'svelte/compiler')!).href
    );
    const path = '/fixture/panel.svelte';
    expect(compileSveltePanelComponent(compiler, component, path)).toBe(
      compileSvelteComponentForBun(
        component,
        path,
        { generate: 'client', injectCss: true },
        {},
        false,
      ).contents,
    );
    const rune = 'export const counter = $state({ value: 0 });\n';
    expect(compileSveltePanelModule(compiler, rune, '/fixture/counter.svelte.js')).toBe(
      compileSvelteRuneModuleForBun(rune, '/fixture/counter.svelte.js', 'client', false).contents,
    );
  });

  test('injects the component styles into its script, so the page needs no stylesheet for them', async () => {
    const directory = await fixture({
      'panel.ts': `import Panel from './panel.svelte';\nimport { mount } from 'svelte';\nmount(Panel, { target: document.body, props: { label: 'Go' } });\n`,
      'panel.svelte': component,
    });
    const { html } = await build(directory, 'panel.ts');
    expect(html).toContain('rebeccapurple');
    expect(html).not.toMatch(/<link\b/);
  });
});

describe('panelBuildCodeDigest (COR-2219)', () => {
  test('is one sha256 of the build functions’ text, the same every time', () => {
    expect(panelBuildCodeDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(panelBuildCodeDigest()).toBe(panelBuildCodeDigest());
  });
});

describe('resolveHostPanelPackage', () => {
  test('resolves svelte under the browser condition, not the server one', () => {
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, 'svelte')).toMatch(
      /svelte\/src\/index-client\.js$/,
    );
  });

  test('resolves svelte subpaths its runtime imports', () => {
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, 'svelte/internal/client')).toMatch(
      /svelte\/src\/internal\/client\/index\.js$/,
    );
  });

  test('resolves the Cinder panel kit to its source under the svelte condition', () => {
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, '@lostgradient/cinder/panel')).toMatch(
      /cinder\/src\/panel\/index\.ts$/,
    );
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, '@lostgradient/cinder')).toMatch(
      /cinder\/src\/index\.ts$/,
    );
  });

  test('leaves every other specifier to the bundler', () => {
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, 'svelte-check')).toBeUndefined();
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, '@lostgradient/cinderella')).toBeUndefined();
    expect(resolveHostPanelPackage(HOST_DEPENDENCIES, './panel.svelte')).toBeUndefined();
  });

  test('names a package the host does not install', async () => {
    const empty = await emptyDirectory();
    expect(() => resolveHostPanelPackage(empty, 'svelte')).toThrow(/has no svelte/);
  });

  test('names a subpath the package does not export', () => {
    expect(() =>
      resolveHostPanelPackage(HOST_DEPENDENCIES, '@lostgradient/cinder/nothing'),
    ).toThrow(/does not export \.\/nothing/);
  });
});
