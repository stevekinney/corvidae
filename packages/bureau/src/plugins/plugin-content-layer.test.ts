/**
 * COR-1897 — the agent files a running plugin ships (`content/agents` under its `content` URL) are a
 * read-only layer beneath the owner's agent sources, listed as `plugin:name` and able to use the
 * plugin's own tools. A plugin that is disabled or skipped ships nothing, and the owner's sources
 * the caller gave, one or several, keep working beside the layers composition adds.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { AgentFileError } from '../agent-file';
import { agentFileDirectory } from '../sources/agent-file-directory';
import { type FileBureauHarness, startFileBureau } from '../testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support';

const directories: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-plugin-content-'));
  directories.push(directory);
  return directory;
}

/** A content folder holding the agent `greeter`, which uses the plugin's own tool. */
async function contentWithGreeter(): Promise<URL> {
  const content = await temporaryDirectory();
  await mkdir(join(content, 'agents'));
  await writeFile(
    join(content, 'agents', 'greeter.md'),
    agentFileText({ name: 'Greeter', model: KNOWN_MODEL, tools: '[shipper:greet]' }),
  );
  return pathToFileURL(`${content}/`);
}

function shipper(content: URL | undefined) {
  return definePlugin({
    name: 'shipper',
    version: '1.0.0',
    description: 'Ships an agent and the tool it uses.',
    ...(content === undefined ? {} : { content }),
    setup: () => ({
      tools: [
        createTool({
          name: 'greet',
          description: 'Greets someone',
          input: z.object({}),
          metadata: { readOnly: true },
          execute: async () => 'hello',
        }),
      ],
    }),
  });
}

/** What the host that reads files supplies: `<content>/agents` as the plugin's read-only layer. */
function pluginAgentSource(plugin: string, content: URL) {
  return content.protocol === 'file:'
    ? agentFileDirectory(join(fileURLToPath(content), 'agents'), { plugin })
    : undefined;
}

async function start(options: {
  readonly content: URL | undefined;
  readonly enabled?: boolean;
  readonly several?: boolean;
  readonly reader?: boolean;
}) {
  const owner = await temporaryDirectory();
  const harness = await startFileBureau({
    directory: owner,
    overrides: {
      ...(options.several === true
        ? {
            agentSource: [
              agentFileDirectory(owner),
              agentFileDirectory(await temporaryDirectory()),
            ],
          }
        : { agentSource: agentFileDirectory(owner) }),
      ...(options.reader === false ? {} : { pluginAgentSource }),
      plugins: [
        { descriptor: shipper(options.content), source: 'package', location: '@example/shipper' },
      ],
      pluginConfiguration: { shipper: { enabled: options.enabled ?? true } },
    },
  });
  harnesses.push(harness);
  await harness.bureau.agents.refresh();
  return { harness, owner, agents: harness.bureau.agents };
}

describe('the agents a running plugin ships', () => {
  it('list as plugin:name, ready with the plugin’s own tool, and refuse a write as read-only', async () => {
    const { agents } = await start({ content: await contentWithGreeter() });

    expect(agents.list().find((listing) => listing.id === 'shipper:greeter')).toMatchObject({
      source: 'file',
      state: 'ready',
      plugin: 'shipper',
    });
    const read = await agents.read('shipper:greeter');
    const error = await agents.delete('shipper:greeter', { expectedHash: read?.hash ?? '' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as AgentFileError).code).toBe('agent-file-read-only');
  });

  it('are layered beneath several owner sources the caller gave', async () => {
    const { agents } = await start({ content: await contentWithGreeter(), several: true });

    expect(agents.list().map((listing) => listing.id)).toContain('shipper:greeter');
  });

  it('are absent when the plugin is disabled', async () => {
    const { agents } = await start({ content: await contentWithGreeter(), enabled: false });

    expect(agents.list().map((listing) => listing.id)).not.toContain('shipper:greeter');
  });

  it('are none when the plugin declares no content', async () => {
    const { agents } = await start({ content: undefined });

    expect(agents.list().some((listing) => listing.plugin === 'shipper')).toBe(false);
  });

  it('are none when the host supplies no reader for the content', async () => {
    const { agents } = await start({ content: await contentWithGreeter(), reader: false });

    expect(agents.list().some((listing) => listing.plugin === 'shipper')).toBe(false);
  });

  it('are none when the reader declines the content', async () => {
    const { agents } = await start({ content: new URL('https://example.com/content/') });

    expect(agents.list().some((listing) => listing.plugin === 'shipper')).toBe(false);
  });
});
