import type { PluginPanel } from '@lostgradient/interborough-plugin';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { digestOf } from './panel-build.ts';
import {
  MCP_APP_MIME_TYPE,
  MCP_APP_UI_META,
  PANEL_DIGEST_KEY_PREFIX,
  panelMounts as mountPanels,
  type ContributedPanels,
} from './panel-mounts.ts';

/** `mountPanels` over storage of its own: a start that has served nothing before. */
const panelMounts = (contributed: ContributedPanels, prebuiltDirectory?: string) =>
  mountPanels(contributed, new MemoryStorage(), prebuiltDirectory);

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

  it('uses a prebuilt built-in page without changing its HTML digest contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'panel-prebuilt-'));
    directories.push(directory);
    const candidate = await app('one');
    const html = '<meta charset="utf-8"><div id="root"></div>';
    await writeFile(
      join(directory, 'one.json'),
      JSON.stringify({ html, contentDigest: digestOf(html) }),
    );
    const { resources } = await panelMounts(
      [{ plugin: 'inspectors', version: '1.0.0', app: candidate }],
      directory,
    );
    expect(resources[0]?.text).toBe(html);
    expect(resources[0]?._meta).toMatchObject({ contentDigest: digestOf(html) });
  });

  it('falls back to runtime building when the prebuilt page is absent or invalid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'panel-prebuilt-fallback-'));
    directories.push(directory);
    const candidate = await app('fallback');
    await writeFile(join(directory, 'fallback.json'), '{not-json');
    const { resources } = await panelMounts(
      [{ plugin: 'inspectors', version: '1.0.0', app: candidate }],
      directory,
    );
    expect(resources[0]?.text).toContain('fallback');
    expect(resources[0]?.text).not.toBe('{not-json');
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
          ],
        }),
      ),
    );
    expect(apps[0]?.placements).toEqual([
      { kind: 'page', path: 'reviews', sidebar: { group: 'build', icon: 'inbox' } },
      { kind: 'run' },
      { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' },
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
      apps: [],
      changes: [],
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

describe('the digest the host keeps of the page it served under each URI (COR-2210)', () => {
  const KEY = `${PANEL_DIGEST_KEY_PREFIX}ui://test/one/v1`;
  const recordOf = async (storage: Storage, key = KEY) => {
    const bytes = await storage.get(key);
    return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
  };

  it('records the digest of a first start, and reports no change', async () => {
    const storage = new MemoryStorage();
    const { changes, resources } = await mountPanels(contributed(await app('one')), storage);
    expect(changes).toEqual([]);
    const digest = (resources[0]?._meta as { contentDigest: string }).contentDigest;
    expect(await recordOf(storage)).toEqual({ schemaVersion: 1, contentDigest: digest });
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
    const previous = (first.resources[0]?._meta as { contentDigest: string }).contentDigest;
    const changed = await mountPanels(
      contributed(await app('one', { styles: 'body{margin:1px}' })),
      storage,
    );
    const current = (changed.resources[0]?._meta as { contentDigest: string }).contentDigest;
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
      const { changes, resources } = await mountPanels(contributed(await app('one')), storage);
      expect(changes).toEqual([]);
      const digest = (resources[0]?._meta as { contentDigest: string }).contentDigest;
      expect(await recordOf(storage)).toEqual({ schemaVersion: 1, contentDigest: digest });
    }
  });

  it('writes nothing for a page that did not build, and keeps the record it had', async () => {
    const storage = new MemoryStorage();
    const first = await mountPanels(contributed(await app('one')), storage);
    const previous = (first.resources[0]?._meta as { contentDigest: string }).contentDigest;
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
