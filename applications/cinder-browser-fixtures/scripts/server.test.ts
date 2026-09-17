import { expect, test } from 'bun:test';
import { basename, dirname, resolve } from 'node:path';
import type { Component } from 'svelte';
import { appFixtureDeclarations } from '../src/app-fixture-declarations.ts';
import { loadFixture } from '../src/fixture-loader.ts';
import { assertUniqueFixtureNames, manifestFilePath, readManifest } from '../src/manifest.ts';
import { handleFixtureRequest } from '../src/server.ts';

function responseRecorder(): {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body: string) => void;
} {
  const response = {
    body: '',
    headers: {} as Record<string, string>,
    statusCode: 0,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body: string) {
      this.body = body;
    },
  };
  return response;
}

test('the browser fixture glob cannot include test helpers or other modules', async () => {
  const clientPath = resolve(import.meta.dirname, '../src/main.ts');
  const source = await Bun.file(clientPath).text();
  const patterns = Array.from(
    source.matchAll(/['"]([^'"]+\/\*\/\*-fixtures\.ts)['"]/gu),
    (match) => match[1]!,
  );
  expect(patterns).toHaveLength(2);
  const paths = patterns.flatMap((pattern) =>
    Array.from(new Bun.Glob(pattern).scanSync({ cwd: dirname(clientPath), absolute: true })),
  );
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(basename(path), path).toBe(`${basename(dirname(path))}-fixtures.ts`);
  }
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

  await expect(
    loadFixture('dropdown', 'unknown', { fixtureModules: {}, hostModules: {}, appHostModules }),
  ).rejects.toThrow("Fixture 'dropdown/unknown' was not found.");
});

const loadMissingHostDeclaration = async () => ({
  default: [{ name: 'assertion', host: './missing.svelte', category: 'visual-contract' as const }],
});

test('lazy fixture loading reports a missing selected host', async () => {
  const error = await loadFixture('example', 'assertion', {
    fixtureModules: {
      '../../../packages/cinder/src/components/example/example-fixtures.ts':
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
  const response = responseRecorder();
  let nextError: unknown;
  await handleFixtureRequest(
    { url: '/page/%E0%A4%A' },
    response,
    (error) => {
      nextError = error;
    },
    manifestFilePath(),
    async () => '<html lang="en"></html>',
  );
  expect(response.statusCode).toBe(400);
  expect(response.body).toContain('Invalid component URI');
  expect(nextError).toBeUndefined();
});

test('passes unexpected manifest read errors to next', async () => {
  const response = responseRecorder();
  let nextError: unknown;
  await handleFixtureRequest(
    { url: '/ready' },
    response,
    (error) => {
      nextError = error;
    },
    '/manifest-that-does-not-exist.json',
    async () => '<html lang="en"></html>',
  );
  expect(response.statusCode).toBe(0);
  expect(nextError).toBeInstanceOf(Error);
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
      '../../../packages/chat/src/lib/components/chat/chat-fixtures.ts': async () => ({
        default: [fixture],
      }),
    },
    hostModules: {
      '../../../packages/chat/src/lib/components/chat/chat-private-harness.fixture.svelte':
        async () => ({ default: host }),
    },
    appHostModules: {},
  });
  expect(loaded.fixture).toEqual(fixture);
  expect(loaded.component).toBe(host);
});

test('ambiguous source component owners fail rather than selecting a package', async () => {
  await expect(
    loadFixture('example', 'assertion', {
      fixtureModules: {
        '../../../packages/cinder/src/components/example/example-fixtures.ts':
          loadMissingHostDeclaration,
        '../../../packages/chat/src/lib/components/example/example-fixtures.ts':
          loadMissingHostDeclaration,
      },
      hostModules: {},
      appHostModules: {},
    }),
  ).rejects.toThrow("Multiple fixture owners for 'example'.");
});
