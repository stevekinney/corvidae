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
import { rejectionOf } from '@lostgradient/testing';
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
const appSource = (plugin: string, name: string, tool: string, entry = './app.ts'): string =>
  `{ name: '${name}', title: '${name}', uri: 'ui://${plugin}/${name}/v1', entry: new URL('${entry}', import.meta.url),
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
    await bungalow.deploymentSecrets.write('openai-api-key', 'fixture-broken-contributions-key-1');
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
      `{ panels: [${appSource('broken-entry', 'broken', 'bureau.tasks.events', './missing.ts')}] }`,
    ),
    false,
  );
  await writeFolderPlugin(
    plugins,
    'first-opener',
    pluginSource(
      'first-opener',
      `{ panels: [${appSource('first-opener', 'first', 'bureau.tasks.cancel')}] }`,
    ),
    true,
  );
  await writeFolderPlugin(
    plugins,
    'second-opener',
    pluginSource(
      'second-opener',
      `{ panels: [${appSource('second-opener', 'second', 'bureau.tasks.cancel')}] }`,
    ),
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
  expect(codes('broken-entry')).toEqual(['panel-failed']);
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
  const uris = (host.bureau.plugins.panels() as readonly { app: { uri: string } }[]).map(
    ({ app }) => app.uri,
  );
  expect(uris).toContain('ui://inspectors/run-inspector/v1');
  expect(uris).toContain('ui://first-opener/first/v1');
  expect(uris).not.toContain('ui://broken-entry/broken/v1');
  expect(uris).not.toContain('ui://second-opener/second/v1');
});

/**
 * A home with one folder plugin, `drifting`, whose panel the test can change between starts, and a
 * `start` that runs a host on it and reads back what it lists for that plugin.
 */
async function driftingHome() {
  const home = await mkdtemp(join(tmpdir(), 'interborough-panel-changed-'));
  directories.push(home);
  // The deployment identity exists before the folder does, as it does on a real machine.
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  bungalow.close();
  const plugins = join(home, 'plugins');
  await writeFolderPlugin(
    plugins,
    'drifting',
    pluginSource(
      'drifting',
      `{ panels: [${appSource('drifting', 'page', 'bureau.tasks.cancel')}] }`,
    ),
    true,
  );
  const start = async (port = 0) => {
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port,
      log: () => {},
    });
    hosts.push(host);
    const pluginsResponse = await fetch(new URL('/host/plugins', host.url));
    const report = (await pluginsResponse.json()) as { plugins: Standing[] };
    const panelsResponse = await fetch(new URL('/host/panels', host.url));
    const panels = (await panelsResponse.json()) as {
      apps: { plugin: string; app: string; uri: string }[];
    };
    const standing = report.plugins.find(({ descriptor }) => descriptor.name === 'drifting');
    return { host, standing, panels: panels.apps.filter(({ plugin }) => plugin === 'drifting') };
  };
  const stop = async (host: Host) => {
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
  };
  const change = () =>
    writeFile(join(plugins, 'drifting', 'app.ts'), "document.body.textContent = 'changed';\n");
  return { start, stop, change };
}

test('a page whose bytes changed under a URI an earlier start served is listed as panel-changed, and still served (COR-2210)', async () => {
  const { start, stop, change } = await driftingHome();
  const first = await start();
  expect(first.standing).toMatchObject({ status: 'running', problems: [] });
  expect(first.panels.map(({ uri }) => uri)).toEqual(['ui://drifting/page/v1']);
  await stop(first.host);

  // The same start again is quiet; changed bytes under the same URI are not.
  const same = await start();
  expect(same.standing).toMatchObject({ status: 'running', problems: [] });
  await stop(same.host);

  await change();
  const changed = await start();
  expect(changed.standing?.status).toBe('running');
  expect(changed.standing?.problems).toEqual([
    {
      code: 'panel-changed',
      app: 'page',
      uri: 'ui://drifting/page/v1',
      previousDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      contentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    },
  ]);
  const [problem] = changed.standing?.problems ?? [];
  expect(problem?.['previousDigest']).not.toBe(problem?.['contentDigest']);
  // Still served.
  expect(changed.panels.map(({ uri }) => uri)).toEqual(['ui://drifting/page/v1']);
});

test('a start that fails after the panels are built leaves the digest record alone, so the next start reports the change (COR-2210)', async () => {
  const { start, stop, change } = await driftingHome();
  const first = await start();
  await stop(first.host);
  await change();

  // The port is held, so the host builds its panels and then cannot listen.
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
  try {
    expect(await rejectionOf(start(holder.port))).toBeInstanceOf(Error);
  } finally {
    await holder.stop(true);
  }

  const reported = await start();
  expect(reported.standing?.problems).toEqual([
    expect.objectContaining({ code: 'panel-changed', uri: 'ui://drifting/page/v1' }),
  ]);
  await stop(reported.host);

  // Recorded now that a start succeeded: one warning per change.
  const quiet = await start();
  expect(quiet.standing).toMatchObject({ status: 'running', problems: [] });
});
