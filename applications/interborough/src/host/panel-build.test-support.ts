/**
 * Fixtures for the panel build's tests (COR-2216). They live under the operating system's temporary
 * directory, outside the repository, so nothing they import resolves by walking up into the
 * repository's own install: `svelte` and `@lostgradient/cinder` reach a build only through the
 * host's resolver, and a decoy of each, planted in a fixture's own `node_modules`, shows which one
 * a build took.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPanelBuildCache } from './panel-build-cache.ts';
import {
  buildPanelPage,
  panelBuildCodeDigest,
  panelBuildVersions,
  type BuiltPanel,
} from './panel-build.ts';

/** A folder plugin's panel: a script that mounts a Svelte component rendering a Cinder badge. */
export const CINDER_PANEL_FILES: Readonly<Record<string, string>> = {
  'panel.ts': `import { mountPanel } from '@lostgradient/cinder/panel';
import Panel from './panel.svelte';
mountPanel(Panel, { props: { label: 'Fixture panel' } });
`,
  'panel.svelte': `<script lang="ts">
  import { Badge } from '@lostgradient/cinder';
  import { onMount } from 'svelte';
  let { label }: { label: string } = $props();
  onMount(() => {});
</script>

<Badge>{label}</Badge>
`,
};

/** The text a decoy `svelte` leaves in whatever bundles it. */
export const DECOY_SVELTE = 'DECOY_SVELTE_7f3a91';

/** The text a decoy `@lostgradient/cinder` leaves in whatever bundles it. */
export const DECOY_CINDER = 'DECOY_CINDER_c20b64';

/** A `svelte` and a `@lostgradient/cinder` in a fixture's own `node_modules`, each marked. */
export const DECOY_FILES: Readonly<Record<string, string>> = {
  'node_modules/svelte/package.json': JSON.stringify({
    name: 'svelte',
    type: 'module',
    exports: { '.': './index.js', './internal/client': './internal.js' },
  }),
  'node_modules/svelte/index.js': `export const mount = () => '${DECOY_SVELTE}'; export const onMount = () => {};`,
  'node_modules/svelte/internal.js': `export const marker = '${DECOY_SVELTE}';`,
  'node_modules/@lostgradient/cinder/package.json': JSON.stringify({
    name: '@lostgradient/cinder',
    type: 'module',
    exports: { '.': './index.js', './panel': './panel.js' },
  }),
  'node_modules/@lostgradient/cinder/index.js': `export const Badge = '${DECOY_CINDER}';`,
  'node_modules/@lostgradient/cinder/panel.js': `export const mountPanel = () => '${DECOY_CINDER}';`,
};

/**
 * Build `entry` of `directory` twice through a real cache over a real directory (COR-2219): the
 * first call really builds and stores, the second must serve the stored page with no build. Returns
 * how many builds ran, the names of the stored entries, and both pages.
 */
export async function buildTwiceThroughCache(directory: string, entry: string) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'interborough-panel-cache-'));
  try {
    // The cache stores a page only when no input is newer than the build's start, which keeps a
    // build from being stored under inputs that changed meanwhile. This round trip is about
    // storing and serving a real build, so the clock is past every file's last change; a test of
    // the fence itself is in `panel-build-cache.test.ts`, and a file another test in the same
    // checkout touches while this one builds must not decide this one.
    const cache = createPanelBuildCache({
      directory: cacheDirectory,
      now: () => Date.now() + 60_000,
    });
    let builds = 0;
    const request = {
      entry: pathToFileURL(join(directory, entry)).href,
      title: 'Fixture panel',
      styles: '',
    };
    const serve = () =>
      cache.serve(
        'fixture/panel',
        { ...request, ...panelBuildVersions(), buildCode: panelBuildCodeDigest() },
        async () => {
          builds += 1;
          return buildPanelPage(request);
        },
      );
    const first = await serve();
    const written = await readdir(cacheDirectory);
    const stored = written.filter((name) => name.endsWith('.json'));
    const second = await serve();
    return { builds, stored, first, second };
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

/** The temporary directories of one test file, and what builds in them. */
export type PanelBuildFixtures = {
  /** Write `files` into a new temporary directory and return it. */
  readonly fixture: (files: Readonly<Record<string, string>>) => Promise<string>;
  /** Build `entry` inside `directory` with the host's own dependencies. */
  readonly build: (directory: string, entry: string, styles?: string) => Promise<BuiltPanel>;
  /** Remove every directory this made. Call it from `afterEach`. */
  readonly cleanup: () => Promise<void>;
};

/** Start a set of temporary fixture directories. */
export function panelBuildFixtures(): PanelBuildFixtures {
  const directories: string[] = [];
  return {
    fixture: async (files) => {
      const directory = await mkdtemp(join(tmpdir(), 'interborough-panel-build-'));
      directories.push(directory);
      for (const [name, contents] of Object.entries(files)) {
        const path = join(directory, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents);
      }
      return directory;
    },
    build: (directory, entry, styles = '') =>
      buildPanelPage({
        entry: pathToFileURL(join(directory, entry)).href,
        title: 'Fixture panel',
        styles,
      }),
    cleanup: async () => {
      for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
