import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { Component } from 'svelte';
import { appFixtureDeclarations } from '../src/app-fixture-declarations.ts';
import { loadFixture } from '../src/fixture-loader.ts';
import { assertUniqueFixtureNames, manifestFilePath, readManifest } from '../src/manifest.ts';
import { createFixtureServer, handleFixtureRequest } from '../src/server.ts';

test('native fixture routes preserve hash, snapshot, asset, and readiness contracts', async () => {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), 'corvidae-native-fixtures-'));
  await Bun.write(
    resolve(outputDirectory, 'index.html'),
    '<html lang="en"><body>fixture</body></html>',
  );
  await Bun.write(resolve(outputDirectory, 'fixture.css'), '.fixture { color: red; }');
  const server = createFixtureServer({
    outputDirectory,
    manifestPath: manifestFilePath(),
    port: 0,
    development: false,
  });
  try {
    const manifest = readManifest();
    const entry = manifest.entries.find((candidate) => candidate.fixtures?.length);
    if (!entry?.fixtures?.[0]) throw new Error('Expected an actual fixture entry');
    const fixture = entry.fixtures[0];
    const named = `/page/${entry.slug}?fixture=${fixture.name}`;
    const request = (path: string) => fetch(new URL(path, server.url));
    const ready = await request('/ready');
    expect(ready.status).toBe(200);
    const manifestResponse = await request('/api/manifest');
    expect(await manifestResponse.json()).toEqual(manifest);
    const unknown = await request('/page/unknown-fixture');
    expect(unknown.status).toBe(404);
    const missingHash = await request(named);
    expect(missingHash.status).toBe(400);
    const staleHash = await request(`${named}&fixtureContentHash=${'0'.repeat(64)}`);
    expect(staleHash.status).toBe(409);
    const page = await request(
      `${named}&fixtureContentHash=${fixture.fixtureContentHash}&snapshot=1`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-snapshot-mode');
    const stylesheet = await request('/fixture.css');
    expect(stylesheet.headers.get('content-type')).toContain('text/css');
    expect(await stylesheet.text()).toContain('.fixture');
    for (const path of ['/%E0%A4%A', '/..%2f..%2fpackage.json', '/%00']) {
      const malformed = await request(path);
      expect(malformed.status, path).toBe(400);
    }
    const missingAsset = await request('/missing.js');
    expect(missingAsset.status).toBe(404);
  } finally {
    await server.stop(true);
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('the generated fixture map contains exactly the two owning component directories', async () => {
  const { fixtureModules } = await import('../.playwright/fixture-modules.ts');
  const sourceRoot = resolve(import.meta.dirname, '../src');
  const expected = [
    '../../../components/cinder/src/components/*/*-fixtures.ts',
    '../../../components/chat/src/lib/components/*/*-fixtures.ts',
  ].flatMap((pattern) => Array.from(new Bun.Glob(pattern).scanSync({ cwd: sourceRoot })));
  const paths = Object.keys(fixtureModules);
  expect(paths.toSorted()).toEqual(expected.toSorted());
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) expect(basename(path)).toBe(`${basename(dirname(path))}-fixtures.ts`);
});

test('the generated manifest has one identity per component fixture name', () => {
  const manifest = readManifest();
  expect(() => assertUniqueFixtureNames(manifest.entries)).not.toThrow();
});

test('duplicate fixture identities fail with their component identity', () => {
  const fixture = {
    name: 'primary',
    mode: 'host' as const,
    fixtureContentHash: 'a'.repeat(64),
    category: 'visual-contract' as const,
  };
  expect(() =>
    assertUniqueFixtureNames([
      { name: 'Button', slug: 'button', route: '/page/button', fixtures: [fixture, fixture] },
    ]),
  ).toThrow("Duplicate fixture 'button/primary'.");
});

test('the same fixture name is allowed across distinct components', () => {
  const fixture = {
    name: 'assertion',
    mode: 'host' as const,
    fixtureContentHash: 'a'.repeat(64),
    category: 'visual-contract' as const,
  };
  expect(() =>
    assertUniqueFixtureNames([
      { name: 'Button', slug: 'button', route: '/page/button', fixtures: [fixture] },
      { name: 'Input', slug: 'input', route: '/page/input', fixtures: [fixture] },
    ]),
  ).not.toThrow();
});

test('every declared app fixture resolves and unknown names are rejected', async () => {
  const host: Component = () => ({});
  const appHostModules = Object.fromEntries(
    Object.keys(appFixtureDeclarations).map((component) => [
      `./fixtures/${component}.svelte`,
      async () => ({ default: host }),
    ]),
  );

  for (const [component, names] of Object.entries(appFixtureDeclarations)) {
    for (const name of names) {
      const loaded = await loadFixture(component, name, {
        fixtureModules: {},
        hostModules: {},
        appHostModules,
      });
      expect(loaded.fixture).toMatchObject({
        name,
        host: `./app/${component}.svelte`,
      });
      expect(loaded.component).toBe(host);
    }
  }

  expect(
    await throwingRejectionOf(
      loadFixture('dropdown', 'unknown', { fixtureModules: {}, hostModules: {}, appHostModules }),
    ),
  ).toThrow("Fixture 'dropdown/unknown' was not found.");
});

const loadMissingHostDeclaration = async () => ({
  default: [{ name: 'assertion', host: './missing.svelte', category: 'visual-contract' as const }],
});

test('lazy fixture loading reports a missing selected host', async () => {
  const error = await loadFixture('example', 'assertion', {
    fixtureModules: {
      '../../../components/cinder/src/components/example/example-fixtures.ts':
        loadMissingHostDeclaration,
    },
    hostModules: {},
    appHostModules: {},
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : String(error)).toBe(
    "Fixture host './missing.svelte' was not found.",
  );
});

test('returns 400 for malformed component URI escapes', async () => {
  const response = await handleFixtureRequest(
    new Request('http://localhost/page/%E0%A4%A'),
    manifestFilePath(),
    async () => '<html lang="en"></html>',
  );
  expect(response?.status).toBe(400);
  expect(await response?.text()).toContain('Invalid component URI');
});

test('unexpected manifest read errors reject readiness and manifest requests', async () => {
  for (const pathname of ['/ready', '/api/manifest']) {
    expect(
      await rejectionOf(
        handleFixtureRequest(
          new Request(`http://localhost${pathname}`),
          '/manifest-that-does-not-exist.json',
          async () => '<html lang="en"></html>',
        ),
      ),
    ).toBeInstanceOf(Error);
  }
});

test('source fixtures resolve hosts beside their owning package', async () => {
  const host: Component = () => ({});
  const fixture = {
    name: 'private-harness',
    host: './chat-private-harness.fixture.svelte',
    category: 'interaction-state' as const,
  };
  const loaded = await loadFixture('chat', fixture.name, {
    fixtureModules: {
      '../../../components/chat/src/lib/components/chat/chat-fixtures.ts': async () => ({
        default: [fixture],
      }),
    },
    hostModules: {
      '../../../components/chat/src/lib/components/chat/chat-private-harness.fixture.svelte':
        async () => ({ default: host }),
    },
    appHostModules: {},
  });
  expect(loaded.fixture).toEqual(fixture);
  expect(loaded.component).toBe(host);
});

test('ambiguous source component owners fail rather than selecting a package', async () => {
  expect(
    await throwingRejectionOf(
      loadFixture('example', 'assertion', {
        fixtureModules: {
          '../../../components/cinder/src/components/example/example-fixtures.ts':
            loadMissingHostDeclaration,
          '../../../components/chat/src/lib/components/example/example-fixtures.ts':
            loadMissingHostDeclaration,
        },
        hostModules: {},
        appHostModules: {},
      }),
    ),
  ).toThrow("Multiple fixture owners for 'example'.");
});
