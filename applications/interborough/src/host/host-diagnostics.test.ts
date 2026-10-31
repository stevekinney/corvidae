/**
 * `Host.diagnostics()` (COR-1732): every field of the reading, and that no provider secret
 * reaches it. The provider key is a fixture written for the test.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { createModelCatalog } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const FIXTURE_KEY = 'fixture-anthropic-key-diagnostics-5d21';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A home that offers the Anthropic provider, with its key in Bungalow's secrets. */
async function homeWithProvider(): Promise<string> {
  const home = await scratch('interborough-diagnostics-home-');
  await writeFile(join(home, 'configuration.json'), JSON.stringify({ plugins: { anthropic: {} } }));
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    bungalow.writeSecret('anthropic-api-key', FIXTURE_KEY);
  } finally {
    bungalow.close();
  }
  return home;
}

async function startAt(home: string, buildDirectory: string): Promise<Host> {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    buildDirectory,
  });
  hosts.push(host);
  return host;
}

async function buildWithIndex(): Promise<string> {
  const build = await scratch('interborough-diagnostics-build-');
  await mkdir(join(build, 'assets'));
  await writeFile(join(build, 'index.html'), '<!doctype html><div id="app"></div>');
  return build;
}

describe('Host.diagnostics', () => {
  test('reports the Bureau, the engine server, the build, and the providers', async () => {
    const home = await homeWithProvider();
    const build = await buildWithIndex();
    const host = await startAt(home, build);

    const reading = host.diagnostics();

    expect(reading.bureau).toEqual(host.bureau.internals.diagnostics());
    expect(reading.bureau.lifecycle).toBe('ready');
    expect(reading.bureau.recovery.failedRunCount).toBe(0);

    expect(reading.weft.lease).toEqual(host.engine.getLeaseHealth());
    expect(reading.weft.workers).toEqual([]);
    expect(reading.weft.connections).toEqual(host.server.connections());
    expect(reading.weft.connections.workers).toBe(0);

    const index = await stat(join(build, 'index.html'));
    expect(reading.build).toEqual({ directory: build, indexModifiedAt: index.mtimeMs });

    const anthropic = createModelCatalog()
      .descriptors.filter(
        (descriptor) => descriptor.provider === 'anthropic' && descriptor.lifecycle !== 'retired',
      )
      .map((descriptor) => descriptor.model);
    expect(reading.providers).toHaveLength(1);
    expect(reading.providers[0]?.name).toBe('anthropic');
    expect(reading.providers[0]?.models).toEqual(anthropic);
    expect(anthropic.length).toBeGreaterThan(0);
  });

  test('reports no providers when none is configured', async () => {
    const home = await scratch('interborough-diagnostics-home-');
    const host = await startAt(home, await buildWithIndex());

    expect(host.diagnostics().providers).toEqual([]);
  });

  test('reports the build as null while index.html is absent, and finds it once it exists', async () => {
    const home = await scratch('interborough-diagnostics-home-');
    const build = await scratch('interborough-diagnostics-build-');
    const host = await startAt(home, build);

    expect(host.diagnostics().build).toBeNull();

    await writeFile(join(build, 'index.html'), '<!doctype html>');
    const index = await stat(join(build, 'index.html'));
    expect(host.diagnostics().build).toEqual({ directory: build, indexModifiedAt: index.mtimeMs });
  });

  test('carries no provider secret: not the key, its file, or the secret’s name', async () => {
    const home = await homeWithProvider();
    const host = await startAt(home, await buildWithIndex());

    const serialized = JSON.stringify(host.diagnostics());

    expect(serialized).not.toContain(FIXTURE_KEY);
    expect(serialized).not.toContain('anthropic-api-key');
    expect(serialized).not.toContain(home);
    expect(serialized).toContain('anthropic');
  });
});
