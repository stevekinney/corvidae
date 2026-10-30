/**
 * COR-1873 — layered definition sources. A plugin's directory is a read-only layer beneath the
 * owner's: its agents list as `plugin:name`, reload when their files change, refuse every write,
 * and `duplicate` copies one into the owner's directory with its tools unversioned.
 */
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, type Tool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { AgentFileError } from './agent-file';
import { agentFileDirectory } from './sources/agent-file-directory';
import { SourceReadOnlyError } from './sources/definition-source';
import { layeredAgentSource, layeredWorkflowSource } from './sources/layered-source';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL, lookupTool } from './testing/agent-file-fixtures.test-support';

const createIssue = createTool({
  name: 'linear:create-issue',
  description: 'Creates a Linear issue',
  input: z.object({}),
  metadata: { readOnly: true },
  execute: async () => 'created',
});

const tools: Readonly<Record<string, Tool>> = {
  'lookup-order': lookupTool,
  'linear:create-issue': createIssue,
};

const harnesses: FileBureauHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-layered-'));
  directories.push(directory);
  return directory;
}

function triagerFile(tool = 'linear:create-issue', description = 'Triages issues'): string {
  return agentFileText({
    name: 'Triager',
    description,
    model: KNOWN_MODEL,
    tools: `[${tool}]`,
  });
}

/** Replace `path` with `text` by a rename, so a scan never reads half a file. */
async function replaceFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/** A Bureau over the owner's directory and the `linear` plugin's read-only layer. */
async function startLayered(files: Readonly<Record<string, string>> = {}) {
  const owner = await temporaryDirectory();
  const plugin = await temporaryDirectory();
  for (const [name, text] of Object.entries(files)) await writeFile(join(plugin, name), text);
  const harness = await startFileBureau({
    directory: owner,
    overrides: {
      agentSource: [
        agentFileDirectory(owner, { tools }),
        agentFileDirectory(plugin, { plugin: 'linear', tools }),
      ],
    },
  });
  harnesses.push(harness);
  await harness.bureau.agents.refresh();
  return { harness, owner, plugin, agents: harness.bureau.agents };
}

describe('a plugin layer beneath the owner directory', () => {
  it('lists its agent as plugin:name and refuses a write to it as read-only', async () => {
    const { agents, plugin } = await startLayered({ 'triager.md': triagerFile() });

    expect(agents.list().find((listing) => listing.id === 'linear:triager')).toMatchObject({
      source: 'file',
      state: 'ready',
      name: 'Triager',
      plugin: 'linear',
    });

    const read = await agents.read('linear:triager');
    expect(read?.text).toBe(triagerFile());
    const definition = {
      name: 'Triager',
      model: KNOWN_MODEL,
      tools: ['linear:create-issue'],
      instructions: 'Changed.\n',
    };
    for (const attempt of [
      () => agents.update('linear:triager', definition, { expectedHash: read?.hash ?? '' }),
      () => agents.delete('linear:triager', { expectedHash: read?.hash ?? '' }),
      () => agents.create('linear:other', definition),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AgentFileError);
      expect((error as AgentFileError).code).toBe('agent-file-read-only');
    }
    // A version restore goes through the same writer, and is refused the same way.
    expect(
      await agents.versions.restore('linear:triager', 1, { expectedHash: read?.hash ?? '' }).then(
        () => 'restored',
        (caught: unknown) => (caught as AgentFileError).code,
      ),
    ).toBe('agent-file-read-only');
    expect(await readFile(join(plugin, 'triager.md'), 'utf8')).toBe(triagerFile());
  });

  it('reloads its agent when the layer’s file changes, without a restart', async () => {
    const { agents, plugin } = await startLayered({ 'triager.md': triagerFile() });
    const before = agents.list().find((listing) => listing.id === 'linear:triager');

    await replaceFile(join(plugin, 'triager.md'), triagerFile(undefined, 'Triages faster'));

    await waitUntil(
      () =>
        agents.list().find((listing) => listing.id === 'linear:triager')?.description ===
        'Triages faster',
    );
    const after = agents.list().find((listing) => listing.id === 'linear:triager');
    expect(after?.definitionHash).not.toBe(before?.definitionHash);
    expect(after?.plugin).toBe('linear');
  });

  it('duplicates an agent into the owner directory with its tools as unversioned plugin:name', async () => {
    const { agents, owner } = await startLayered({
      'triager.md': triagerFile(),
      // A pinned version the copy must not keep: files float to whichever version is loaded.
      'pinned.md': triagerFile('linear:create-issue@1.2.0'),
    });

    const duplicated = await agents.duplicate('linear:triager');
    expect(duplicated.id).toBe('triager');
    const copy = await readFile(join(owner, 'triager.md'), 'utf8');
    const listing = agents.list().find((entry) => entry.id === 'triager');
    expect(listing).toMatchObject({ state: 'ready', name: 'Triager' });
    expect(listing?.plugin).toBeUndefined();
    expect(copy).toContain('linear:create-issue');
    expect(copy).not.toContain('@');

    await agents.duplicate('linear:pinned');
    const pinned = await readFile(join(owner, 'pinned.md'), 'utf8');
    expect(pinned).toContain('linear:create-issue');
    expect(pinned).not.toContain('@');
    expect(agents.list().find((entry) => entry.id === 'pinned')?.state).toBe('ready');

    // The copy is the owner's now: a second duplicate finds it.
    expect(
      await agents.duplicate('linear:triager').then(
        () => 'duplicated',
        (caught: unknown) => (caught as AgentFileError).code,
      ),
    ).toBe('agent-file-exists');
  });
});

describe('layered sources', () => {
  it('refuses a write of a plugin identifier without reaching any source', async () => {
    const owner = await temporaryDirectory();
    const plugin = await temporaryDirectory();
    const source = layeredWorkflowSource([
      workflowFileDirectory(owner, { watch: false }),
      workflowFileDirectory(plugin, { plugin: 'linear', watch: false }),
    ]);

    const error = await source
      .write('linear:sync', new TextEncoder().encode('{}'), { expectedHash: null })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(SourceReadOnlyError);
    expect(error).toMatchObject({ id: 'linear:sync', plugin: 'linear' });
  });

  it('refuses two layers of one plugin', () => {
    expect(() =>
      layeredAgentSource([
        agentFileDirectory(tmpdir(), { plugin: 'linear', watch: false }),
        agentFileDirectory(tmpdir(), { plugin: 'linear', watch: false }),
      ]),
    ).toThrow('Two layers belong to the plugin "linear".');
  });
});
