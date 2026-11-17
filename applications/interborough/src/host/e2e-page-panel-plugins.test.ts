/**
 * COR-2213: the fixture plugins the end-to-end suite's plugin-page host loads
 * (`tests/e2e/page-panel-plugins.ts`, `E2E_PLUGIN_PAGES_PORT`). The browser suite cannot run in the
 * unit lane, so this starts a host the way `e2e-server.ts` starts that one, and reads what the
 * browser would: the pages the panels place, the standing of each plugin, and one page served. A
 * fixture that the host refused would otherwise fail every end-to-end specification at once.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { LONG_PAGE_TITLE, pagePanelPlugins } from '../../tests/e2e/page-panel-plugins.ts';
import { startHost, type Host } from './host.ts';
import { workspacePlugins } from './plugins.ts';

const hosts: Host[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a host with the fixture plugins serves their pages and reports each plugin’s standing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-page-plugins-home-'));
  const build = await mkdtemp(join(tmpdir(), 'interborough-page-plugins-build-'));
  directories.push(home, build);
  await mkdir(join(build, 'assets'));
  await writeFile(join(build, 'index.html'), '<!doctype html><div id="app"></div>');
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    plugins: [...workspacePlugins(), ...pagePanelPlugins()],
    port: 0,
    buildDirectory: build,
  });
  hosts.push(host);
  await host.bureau.plugins.ready();

  const panelsResponse = await fetch(new URL('/host/panels', host.url));
  const panels = (await panelsResponse.json()) as {
    apps: { plugin: string; app: string; title: string; placements: unknown[] }[];
  };
  const pages = panels.apps.filter((panel) => panel.plugin.startsWith('e2e-'));
  // The disabled plugin places nothing; every other fixture panel places one page.
  expect(pages.map((panel) => `${panel.plugin}/${panel.app}`)).toEqual([
    'e2e-reports/overview',
    'e2e-reports/queue',
    'e2e-reports/long-title',
    'e2e-reports/hidden',
    'e2e-notes/notes',
    'e2e-chores/chores',
  ]);
  expect(pages.find((panel) => panel.app === 'long-title')?.title).toBe(LONG_PAGE_TITLE);
  expect(pages.find((panel) => panel.app === 'queue')?.placements).toEqual([
    { kind: 'page', path: 'reviews/queue', sidebar: { group: 'build', icon: 'sparkles' } },
  ]);
  expect(pages.find((panel) => panel.app === 'hidden')?.placements).toEqual([
    { kind: 'page', path: 'hidden' },
  ]);

  const pluginsResponse = await fetch(new URL('/host/plugins', host.url));
  const listed = (await pluginsResponse.json()) as {
    plugins: { descriptor: { name: string; title: string }; status: string }[];
  };
  const standing = Object.fromEntries(
    listed.plugins
      .filter((plugin) => plugin.descriptor.name.startsWith('e2e-'))
      .map((plugin) => [plugin.descriptor.name, plugin.status]),
  );
  expect(standing).toEqual({
    'e2e-reports': 'running',
    'e2e-notes': 'needs-setup',
    'e2e-chores': 'needs-setup',
    'e2e-off': 'disabled',
  });

  const page = await fetch(new URL('/host/plugins/e2e-reports/apps/overview', host.url));
  expect(page.status).toBe(200);
  const served = (await page.json()) as { html: string };
  // The unit lane builds a stub of each panel's entry (`panel-build-stub.preload.ts`), so the page
  // is the host's document for the panel, named by its title; the app's own markup is the browser's.
  expect(served.html).toContain('<title>Fixture overview</title>');
});
