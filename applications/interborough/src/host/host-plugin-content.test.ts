/**
 * COR-1977: the workflow and skill files a running folder plugin ships (`content/workflows` and
 * `content/skills` under its `content` URL) reach the real host. Its workflows are a read-only
 * layer beneath the owner's, listed as `plugin:name` and read again after an edit; its skills are
 * a trusted `plugin` source of the skill catalog. A plugin the owner disabled ships neither.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startHost, type Host } from './host.ts';

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

/** An hourly workflow, so no fire lands while a test runs. */
function workflowText(description: string): string {
  return JSON.stringify({
    name: 'shipper:nightly',
    description,
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [
      {
        kind: 'activity',
        handler: 'agent',
        input: { agent: 'shipper:assistant', message: 'Summarize the night.' },
      },
    ],
  });
}

/** A content folder holding the workflow `nightly` and the skill `greet`. */
async function shippedContent() {
  const content = await scratch('interborough-plugin-content-');
  await mkdir(join(content, 'workflows'));
  await writeFile(join(content, 'workflows', 'nightly.json'), workflowText('first'));
  await mkdir(join(content, 'skills', 'greet'), { recursive: true });
  await writeFile(
    join(content, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: Greets someone.\n---\n\nSay hello.\n',
  );
  return { content, url: pathToFileURL(`${content}/`) };
}

async function startShipper(url: URL, enabled = true): Promise<Host> {
  const home = await scratch('interborough-plugin-content-home-');
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ plugins: { shipper: { enabled } } }),
  );
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
    plugins: [
      {
        descriptor: definePlugin({
          name: 'shipper',
          version: '1.0.0',
          description: 'Ships a workflow and a skill.',
          content: url,
        }),
        source: 'package',
        location: '@fixture/shipper',
      },
    ],
  });
  hosts.push(host);
  return host;
}

async function listedSkills(host: Host) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.skills.list', params: {} }),
  });
  const body = (await response.json()) as {
    result: { skills: Array<Record<string, unknown>>; sources: Array<Record<string, unknown>> };
  };
  return body.result;
}

describe('the workflows a running folder plugin ships', () => {
  test('are listed as plugin:name, refuse a write as read-only, and are read again after an edit', async () => {
    const { content, url } = await shippedContent();
    const host = await startShipper(url);
    const workflows = host.bureau.workflows;

    expect(workflows?.list().find((listing) => listing.id === 'shipper:nightly')).toMatchObject({
      state: 'ready',
    });
    const refusal = await workflows?.delete('shipper:nightly', { expectedHash: 'x' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ code: 'workflow-file-read-only' });

    await writeFile(join(content, 'workflows', 'nightly.json'), workflowText('second'));
    await workflows?.refresh();

    const detail = await workflows?.get('shipper:nightly');
    expect(detail?.description).toBe('second');
  });

  test('are absent when the plugin is disabled', async () => {
    const { url } = await shippedContent();
    const host = await startShipper(url, false);

    expect(host.bureau.workflows?.list().map((listing) => listing.id)).not.toContain(
      'shipper:nightly',
    );
  });
});

describe('the skills a running folder plugin ships', () => {
  test('are discoverable from a trusted plugin source', async () => {
    const { url } = await shippedContent();
    const host = await startShipper(url);

    const listed = await listedSkills(host);

    expect(listed.skills).toEqual([
      expect.objectContaining({
        name: 'greet',
        source: expect.objectContaining({
          id: 'plugin:shipper',
          kind: 'plugin',
          plugin: 'shipper',
        }),
        trust: 'trusted',
        available: true,
      }),
    ]);
    expect(listed.sources.map((source) => [source['id'], source['trust']])).toEqual([
      ['plugin:shipper', 'trusted'],
    ]);
  });

  test('are absent when the plugin is disabled', async () => {
    const { url } = await shippedContent();
    const host = await startShipper(url, false);

    const listed = await listedSkills(host);

    expect(listed.skills).toEqual([]);
    expect(listed.sources).toEqual([]);
  });
});
