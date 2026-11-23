import type { PluginPanel } from '@lostgradient/interborough-plugin';
import {
  pendingReview,
  runInspector,
  scheduleEditor,
  workflowRevisionReview,
} from '@lostgradient/plugin-inspectors';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createPanelBuildCache,
  type PanelBuildCache,
  type PanelBuildInputs,
} from './panel-build-cache.ts';
import { stubPanelBuild } from './panel-build-stub.test-support.ts';
import {
  PANEL_BUILD_DEADLINE_MILLISECONDS,
  digestOf,
  panelBuildCodeDigest,
  panelBuildVersions,
  withPanelBuildDeadline,
} from './panel-build.ts';
import {
  MCP_APP_MIME_TYPE,
  MCP_APP_UI_META,
  PANEL_DIGEST_KEY_PREFIX,
  commitPanelDigests,
  panelMounts as mountOnly,
  type ContributedPanels,
  type PanelMountOptions,
} from './panel-mounts.ts';

/** `mountOnly` over storage of its own: a start that has served nothing before. */
const panelMounts = (contributed: ContributedPanels, prebuiltDirectory?: string) =>
  mountOnly(
    contributed,
    new MemoryStorage(),
    prebuiltDirectory === undefined ? {} : { prebuiltDirectory },
  );

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A plugin app whose entry is a one-line module written to a fresh directory. */
async function app(name: string, overrides: Partial<PluginPanel> = {}): Promise<PluginPanel> {
  const directory = await mkdtemp(join(tmpdir(), 'panel-mounts-'));
  directories.push(directory);
  const entry = join(directory, 'app.ts');
  await writeFile(entry, `document.body.textContent = ${JSON.stringify(name)};\n`);
  return {
    name,
    title: `The ${name} page`,
    description: `What ${name} shows.`,
    uri: `ui://test/${name}/v1`,
    entry: pathToFileURL(entry),
    styles: 'body{margin:0}',
    allowedTools: [`bureau.test.${name}`],
    opensFromTool: `bureau.test.${name}`,
    ...overrides,
  };
}

const contributed = (...apps: PluginPanel[]): ContributedPanels =>
  apps.map((each) => ({ plugin: 'test', version: '1.0.0', app: each }));

describe('the MCP apps the host serves', () => {
  it('builds a self-contained, digested page for each contributed app', async () => {
    const { resources } = await panelMounts(contributed(await app('one'), await app('two')));
    expect(resources.map(({ uri }) => uri)).toEqual(['ui://test/one/v1', 'ui://test/two/v1']);
    for (const resource of resources) {
      const meta = resource._meta as { contentDigest: string };
      expect(resource.mimeType).toBe(MCP_APP_MIME_TYPE);
      expect(meta.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(digestOf(resource.text)).toBe(meta.contentDigest);
      expect(resource.text).not.toMatch(/<script[^>]+src=/);
      expect(resource.text).not.toMatch(/<link[^>]+href=/);
      expect(resource.text).toContain('<style>body{margin:0}</style>');
    }
    expect(resources[0]).toMatchObject({
      name: 'one',
      title: 'The one page',
      description: 'What one shows.',
    });
  });

  describe('the prebuilt pages of a release (COR-2217)', () => {
    const html = '<meta charset="utf-8"><div id="root"></div>';

    async function prebuiltDirectory(files: Readonly<Record<string, string>>): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), 'panel-prebuilt-'));
      directories.push(directory);
      for (const [name, contents] of Object.entries(files)) {
        await writeFile(join(directory, name), contents);
      }
      return directory;
    }

    it('uses a prebuilt page for any plugin, without changing its HTML digest contract', async () => {
      const candidate = await app('one');
      const directory = await prebuiltDirectory({
        'one.json': JSON.stringify({ uri: candidate.uri, html, contentDigest: digestOf(html) }),
      });
      // A folder plugin's name, not the one workspace plugin a condition used to name.
      for (const plugin of ['folder-plugin', 'inspectors', 'test']) {
        const { resources, fallbacks } = await panelMounts(
          [{ plugin, version: '1.0.0', app: candidate }],
          directory,
        );
        expect(resources[0]?.text, plugin).toBe(html);
        expect(resources[0]?._meta, plugin).toMatchObject({ contentDigest: digestOf(html) });
        expect(fallbacks, plugin).toEqual([]);
      }
    });

    it('names no plugin in the source that chooses between a prebuilt and a built page', async () => {
      const source = await Bun.file(new URL('./panel-mounts.ts', import.meta.url)).text();
      expect(source).not.toContain("'inspectors'");
      expect(source).not.toMatch(/plugin\s*[!=]==?\s*'/);
    });

    it('builds a panel with no prebuilt file, and has no reason to give', async () => {
      const directory = await prebuiltDirectory({});
      const { resources, fallbacks } = await panelMounts(
        contributed(await app('absent')),
        directory,
      );
      expect(resources[0]?.text).toContain('absent');
      expect(fallbacks).toEqual([]);
    });

    const invalid: ReadonlyArray<{
      readonly name: string;
      readonly file: (uri: string) => string;
      readonly reason: RegExp;
    }> = [
      { name: 'is not JSON', file: () => '{not-json', reason: /not JSON/ },
      { name: 'is not an object', file: () => '[]', reason: /not a prebuilt panel/ },
      {
        name: 'has no uri',
        file: () => JSON.stringify({ html, contentDigest: digestOf(html) }),
        reason: /uri/,
      },
      {
        name: 'has a digest that is not a sha256',
        file: (uri) => JSON.stringify({ uri, html, contentDigest: 'sha256:fixture' }),
        reason: /contentDigest/,
      },
      {
        name: 'holds bytes its digest does not name',
        file: (uri) =>
          JSON.stringify({ uri, html: `${html}<!-- edited -->`, contentDigest: digestOf(html) }),
        reason: /does not match its own contentDigest/,
      },
      {
        name: 'was built for another panel, one with the same name',
        file: () =>
          JSON.stringify({ uri: 'ui://other/one/v1', html, contentDigest: digestOf(html) }),
        reason: /was built for ui:\/\/other\/one\/v1, not ui:\/\/test\/one\/v1/,
      },
    ];

    for (const { name, file, reason } of invalid) {
      it(`builds the panel and reports why when the prebuilt file ${name}`, async () => {
        const candidate = await app('one');
        const directory = await prebuiltDirectory({ 'one.json': file(candidate.uri) });
        const { resources, fallbacks, failures } = await panelMounts(
          contributed(candidate),
          directory,
        );
        expect(failures).toEqual([]);
        expect(resources[0]?.text).toContain('<style>body{margin:0}</style>');
        expect(resources[0]?.text).not.toBe(html);
        expect(fallbacks).toHaveLength(1);
        expect(fallbacks[0]).toMatchObject({ plugin: 'test', app: 'one' });
        expect(fallbacks[0]?.reason).toMatch(reason);
      });
    }

    it('keeps the reason when the fallback build fails too', async () => {
      const candidate = await app('broken', {
        entry: pathToFileURL(join(tmpdir(), 'panel-mounts-no-such-entry.ts')),
      });
      const directory = await prebuiltDirectory({ 'broken.json': '{not-json' });
      const { failures, fallbacks } = await panelMounts(contributed(candidate), directory);
      expect(failures).toHaveLength(1);
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]?.reason).toMatch(/not JSON/);
    });

    it('lists the reasons in the order the panels were contributed', async () => {
      const first = await app('first');
      const second = await app('second');
      const directory = await prebuiltDirectory({
        'first.json': '{',
        'second.json': '{',
      });
      const { fallbacks } = await panelMounts(contributed(first, second), directory);
      expect(fallbacks.map(({ app: name }) => name)).toEqual(['first', 'second']);
    });
  });

  it('declares deny-by-default security on every app', async () => {
    const { resources } = await panelMounts(contributed(await app('one')));
    expect(resources[0]?._meta).toMatchObject({ ui: MCP_APP_UI_META });
    expect(MCP_APP_UI_META.csp).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(MCP_APP_UI_META.permissions).toEqual({});
  });

  it('links the tool that opens an app to its page, and no other allowed tool', async () => {
    const { toolMeta } = await panelMounts(
      contributed(
        await app('one', { allowedTools: ['a.first', 'a.second'], opensFromTool: 'a.second' }),
        await app('two'),
      ),
    );
    expect(Object.keys(toolMeta).toSorted()).toEqual(['a.first', 'a.second', 'bureau.test.two']);
    expect(toolMeta['a.second']).toEqual({
      ui: { resourceUri: 'ui://test/one/v1', visibility: ['model', 'app'] },
    });
    expect(toolMeta['a.first']).toEqual({ ui: { visibility: ['model', 'app'] } });
  });

  it('shows every allowed tool to apps and every other tool to the model alone (COR-2209)', async () => {
    const { toolMeta, defaultToolMeta } = await panelMounts(
      contributed(
        await app('one', { allowedTools: ['a.shared', 'a.one'], opensFromTool: 'a.one' }),
        await app('two', { allowedTools: ['a.shared', 'a.two'], opensFromTool: 'a.two' }),
      ),
    );
    expect(toolMeta['a.shared']).toEqual({ ui: { visibility: ['model', 'app'] } });
    expect(toolMeta['a.two']).toEqual({
      ui: { resourceUri: 'ui://test/two/v1', visibility: ['model', 'app'] },
    });
    expect(defaultToolMeta).toEqual({ ui: { visibility: ['model'] } });
  });

  it('adds the schedule editor and changes the marking of exactly the tools it lists (COR-2545)', async () => {
    const inspectors = (...panels: PluginPanel[]): ContributedPanels =>
      panels.map((each) => ({ plugin: 'inspectors', version: '1.0.1', app: each }));
    const without = await mountOnly(
      inspectors(runInspector, pendingReview, workflowRevisionReview),
      new MemoryStorage(),
      { build: stubPanelBuild },
    );
    const withEditor = await mountOnly(
      inspectors(runInspector, pendingReview, workflowRevisionReview, scheduleEditor),
      new MemoryStorage(),
      { build: stubPanelBuild },
    );
    // A tool the editor lists, which no other panel listed, is now shown to apps. Every other
    // tool's marking, the opener links included, is what it was.
    const changed = Object.keys(withEditor.toolMeta)
      .filter(
        (tool) =>
          JSON.stringify(withEditor.toolMeta[tool]) !== JSON.stringify(without.toolMeta[tool]),
      )
      .toSorted();
    expect(changed).toEqual(scheduleEditor.allowedTools.toSorted());
    for (const tool of Object.keys(without.toolMeta)) {
      expect(withEditor.toolMeta[tool], tool).toEqual(without.toolMeta[tool]);
    }
    // The tools the editor made newly app-visible are its reads and its four writes. The writes are
    // not MCP tools, so the marking names no tool a client lists.
    expect(changed.filter((tool) => !without.toolMeta[tool])).toEqual(changed);
    expect(withEditor.defaultToolMeta).toEqual({ ui: { visibility: ['model'] } });
    // The editor links no tool to its page.
    expect(
      Object.values(withEditor.toolMeta).filter((meta) =>
        JSON.stringify(meta).includes(scheduleEditor.uri),
      ),
    ).toEqual([]);
  });

  it('lists each built app with its plugin, its declared tools, and its page, for the panel routes', async () => {
    const { apps, resources } = await panelMounts(
      contributed(
        await app('one', { allowedTools: ['a.first', 'a.second'], opensFromTool: 'a.second' }),
      ),
    );
    expect(apps).toEqual([
      {
        plugin: 'test',
        name: 'one',
        title: 'The one page',
        uri: 'ui://test/one/v1',
        opensFromTool: 'a.second',
        placements: [],
        allowedTools: ['a.first', 'a.second'],
        hostOnlyTools: [],
        html: expect.any(String),
      },
    ]);
    expect(apps[0]?.html).toBe(resources[0]?.text);
  });

  it('links no tool to a panel that names no opener, and still serves its page and placements (COR-2212)', async () => {
    const { opensFromTool: _opener, ...withoutOpener } = await app('one', {
      allowedTools: ['a.first'],
      placements: [{ kind: 'page', path: 'reviews/queue', sidebar: { group: 'work' } }],
    });
    const { apps, resources, toolMeta } = await panelMounts(
      contributed(withoutOpener, await app('two')),
    );
    expect(resources.map(({ uri }) => uri)).toEqual(['ui://test/one/v1', 'ui://test/two/v1']);
    // `a.first` is shown to apps because the panel lists it, but no tool links to the page.
    expect(toolMeta['a.first']).toEqual({ ui: { visibility: ['model', 'app'] } });
    expect(
      Object.values(toolMeta).filter((meta) => JSON.stringify(meta).includes('resourceUri')),
    ).toHaveLength(1);
    expect(apps[0]).not.toHaveProperty('opensFromTool');
    expect(apps[0]?.placements).toEqual([
      { kind: 'page', path: 'reviews/queue', sidebar: { group: 'work' } },
    ]);
  });

  it('serves each placement with only the fields it declares', async () => {
    const stray = { kind: 'run', plugin: 'smuggled' } as never;
    const { apps } = await panelMounts(
      contributed(
        await app('one', {
          placements: [
            {
              kind: 'page',
              path: 'reviews',
              sidebar: { group: 'build', icon: 'inbox', extra: 'x' } as never,
              hidden: true,
            } as never,
            stray,
            { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update', extra: 1 } as never,
            // Bureau does not check an icon, so a value that is not text is left out.
            { kind: 'page', path: 'icons', sidebar: { group: 'system', icon: 42 } } as never,
          ],
        }),
      ),
    );
    expect(apps[0]?.placements).toEqual([
      { kind: 'page', path: 'reviews', sidebar: { group: 'build', icon: 'inbox' } },
      { kind: 'run' },
      { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' },
      { kind: 'page', path: 'icons', sidebar: { group: 'system' } },
    ]);
  });

  it('lists no app whose page did not build', async () => {
    const missing = await app('one', { entry: pathToFileURL(resolve('does-not-exist.ts')) });
    const { apps } = await panelMounts(contributed(missing));
    expect(apps).toEqual([]);
  });

  it('keeps a title from opening a tag and a style from ending its element', async () => {
    const { resources } = await panelMounts(
      contributed(
        await app('one', { title: 'A <b> & more', styles: 'a{}</style><script>x</script>' }),
      ),
    );
    expect(resources[0]?.text).toContain('<title>A &lt;b> &amp; more</title>');
    expect(resources[0]?.text).not.toContain('</style><script>x');
  });

  it('serves nothing when no plugin contributes an app', async () => {
    expect(await panelMounts([])).toEqual({
      resources: [],
      toolMeta: {},
      defaultToolMeta: { ui: { visibility: ['model'] } },
      failures: [],
      fallbacks: [],
      apps: [],
      changes: [],
      pendingDigests: [],
    });
  });

  it('reports an entry that does not build, and still serves the apps that do', async () => {
    // A panel that did not build is not running, so its allowed tools stay model-only.
    const missing = await app('one', {
      allowedTools: ['bureau.test.one', 'a.unbuilt'],
      entry: pathToFileURL(resolve('does-not-exist.ts')),
    });
    const { resources, toolMeta, failures } = await panelMounts(
      contributed(missing, await app('two')),
    );
    expect(resources.map(({ uri }) => uri)).toEqual(['ui://test/two/v1']);
    expect(Object.keys(toolMeta)).toEqual(['bureau.test.two']);
    expect(failures).toEqual([
      { plugin: 'test', app: 'one', message: expect.stringContaining('does-not-exist') },
    ]);
  });

  it('reports nothing when every app builds', async () => {
    const { failures } = await panelMounts(contributed(await app('one')));
    expect(failures).toEqual([]);
  });
});

/** A clock whose timers fire only when the test says so. */
function manualClock() {
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const cleared: number[] = [];
  let next = 1;
  return {
    timers,
    cleared,
    clock: {
      setTimeout: (callback: () => void, milliseconds: number) => {
        const handle = next++;
        timers.set(handle, { callback, milliseconds });
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        cleared.push(handle as number);
        timers.delete(handle as number);
      },
    },
  };
}

/** `mountOnly` over storage of its own, with the build, cache, clock or dependencies a test gives it. */
const panelMounts_ = (contributed: ContributedPanels, options: PanelMountOptions) =>
  mountOnly(contributed, new MemoryStorage(), options);

/**
 * The product's build deadline and the build cache, through `panelMounts` (COR-2219). The build is a
 * counting or never-settling double, and the clock is one the test fires itself: nothing here waits
 * on a real timer. The cache's own rows are in `panel-build-cache.test.ts`.
 *
 * | Row | Situation | Required result |
 * | --- | --- | --- |
 * | warm hit | a second start, inputs unchanged | the build double is not called again |
 * | each input | entry bytes, a graph file, Bun, Svelte or Cinder version changes | the build double is called again |
 * | over the bound | a build that never settles, then the clock fires | `failures` names the panel, the other panels are served |
 * | in time | a build that settles | its timer is cleared, nothing fires |
 * | the constant | | `PANEL_BUILD_DEADLINE_MILLISECONDS` is 30,000 and the timer is set to it |
 * | failure | a build that rejects | not cached, built again by the next start |
 */
describe('bounded and cached panel builds (COR-2219)', () => {
  /** A build double that counts its runs and reports the entry as the one file it read. */
  function countingBuild() {
    const counter = { runs: 0 };
    const build = async (options: { readonly entry: string; readonly title: string }) => {
      counter.runs += 1;
      const html = `<html>${options.title} ${counter.runs}</html>`;
      return { html, contentDigest: digestOf(html), inputs: [fileURLToPath(options.entry)] };
    };
    return { counter, build };
  }

  async function cacheDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'panel-mounts-cache-'));
    directories.push(directory);
    return directory;
  }

  /** A host `node_modules` that holds only the two packages whose versions key a build. */
  async function dependenciesAt(svelte: string, cinder: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'panel-mounts-dependencies-'));
    directories.push(directory);
    await mkdir(join(directory, 'svelte'), { recursive: true });
    await mkdir(join(directory, '@lostgradient', 'cinder'), { recursive: true });
    await writeFile(join(directory, 'svelte', 'package.json'), JSON.stringify({ version: svelte }));
    await writeFile(
      join(directory, '@lostgradient', 'cinder', 'package.json'),
      JSON.stringify({ version: cinder }),
    );
    return directory;
  }

  it('the deadline is 30 seconds, and the build is bounded by exactly that', async () => {
    expect(PANEL_BUILD_DEADLINE_MILLISECONDS).toBe(30_000);
    const { timers, clock } = manualClock();
    const { build } = countingBuild();
    const gate = Promise.withResolvers<void>();
    const slow = async (options: Parameters<typeof build>[0]) => {
      await gate.promise;
      return build(options);
    };
    const mounting = panelMounts_(contributed(await app('one')), { build: slow, clock });
    // The timer is set to the product constant before the build is waited on.
    expect([...timers.values()].map(({ milliseconds }) => milliseconds)).toEqual([
      PANEL_BUILD_DEADLINE_MILLISECONDS,
    ]);
    gate.resolve();
    await mounting;
  });

  it('serves an unchanged panel from the cache on the next start, without building it', async () => {
    const directory = await cacheDirectory();
    const candidate = await app('one');
    const { counter, build } = countingBuild();
    const first = await panelMounts_(contributed(candidate), {
      build,
      cache: createPanelBuildCache({ directory, now: () => Date.now() + 60_000 }),
    });
    expect(counter.runs).toBe(1);
    // A restart: a new cache over the same directory.
    const second = await panelMounts_(contributed(candidate), {
      build,
      cache: createPanelBuildCache({ directory, now: () => Date.now() + 60_000 }),
    });
    expect(counter.runs).toBe(1);
    expect(second.resources[0]?.text).toBe(first.resources[0]?.text);
    expect(second.resources[0]?._meta).toEqual(first.resources[0]?._meta);
  });

  it('builds again when the entry bytes change', async () => {
    const directory = await cacheDirectory();
    const candidate = await app('one');
    const { counter, build } = countingBuild();
    const cache = () => createPanelBuildCache({ directory, now: () => Date.now() + 60_000 });
    await panelMounts_(contributed(candidate), { build, cache: cache() });
    await writeFile(fileURLToPath(candidate.entry), 'document.body.textContent = "edited";\n');
    await panelMounts_(contributed(candidate), { build, cache: cache() });
    expect(counter.runs).toBe(2);
  });

  it('builds again when the resolved Svelte or Cinder version changes, and passes Bun’s', async () => {
    const directory = await cacheDirectory();
    const candidate = await app('one');
    const { counter, build } = countingBuild();
    const cache = () => createPanelBuildCache({ directory, now: () => Date.now() + 60_000 });
    // One host install whose packages are upgraded in place: the same root, other versions.
    const root = await dependenciesAt('5.57.0', '0.1.0');
    const mount = async (svelte: string, cinder: string) => {
      await writeFile(join(root, 'svelte', 'package.json'), JSON.stringify({ version: svelte }));
      await writeFile(
        join(root, '@lostgradient', 'cinder', 'package.json'),
        JSON.stringify({ version: cinder }),
      );
      return panelMounts_(contributed(candidate), { build, cache: cache(), dependencies: root });
    };
    await mount('5.57.0', '0.1.0');
    await mount('5.57.0', '0.1.0');
    expect(counter.runs).toBe(1);
    await mount('5.58.0', '0.1.0');
    expect(counter.runs).toBe(2);
    await mount('5.58.0', '0.2.0');
    expect(counter.runs).toBe(3);
  });

  /** A host `node_modules` whose Cinder has no version and whose kit stylesheet is `kitCss`. */
  async function unversionedRoot(kitCss: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'panel-mounts-root-'));
    directories.push(directory);
    await mkdir(join(directory, 'svelte'), { recursive: true });
    await mkdir(join(directory, '@lostgradient', 'cinder', 'src', 'panel'), { recursive: true });
    await writeFile(
      join(directory, 'svelte', 'package.json'),
      JSON.stringify({ version: '5.57.0' }),
    );
    await writeFile(
      join(directory, '@lostgradient', 'cinder', 'package.json'),
      JSON.stringify({ name: '@lostgradient/cinder' }),
    );
    await writeFile(
      join(directory, '@lostgradient', 'cinder', 'src', 'panel', 'panel.css'),
      kitCss,
    );
    return directory;
  }

  it('never serves a page built from another root’s kit: two roots, one home, different kit', async () => {
    const directory = await cacheDirectory();
    const candidate = await app('external');
    const rootA = await unversionedRoot(':root{--kit:a}');
    const rootB = await unversionedRoot(':root{--kit:b}');
    let builds = 0;
    // What a real build records: the entry, and the kit file under the root it was given.
    const build = async (request: { readonly entry: string; readonly dependencies?: string }) => {
      builds += 1;
      const kit = join(
        request.dependencies!,
        '@lostgradient',
        'cinder',
        'src',
        'panel',
        'panel.css',
      );
      const html = `<style>${await Bun.file(kit).text()}</style>`;
      return { html, contentDigest: digestOf(html), inputs: [fileURLToPath(request.entry), kit] };
    };
    const mount = (dependencies: string) =>
      panelMounts_(contributed(candidate), {
        dependencies,
        build,
        cache: createPanelBuildCache({ directory, now: () => Date.now() + 60_000 }),
      });
    const first = await mount(rootA);
    const second = await mount(rootB);
    expect(builds).toBe(2);
    expect(first.resources[0]?.text).toContain('--kit:a');
    expect(second.resources[0]?.text).toContain('--kit:b');
    expect(second.resources[0]?.text).not.toContain('--kit:a');
  });

  it('gives an unversioned Cinder a digest of what the build resolves, and a versioned one its version', async () => {
    const [rootA, rootB] = [await unversionedRoot(':root{}'), await unversionedRoot(':root{}')];
    const a = panelBuildVersions(rootA);
    const b = panelBuildVersions(rootB);
    expect(a.cinderVersion).toMatch(/^unversioned:[0-9a-f]{64}$/);
    expect(a.cinderVersion).not.toBe(b.cinderVersion);
    expect(a.dependencies).not.toBe(b.dependencies);
    expect(a.dependencies).toBe(realpathSync(rootA));
    const versioned = panelBuildVersions(await dependenciesAt('5.57.0', '0.1.0'));
    expect(versioned.cinderVersion).toBe('0.1.0');
    expect(versioned.svelteVersion).toBe('5.57.0');
  });

  it('keys a build by the host’s own build code too', async () => {
    const seen: PanelBuildInputs[] = [];
    const recording: PanelBuildCache = {
      serve: async (_panel, inputs, build) => {
        seen.push(inputs);
        return build();
      },
    };
    const { build } = countingBuild();
    await panelMounts_(contributed(await app('one')), { build, cache: recording });
    expect(seen[0]?.buildCode).toBe(panelBuildCodeDigest());
    expect(seen[0]?.buildCode).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys a build by the running Bun and the host’s resolved versions', async () => {
    const seen: PanelBuildInputs[] = [];
    const recording: PanelBuildCache = {
      serve: async (_panel, inputs, build) => {
        seen.push(inputs);
        return build();
      },
    };
    const { build } = countingBuild();
    await panelMounts_(contributed(await app('one')), {
      build,
      cache: recording,
      dependencies: await dependenciesAt('5.57.0', '0.1.0'),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      bunVersion: Bun.version,
      svelteVersion: '5.57.0',
      cinderVersion: '0.1.0',
    });
  });

  it('reports a build that does not finish as that panel’s failure, and serves the others', async () => {
    const { timers, clock } = manualClock();
    const { build } = countingBuild();
    const hung = await app('hung', { title: 'Hung' });
    const fine = await app('fine');
    const stalling = (options: Parameters<typeof build>[0]) =>
      options.entry === hung.entry.href ? new Promise<never>(() => {}) : build(options);
    const mounting = panelMounts_(contributed(hung, fine), { build: stalling, clock });
    // `fine` settles and clears its timer; only the hung build keeps one.
    await waitUntil(() => timers.size === 1, { message: 'only the stalled build holds a timer' });
    [...timers.values()][0]!.callback();
    const { failures, resources } = await mounting;
    expect(failures).toEqual([
      {
        plugin: 'test',
        app: 'hung',
        message: 'The Hung page did not finish building within 30 seconds',
      },
    ]);
    expect(resources.map(({ name }) => name)).toEqual(['fine']);
  });

  it('does not serve a build that finishes after its deadline, and stores it for the next start', async () => {
    const directory = await cacheDirectory();
    const candidate = await app('late', { title: 'Late' });
    const { timers, clock } = manualClock();
    const { counter, build } = countingBuild();
    const gate = Promise.withResolvers<void>();
    const late = async (options: Parameters<typeof build>[0]) => {
      await gate.promise;
      return build(options);
    };
    const cache = () => createPanelBuildCache({ directory, now: () => Date.now() + 60_000 });
    const mounting = panelMounts_(contributed(candidate), { build: late, clock, cache: cache() });
    [...timers.values()][0]!.callback();
    const first = await mounting;
    expect(first.failures).toHaveLength(1);
    expect(first.resources).toEqual([]);
    gate.resolve();
    const stored = async (): Promise<boolean> => {
      const names = await readdir(directory);
      return names.some((name) => name.endsWith('.json'));
    };
    await waitUntil(stored, { message: 'the late build is stored' });
    const second = await panelMounts_(contributed(candidate), { build, cache: cache() });
    expect(counter.runs).toBe(1);
    expect(second.failures).toEqual([]);
    expect(second.resources).toHaveLength(1);
  });

  it('clears the timer of a build that finishes, or fails, in time', async () => {
    const { timers, cleared, clock } = manualClock();
    const { build } = countingBuild();
    const failing = (options: Parameters<typeof build>[0]) =>
      options.title.includes('bad') ? Promise.reject(new Error('did not build')) : build(options);
    const { failures } = await panelMounts_(contributed(await app('good'), await app('bad')), {
      build: failing,
      clock,
    });
    expect(failures.map(({ app: name }) => name)).toEqual(['bad']);
    expect(timers.size).toBe(0);
    expect(cleared).toHaveLength(2);
  });

  it('does not store a build that failed, so the next start builds it again', async () => {
    const directory = await cacheDirectory();
    const candidate = await app('one');
    let runs = 0;
    const failing = async (): Promise<never> => {
      runs += 1;
      throw new Error('did not build');
    };
    const cache = () => createPanelBuildCache({ directory, now: () => Date.now() + 60_000 });
    const first = await panelMounts_(contributed(candidate), { build: failing, cache: cache() });
    const second = await panelMounts_(contributed(candidate), { build: failing, cache: cache() });
    expect(first.failures).toHaveLength(1);
    expect(second.failures).toHaveLength(1);
    expect(runs).toBe(2);
  });
});

describe('withPanelBuildDeadline', () => {
  it('clears its timer when the work settles, either way', async () => {
    const resolved = manualClock();
    expect(await withPanelBuildDeadline(Promise.resolve('page'), 'One', resolved.clock)).toBe(
      'page',
    );
    expect(resolved.cleared).toHaveLength(1);
    const rejected = manualClock();
    expect(
      await throwingRejectionOf(
        withPanelBuildDeadline(Promise.reject(new Error('no')), 'One', rejected.clock),
      ),
    ).toThrow('no');
    expect(rejected.cleared).toHaveLength(1);
  });

  it('rejects when the timer fires first, and ignores what the work does afterwards', async () => {
    const stalled = manualClock();
    const gate = Promise.withResolvers<string>();
    const bounded = withPanelBuildDeadline(gate.promise, 'One', stalled.clock);
    [...stalled.timers.values()][0]!.callback();
    expect(await throwingRejectionOf(bounded)).toThrow(
      'The One page did not finish building within 30 seconds',
    );
    gate.resolve('late');
    await gate.promise;
  });
});

describe('the digest the host keeps of the page it served under each URI (COR-2210)', () => {
  const KEY = `${PANEL_DIGEST_KEY_PREFIX}ui://test/one/v1`;
  /** A start that got as far as listening: the mount, then the commit the host runs after it. */
  const mountPanels = async (panels: ContributedPanels, storage: Storage) => {
    const mounted = await mountOnly(panels, storage);
    await commitPanelDigests(storage, mounted.pendingDigests);
    return mounted;
  };

  it('writes nothing itself, and lists the digests to record once the host is listening', async () => {
    const storage = new MemoryStorage();
    const mounted = await mountOnly(contributed(await app('one')), storage);
    expect(await storage.get(KEY)).toBeNull();
    expect(mounted.pendingDigests).toEqual([
      { uri: 'ui://test/one/v1', contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    ]);
    // A start that never committed leaves the next one to report the change.
    await commitPanelDigests(storage, mounted.pendingDigests);
    const changed = await mountOnly(
      contributed(await app('one', { styles: 'body{margin:1px}' })),
      storage,
    );
    expect(changed.changes).toHaveLength(1);
    expect(await recordOf(storage)).toMatchObject({
      contentDigest: mounted.pendingDigests[0]?.contentDigest,
    });
    const again = await mountOnly(
      contributed(await app('one', { styles: 'body{margin:1px}' })),
      storage,
    );
    expect(again.changes).toHaveLength(1);
  });
  const recordOf = async (storage: Storage, key = KEY) => {
    const bytes = await storage.get(key);
    return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
  };
  /** The digest of the first page a mount served. */
  const firstDigest = (mounted: { readonly resources: readonly { _meta?: unknown }[] }): string => {
    const meta = mounted.resources[0]?._meta as { contentDigest?: string } | undefined;
    return meta?.contentDigest ?? '';
  };

  it('records the digest of a first start, and reports no change', async () => {
    const storage = new MemoryStorage();
    const mounted = await mountPanels(contributed(await app('one')), storage);
    expect(mounted.changes).toEqual([]);
    expect(await recordOf(storage)).toEqual({
      schemaVersion: 1,
      contentDigest: firstDigest(mounted),
    });
  });

  it('reports no change when a later start serves the same bytes', async () => {
    const storage = new MemoryStorage();
    await mountPanels(contributed(await app('one')), storage);
    const { changes } = await mountPanels(contributed(await app('one')), storage);
    expect(changes).toEqual([]);
  });

  it('lists a different digest under a served URI with both digests, and still serves the page', async () => {
    const storage = new MemoryStorage();
    const first = await mountPanels(contributed(await app('one')), storage);
    const previous = firstDigest(first);
    const changed = await mountPanels(
      contributed(await app('one', { styles: 'body{margin:1px}' })),
      storage,
    );
    const current = firstDigest(changed);
    expect(current).not.toBe(previous);
    expect(changed.changes).toEqual([
      {
        plugin: 'test',
        app: 'one',
        uri: 'ui://test/one/v1',
        previousDigest: previous,
        contentDigest: current,
      },
    ]);
    // The page is served: a change is a warning, never a refusal.
    expect(changed.apps.map(({ name }) => name)).toEqual(['one']);
    expect(changed.apps[0]?.html).toBe(changed.resources[0]?.text);
    // Recorded now, so the next start with the same bytes is quiet: one warning per change.
    expect(await recordOf(storage)).toEqual({ schemaVersion: 1, contentDigest: current });
    const again = await mountPanels(
      contributed(await app('one', { styles: 'body{margin:1px}' })),
      storage,
    );
    expect(again.changes).toEqual([]);
  });

  it('counts an unreadable record as absent, and writes the current digest over it', async () => {
    const storage = new MemoryStorage();
    for (const bad of [
      '{not-json',
      '{"schemaVersion":2,"contentDigest":"x"}',
      '{"schemaVersion":1}',
    ]) {
      await storage.put(KEY, new TextEncoder().encode(bad));
      const mounted = await mountPanels(contributed(await app('one')), storage);
      expect(mounted.changes).toEqual([]);
      expect(await recordOf(storage)).toEqual({
        schemaVersion: 1,
        contentDigest: firstDigest(mounted),
      });
    }
  });

  it('writes nothing for a page that did not build, and keeps the record it had', async () => {
    const storage = new MemoryStorage();
    const first = await mountPanels(contributed(await app('one')), storage);
    const previous = firstDigest(first);
    const missing = await app('one', { entry: pathToFileURL(resolve('does-not-exist.ts')) });
    const failed = await mountPanels(contributed(missing), storage);
    expect(failed.changes).toEqual([]);
    expect(failed.failures).toHaveLength(1);
    expect(await recordOf(storage)).toEqual({ schemaVersion: 1, contentDigest: previous });
    // A new URI that fails first never gets a record.
    const unbuilt = await app('two', { entry: pathToFileURL(resolve('does-not-exist.ts')) });
    await mountPanels(contributed(unbuilt), storage);
    expect(await storage.get(`${PANEL_DIGEST_KEY_PREFIX}ui://test/two/v1`)).toBeNull();
  });
});
