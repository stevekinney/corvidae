/**
 * The class guard for plugin contributions the host processes at startup (COR-1888 round 2). A
 * plugin's contribution may be malformed, but it must never stop the host: the plugin is skipped
 * with a problem, or runs with a problem, and every other plugin keeps running. This test starts
 * the real host once with a folder plugin for each kind of startup step in a broken form, so a
 * future startup step that throws for a plugin fails here:
 *
 * - an MCP app whose entry does not build (the page is built at startup);
 * - two MCP apps opened from the same tool (the host links a tool to one page);
 * - a plugin named `bureau` (the built-in plugin and its tool-source id hold the name);
 * - a plugin declaring a secret the host keeps for itself (secrets are provisioned at startup);
 * - a stored provider allowlist that names a model its provider does not offer.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A folder plugin whose `setup` returns `contributions` and whose `extra` joins its descriptor. */
const pluginSource = (name: string, contributions: string, extra = ''): string =>
  `import { definePlugin } from '@lostgradient/interborough-plugin';
export default definePlugin({
  name: '${name}', version: '1.0.0', description: 'The ${name} plugin.'${extra},
  setup: () => (${contributions}),
});
`;

/** An MCP app whose entry is `./app.ts` beside the plugin (written when `buildable`, else absent). */
const appSource = (name: string, tool: string, entry = './app.ts'): string =>
  `{ name: '${name}', title: '${name}', uri: 'ui://fixture/${name}/v1', entry: new URL('${entry}', import.meta.url),
    allowedTools: ['${tool}'], opensFromTool: '${tool}' }`;

async function writeFolderPlugin(
  plugins: string,
  folder: string,
  source: string,
  buildable: boolean,
): Promise<void> {
  const path = join(plugins, folder);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'plugin.ts'), source);
  if (buildable) await writeFile(join(path, 'app.ts'), "document.body.textContent = 'ok';\n");
}

type Standing = {
  readonly descriptor: { readonly name: string };
  readonly source: string;
  readonly status: string;
  readonly problems: readonly Record<string, unknown>[];
};

test('a plugin contributing a malformed startup input is skipped or carries a problem, and the host starts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-broken-contributions-'));
  directories.push(home);
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    bungalow.writeSecret('openai-api-key', 'fixture-broken-contributions-key-1');
  } finally {
    bungalow.close();
  }
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ plugins: { openai: { configuration: { models: ['gpt-nonexistent'] } } } }),
  );
  const plugins = join(home, 'plugins');
  await writeFolderPlugin(
    plugins,
    'broken-entry',
    pluginSource(
      'broken-entry',
      `{ mcpApps: [${appSource('broken', 'bureau.tasks.events', './missing.ts')}] }`,
    ),
    false,
  );
  await writeFolderPlugin(
    plugins,
    'first-opener',
    pluginSource('first-opener', `{ mcpApps: [${appSource('first', 'bureau.tasks.cancel')}] }`),
    true,
  );
  await writeFolderPlugin(
    plugins,
    'second-opener',
    pluginSource('second-opener', `{ mcpApps: [${appSource('second', 'bureau.tasks.cancel')}] }`),
    true,
  );
  await writeFolderPlugin(plugins, 'bureau', pluginSource('bureau', '{}'), false);
  await writeFolderPlugin(
    plugins,
    'greedy',
    pluginSource('greedy', '{}', ", secrets: [{ key: 'approval-secret', generated: true }]"),
    false,
  );
  await writeFolderPlugin(plugins, 'fine', pluginSource('fine', '{}'), false);

  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
    log: () => {},
  });
  hosts.push(host);

  const response = await fetch(new URL('/host/plugins', host.url));
  const report = (await response.json()) as { plugins: Standing[] };
  const folders = report.plugins.filter(({ source }) => source === 'folder');
  const standing = (name: string) =>
    folders.find(({ descriptor }) => descriptor.name === name) ?? undefined;
  const codes = (name: string) => standing(name)?.problems.map(({ code }) => code);
  expect(standing('broken-entry')?.status).toBe('running');
  expect(codes('broken-entry')).toEqual(['mcp-app-failed']);
  expect(standing('first-opener')).toMatchObject({ status: 'running', problems: [] });
  expect(standing('second-opener')?.status).toBe('skipped');
  expect(codes('second-opener')).toEqual(['name-clash']);
  expect(standing('greedy')?.status).toBe('skipped');
  expect(codes('greedy')).toEqual(['secret-refused']);
  expect(standing('fine')).toMatchObject({ status: 'running', problems: [] });
  // The plugin named `bureau` is skipped beside the built-in one, which is not a folder plugin.
  const bureauCopies = report.plugins.filter(({ descriptor }) => descriptor.name === 'bureau');
  expect(bureauCopies.map(({ source, status }) => [source, status])).toEqual([
    ['built-in', 'running'],
    ['folder', 'skipped'],
  ]);
  const openai = report.plugins.find(({ descriptor }) => descriptor.name === 'openai');
  expect(openai?.status).toBe('skipped');
  expect(openai?.problems.map(({ code }) => code)).toEqual(['configuration-invalid']);
  // The apps that built are served; the one that did not, and the clashing one, are not.
  const uris = (host.bureau.plugins.mcpApps() as readonly { app: { uri: string } }[]).map(
    ({ app }) => app.uri,
  );
  expect(uris).toContain('ui://bureau/run-inspector/v1');
  expect(uris).toContain('ui://fixture/first/v1');
  expect(uris).not.toContain('ui://fixture/broken/v1');
  expect(uris).not.toContain('ui://fixture/second/v1');
});
