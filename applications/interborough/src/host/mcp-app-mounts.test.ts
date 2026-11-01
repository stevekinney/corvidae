import type { PluginMcpApp } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { digestOf } from './mcp-app-build.ts';
import {
  MCP_APP_MIME_TYPE,
  MCP_APP_UI_META,
  mcpAppMounts,
  type ContributedMcpApps,
} from './mcp-app-mounts.ts';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A plugin app whose entry is a one-line module written to a fresh directory. */
async function app(name: string, overrides: Partial<PluginMcpApp> = {}): Promise<PluginMcpApp> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-app-mounts-'));
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

const contributed = (...apps: PluginMcpApp[]): ContributedMcpApps =>
  apps.map((each) => ({ plugin: 'test', version: '1.0.0', app: each }));

describe('the MCP apps the host serves', () => {
  it('builds a self-contained, digested page for each contributed app', async () => {
    const { resources } = await mcpAppMounts(contributed(await app('one'), await app('two')));
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

  it('declares deny-by-default security on every app', async () => {
    const { resources } = await mcpAppMounts(contributed(await app('one')));
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
    const { toolMeta } = await mcpAppMounts(
      contributed(
        await app('one', { allowedTools: ['a.first', 'a.second'], opensFromTool: 'a.second' }),
        await app('two'),
      ),
    );
    expect(Object.keys(toolMeta).toSorted()).toEqual(['a.second', 'bureau.test.two']);
    expect(toolMeta['a.second']).toEqual({
      ui: { resourceUri: 'ui://test/one/v1', visibility: ['model', 'app'] },
    });
  });

  it('keeps a title from opening a tag and a style from ending its element', async () => {
    const { resources } = await mcpAppMounts(
      contributed(
        await app('one', { title: 'A <b> & more', styles: 'a{}</style><script>x</script>' }),
      ),
    );
    expect(resources[0]?.text).toContain('<title>A &lt;b> &amp; more</title>');
    expect(resources[0]?.text).not.toContain('</style><script>x');
  });

  it('serves nothing when no plugin contributes an app', async () => {
    expect(await mcpAppMounts([])).toEqual({
      resources: [],
      toolMeta: {},
      failures: [],
    });
  });

  it('reports an entry that does not build, and still serves the apps that do', async () => {
    const missing = await app('one', { entry: pathToFileURL(resolve('does-not-exist.ts')) });
    const { resources, toolMeta, failures } = await mcpAppMounts(
      contributed(missing, await app('two')),
    );
    expect(resources.map(({ uri }) => uri)).toEqual(['ui://test/two/v1']);
    expect(Object.keys(toolMeta)).toEqual(['bureau.test.two']);
    expect(failures).toEqual([
      { plugin: 'test', app: 'one', message: expect.stringContaining('does-not-exist') },
    ]);
  });

  it('reports nothing when every app builds', async () => {
    const { failures } = await mcpAppMounts(contributed(await app('one')));
    expect(failures).toEqual([]);
  });
});
