/**
 * COR-1881: the host loads the folders in Bungalow's `plugins/` and the ones named for development,
 * and a plugin with a problem is skipped with a problem code while the host starts. Each test
 * starts the real host on a scratch home and reads it over its own HTTP surface.
 */
import { type BureauPluginEntry } from '@lostgradient/bureau';
import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-folder-host-'));
  directories.push(directory);
  return directory;
}

/** A plugin whose code imports from the host's packages, as an owner's folder plugin does. */
const importing = (name: string, extra = ''): string =>
  `import { definePlugin } from '@lostgradient/interborough-plugin';
export default definePlugin({ name: '${name}', version: '1.0.0', description: 'The ${name} plugin.'${extra} });
`;

/** A plugin with no imports, for a folder outside the Bungalow `plugins/` directory. */
const plain = (name: string): string =>
  `export default { name: '${name}', version: '1.0.0', description: 'The ${name} plugin.' };\n`;

async function writePlugin(parent: string, folder: string, source: string): Promise<string> {
  const path = join(parent, folder);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'plugin.ts'), source);
  return path;
}

type Standing = {
  readonly descriptor: { readonly name: string };
  readonly source: string;
  readonly location: string;
  readonly status: string;
  readonly problems: readonly Record<string, unknown>[];
};

type Report = {
  readonly plugins: Standing[];
  readonly unloaded: {
    readonly location: string;
    readonly status: string;
    readonly problems: readonly Record<string, unknown>[];
  }[];
};

async function startAt(
  home: string,
  options: {
    readonly plugins?: readonly BureauPluginEntry[];
    readonly developmentPlugins?: readonly string[];
  } = {},
): Promise<{ host: Host; lines: string[] }> {
  const lines: string[] = [];
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    plugins: [],
    ...options,
    log: (line) => lines.push(line),
  });
  hosts.push(host);
  return { host, lines };
}

async function reportOf(host: Host): Promise<Report> {
  const response = await fetch(new URL('/host/plugins', host.url));
  expect(response.status).toBe(200);
  return (await response.json()) as Report;
}

const named = (report: Report, name: string): Standing | undefined =>
  report.plugins.find((plugin) => plugin.descriptor.name === name);

function packagePlugin(
  name: string,
  secrets: readonly string[] = [],
  generated = false,
): BureauPluginEntry {
  return {
    descriptor: definePlugin({
      name,
      version: '1.0.0',
      description: `The ${name} plugin.`,
      secrets: secrets.map((key) => (generated ? { key, generated: true } : key)),
    }),
    source: 'package',
    location: `@fixture/${name}`,
  };
}

describe('a folder plugin in Bungalow’s plugins/ directory', () => {
  test('loads, with host packages resolved through the link, and is logged once with its status', async () => {
    const home = await scratch();
    const folder = await writePlugin(join(home, 'plugins'), 'alpha', importing('alpha'));

    const { host, lines } = await startAt(home);

    const alpha = named(await reportOf(host), 'alpha');
    expect(alpha).toMatchObject({
      source: 'folder',
      location: folder,
      status: 'running',
      problems: [],
    });
    expect(lines).toEqual([
      'Plugin bureau@1.0.0 (built-in: @lostgradient/bureau): running',
      `Plugin alpha@1.0.0 (folder: ${folder}): running`,
    ]);
  });

  test('that cannot load is reported and logged, the host starts, and the others run', async () => {
    const home = await scratch();
    const plugins = join(home, 'plugins');
    await writePlugin(plugins, 'fine', importing('fine'));
    const broken = await writePlugin(plugins, 'broken', "throw new Error('nothing to see');\n");

    const { host, lines } = await startAt(home);

    const report = await reportOf(host);
    expect(named(report, 'fine')?.status).toBe('running');
    expect(report.unloaded).toHaveLength(1);
    expect(report.unloaded[0]).toMatchObject({ location: broken, status: 'skipped' });
    expect(report.unloaded[0]?.problems).toEqual([
      expect.objectContaining({
        code: 'load-failed',
        message: expect.stringContaining('nothing to see'),
      }),
    ]);
    expect(lines.filter((line) => line.includes('load-failed'))).toHaveLength(1);
    const paths = await fetch(new URL('/host/paths', host.url));
    expect(paths.status).toBe(200);
  });

  test('that clashes with a package plugin is skipped, and the package plugin keeps the name', async () => {
    const home = await scratch();
    const folder = await writePlugin(join(home, 'plugins'), 'shared', importing('shared'));

    const { host } = await startAt(home, { plugins: [packagePlugin('shared')] });

    const report = await reportOf(host);
    const shared = report.plugins.filter((plugin) => plugin.descriptor.name === 'shared');
    expect(shared.map(({ source, status }) => [source, status])).toEqual([
      ['package', 'running'],
      ['folder', 'skipped'],
    ]);
    expect(shared[1]?.problems).toEqual([
      {
        code: 'name-clash',
        name: 'shared',
        first: { source: 'package', location: '@fixture/shared' },
        second: { source: 'folder', location: folder },
      },
    ]);
  });
});

describe('a plugin that declares a secret the host cannot honor', () => {
  const APPROVAL = 'approval-secret';

  async function approvalText(home: string): Promise<string> {
    return readFile(join(home, 'secrets', APPROVAL), 'utf8');
  }

  test('is skipped with secret-refused, and the host starts, for a folder plugin', async () => {
    const home = await scratch();
    await writePlugin(
      join(home, 'plugins'),
      'greedy',
      importing('greedy', `, secrets: [{ key: '${APPROVAL}', generated: true }]`),
    );
    await writePlugin(join(home, 'plugins'), 'modest', importing('modest'));

    const { host, lines } = await startAt(home);

    const report = await reportOf(host);
    const greedy = named(report, 'greedy');
    expect(greedy).toMatchObject({ status: 'skipped', source: 'folder' });
    expect(greedy?.problems).toEqual([
      expect.objectContaining({ code: 'secret-refused', key: APPROVAL }),
    ]);
    expect(named(report, 'modest')?.status).toBe('running');
    expect(
      lines.some(
        (line) => line.startsWith('Plugin greedy@1.0.0') && line.includes('secret-refused'),
      ),
    ).toBe(true);
  });

  test('is skipped with secret-refused, and the host starts, for a package plugin', async () => {
    const home = await scratch();

    const { host } = await startAt(home, {
      plugins: [packagePlugin('greedy', [APPROVAL]), packagePlugin('modest')],
    });

    const report = await reportOf(host);
    expect(named(report, 'greedy')?.status).toBe('skipped');
    expect(named(report, 'greedy')?.problems).toEqual([
      expect.objectContaining({ code: 'secret-refused', key: APPROVAL }),
    ]);
    expect(named(report, 'modest')?.status).toBe('running');
  });

  test('is skipped with secret-refused for a key Bungalow cannot store', async () => {
    const home = await scratch();

    const { host } = await startAt(home, { plugins: [packagePlugin('odd', ['../escape'])] });

    expect(named(await reportOf(host), 'odd')).toMatchObject({
      status: 'skipped',
      problems: [expect.objectContaining({ code: 'secret-refused', key: '../escape' })],
    });
  });

  test('never reaches the host’s own secret: a generated declaration writes nothing and a save is refused', async () => {
    const home = await scratch();
    const { host } = await startAt(home, { plugins: [packagePlugin('greedy', [APPROVAL], true)] });
    const before = await approvalText(home);

    const response = await fetch(new URL(`/host/plugins/greedy/secrets/${APPROVAL}`, host.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'sk-overwritten' }),
    });

    expect(response.status).toBe(400);
    expect(await approvalText(home)).toBe(before);
    expect(JSON.stringify(await reportOf(host))).not.toContain(before);
  });
});

describe('a development plugin folder', () => {
  test('runs and is listed with development-source and the folder', async () => {
    const home = await scratch();
    const folder = await writePlugin(await scratch(), 'wip', plain('wip'));

    const { host, lines } = await startAt(home, { developmentPlugins: [folder] });

    expect(named(await reportOf(host), 'wip')).toMatchObject({
      source: 'folder',
      status: 'running',
      problems: [{ code: 'development-source', path: folder }],
    });
    expect(lines).toEqual([
      'Plugin bureau@1.0.0 (built-in: @lostgradient/bureau): running',
      `Plugin wip@1.0.0 (folder: ${folder}): running; development-source`,
    ]);
  });

  test('that cannot load is reported with load-failed and development-source, and the host starts', async () => {
    const home = await scratch();
    const folder = await writePlugin(await scratch(), 'wip', 'export default 1;\n');

    const { host } = await startAt(home, { developmentPlugins: [folder] });

    const report = await reportOf(host);
    expect(report.unloaded).toHaveLength(1);
    expect(report.unloaded[0]?.problems.map((problem) => problem['code'])).toEqual([
      'load-failed',
      'development-source',
    ]);
  });
});

describe('two folders that declare the same plugin name', () => {
  test('are one plugin to the host and to Bureau: the copy that runs takes the secrets and the update', async () => {
    const home = await scratch();
    // Bureau loads folder plugins by folder name, so `aaa-weather` runs and `weather` is skipped,
    // although the host lists the installed folder first (COR-1881 round 2).
    const declaring = (version: string, secrets: readonly string[]): string =>
      `export default { name: 'weather', version: '${version}', description: 'The weather plugin.', secrets: ${JSON.stringify(secrets)} };\n`;
    await writePlugin(join(home, 'plugins'), 'weather', declaring('1.0.0', ['weather-alpha']));
    const development = await writePlugin(
      await scratch(),
      'aaa-weather',
      declaring('2.0.0', ['weather-alpha', 'weather-beta']),
    );

    const { host } = await startAt(home, { developmentPlugins: [development] });

    const report = await reportOf(host);
    const standings = report.plugins.filter((plugin) => plugin.descriptor.name === 'weather');
    expect(standings.map((standing) => [standing.location, standing.status])).toEqual([
      [development, 'needs-setup'],
      [join(home, 'plugins', 'weather'), 'skipped'],
    ]);
    const secrets = (standing: Standing | undefined) =>
      (standing as unknown as { secrets: { key: string }[] }).secrets.map(({ key }) => key);
    expect(secrets(standings[0])).toEqual(['weather-alpha', 'weather-beta']);

    for (const key of ['weather-alpha', 'weather-beta']) {
      const response = await fetch(new URL(`/host/plugins/weather/secrets/${key}`, host.url), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: `${key}-value` }),
      });
      expect(response.status).toBe(200);
    }
    // Both declared secrets are set, so the copy that runs leaves setup. The skipped copy declares
    // fewer secrets and would have stayed in `needs-setup` forever had the host chosen it.
    const afterReport = await reportOf(host);
    const after = afterReport.plugins.filter((plugin) => plugin.descriptor.name === 'weather');
    expect(after.map((standing) => [standing.location, standing.status])).toEqual([
      [development, 'running'],
      [join(home, 'plugins', 'weather'), 'skipped'],
    ]);
  });
});
