/**
 * The agent editor's client against a real host: the Bureau handler the host mounts, a real agent
 * directory, and the model catalog a configured provider installs. This is what keeps the editor's
 * schemas and fault sorting honest, because the component tests stand a stub in for the Bureau and
 * a stub can only be as faithful as what it was copied from.
 *
 * It also holds the host's `/host/paths` route and the editor's two copies of the Bureau's
 * identifier rules.
 */
import { AGENT_FILE_STEM_PATTERN as BUREAU_IDENTIFIER_PATTERN } from '@lostgradient/bureau';
import { createAgent as createCodeAgent, createScriptedGenerate } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_IDENTIFIER_MAX_LENGTH,
  AGENT_IDENTIFIER_PATTERN,
  agentFaultOf,
  createAgent,
  deleteAgent,
  getAgentCatalog,
  getAgentDefinition,
  listAgentDefinitions,
  listAgentRevisions,
  updateAgent,
  type AgentDefinitionInput,
} from '../lib/agent-definitions.ts';
import type { Fetcher } from '../lib/bureau-client.ts';
import { urlOf } from '../lib/bureau-stub.test-support.ts';
import { getHostPaths } from '../lib/host-paths.ts';
import { enableDemoPlugin } from './demo-plugin.test-support.ts';
import { fakeProvider, writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host, type HostOptions } from './host.ts';
import { runTask } from './run-task.test-support.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function startConfigured(
  options: Pick<HostOptions, 'extraAgents'> = {},
): Promise<{ host: Host; home: string; fetcher: Fetcher }> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-editor-'));
  directories.push(home);
  await writeProviderHome(home);
  await enableDemoPlugin(home);
  const { resolver } = fakeProvider('A reply.');
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    resolveProviderGenerate: resolver,
    ...options,
  });
  hosts.push(host);
  // The client sends relative URLs, as a page does; a test resolves them against the host.
  const fetcher: Fetcher = (input, init) => fetch(new URL(urlOf(input), host.url), init);
  return { host, home, fetcher };
}

/** A scripted generate for a code agent the test defines itself. */
const scripted = createScriptedGenerate([
  { kind: 'respond', response: { content: 'Scripted.', toolCalls: [] } },
]);

const skillDescriptors = [
  { id: 'cite', name: 'Cite', description: 'Cites the sources', tags: ['research'] },
];

const definition: AgentDefinitionInput = {
  name: 'Researcher',
  description: 'Finds and cites sources',
  model: 'anthropic/sonnet',
  tools: ['demo:lookup-order'],
  skillDescriptors,
  instructions: 'You are a careful researcher.',
};

/** What a call answered with, whether a result or the fault it threw. */
async function faultOf(call: Promise<unknown>) {
  return agentFaultOf(
    await call.then(
      () => undefined,
      (error: unknown) => error,
    ),
  );
}

describe('the identifier rules the editor repeats', () => {
  test('are the Bureau’s pattern and cap', async () => {
    expect(AGENT_IDENTIFIER_PATTERN.source).toBe(BUREAU_IDENTIFIER_PATTERN.source);
    expect(AGENT_IDENTIFIER_PATTERN.flags).toBe(BUREAU_IDENTIFIER_PATTERN.flags);
    // The cap is the Bureau's too: it refuses a 65-character identifier and accepts 64.
    const { fetcher } = await startConfigured();
    expect(AGENT_IDENTIFIER_MAX_LENGTH).toBe(64);
    const longest = 'a'.repeat(AGENT_IDENTIFIER_MAX_LENGTH);
    const accepted = await createAgent(longest, definition, { fetch: fetcher });
    expect(accepted.id).toBe(longest);
    const tooLong = await faultOf(createAgent(`${longest}a`, definition, { fetch: fetcher }));
    expect(tooLong.kind).toBe('rejected');
  });
});

describe('the host’s /host/paths', () => {
  test('names the directory the Bureau reads agent files from', async () => {
    const { home, fetcher } = await startConfigured();
    const paths = await getHostPaths({ fetch: fetcher });
    expect(paths.agentDirectory).toBe(join(home, 'agents'));
  });

  test('names the directory the Bureau reads workflow files from', async () => {
    const { home, fetcher } = await startConfigured();
    const paths = await getHostPaths({ fetch: fetcher });
    expect(paths.workflowDirectory).toBe(join(home, 'workflows'));
  });

  test('names the configuration file, and the file that holds each provider’s API key', async () => {
    const { home, fetcher } = await startConfigured();
    const paths = await getHostPaths({ fetch: fetcher });
    expect(paths.configurationFile).toBe(join(home, 'configuration.json'));
    expect(paths.providers).toEqual([
      { name: 'anthropic', secretFile: join(home, 'secrets', 'anthropic-api-key') },
      { name: 'openai', secretFile: join(home, 'secrets', 'openai-api-key') },
      { name: 'gemini', secretFile: join(home, 'secrets', 'gemini-api-key') },
    ]);
  });
});

describe('the operations, against the real Bureau', () => {
  test('lists the models and tools the deployment offers, and nothing the catalog lacks', async () => {
    const { host, fetcher } = await startConfigured();
    const catalog = await getAgentCatalog({ fetch: fetcher });
    expect(catalog.models.map((row) => `${row.provider}/${row.model}`)).toEqual([
      'anthropic/claude-sonnet-5',
    ]);
    expect(catalog.models[0]?.aliases.map((entry) => entry.alias)).toContain('sonnet');
    // The tools are the Bureau's own tool catalog, which holds the host's tool and the workflow tools.
    const offered = host.bureau.agents.tools().map((tool) => tool.name);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(offered);
    expect(offered).toContain('demo:lookup-order');
    // Every tool states its input schema, Bureau's settings and workflow tools included, and who
    // provides it. The demo `tool-runner` agent's toolbox names `lookup-order`, so it uses it.
    for (const tool of catalog.tools) {
      expect(tool.inputSchema).not.toBeNull();
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
    const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('demo:lookup-order')).toMatchObject({
      tier: 'read-only',
      defaultApproval: 'allow',
      // The demo plugin contributes it (COR-1892).
      source: 'plugin',
      plugin: 'demo',
      // The `tool-runner` agent's own toolbox holds its own `lookup-order`, not the catalog's.
      users: [],
    });
    expect(byName.get('bureau:workflows-create')).toMatchObject({ source: 'bureau' });
    expect(byName.get('settings-update')).toMatchObject({ source: 'bureau' });
  });

  test('creates, reads, updates, opts into and out of A2A, and deletes an agent file', async () => {
    const { home, fetcher } = await startConfigured();
    const created = await createAgent('researcher', definition, { fetch: fetcher });
    expect(created.id).toBe('researcher');
    const file = join(home, 'agents', 'researcher.md');
    expect(await readFile(file, 'utf8')).toContain('You are a careful researcher.');

    const read = await getAgentDefinition('researcher', { fetch: fetcher });
    expect(read.source).toBe('file');
    expect(read.state).toBe('ready');
    expect(read.hash).toBe(created.hash);
    expect(read.a2a).toBe(false);
    expect(read.definition?.model).toBe('anthropic/sonnet');
    expect(read.definition?.skillDescriptors).toEqual(skillDescriptors);

    const updated = await updateAgent(
      'researcher',
      created.hash,
      { ...definition, instructions: 'Changed.' },
      { fetch: fetcher },
    );
    expect(updated.hash).not.toBe(created.hash);
    // The update kept the skill descriptors and left the A2A opt-in as the file had it.
    const afterUpdate = await getAgentDefinition('researcher', { fetch: fetcher });
    expect(afterUpdate.definition?.skillDescriptors).toEqual(skillDescriptors);
    expect(afterUpdate.definition?.instructions).toBe('Changed.');
    expect(afterUpdate.a2a).toBe(false);

    const optedIn = await updateAgent(
      'researcher',
      updated.hash,
      { ...definition, instructions: 'Changed.', a2a: true },
      { fetch: fetcher },
    );
    const afterOptIn = await getAgentDefinition('researcher', { fetch: fetcher });
    expect(afterOptIn.a2a).toBe(true);
    // A save that leaves the opt-in out keeps it.
    const kept = await updateAgent(
      'researcher',
      optedIn.hash,
      { ...definition, instructions: 'Changed again.' },
      { fetch: fetcher },
    );
    const afterKept = await getAgentDefinition('researcher', { fetch: fetcher });
    expect(afterKept.a2a).toBe(true);
    const optedOut = await updateAgent(
      'researcher',
      kept.hash,
      { ...definition, instructions: 'Changed again.', a2a: false },
      { fetch: fetcher },
    );
    const afterOptOut = await getAgentDefinition('researcher', { fetch: fetcher });
    expect(afterOptOut.a2a).toBe(false);

    await deleteAgent('researcher', optedOut.hash, { fetch: fetcher });
    expect(await Bun.file(file).exists()).toBe(false);
    expect(await faultOf(getAgentDefinition('researcher', { fetch: fetcher }))).toEqual({
      kind: 'not-found',
    });
  });

  test('answers a taken identifier by its reason, for a file and for a code-defined agent', async () => {
    const { fetcher } = await startConfigured({
      extraAgents: {
        agents: { scripted: createCodeAgent({ name: 'scripted', generate: scripted }) },
      },
    });
    await createAgent('researcher', definition, { fetch: fetcher });
    expect(await faultOf(createAgent('researcher', definition, { fetch: fetcher }))).toEqual({
      kind: 'identifier-taken',
      reason: 'agent-file-exists',
    });
    expect(await faultOf(createAgent('scripted', definition, { fetch: fetcher }))).toEqual({
      kind: 'identifier-taken',
      reason: 'shadows-code-agent',
    });
  });

  test('refuses a write whose file changed on disk, as stale with the hash that is there now, and overwrites nothing', async () => {
    const { home, fetcher } = await startConfigured();
    const created = await createAgent('researcher', definition, { fetch: fetcher });
    const file = join(home, 'agents', 'researcher.md');
    const original = await readFile(file, 'utf8');
    const edited = original.replace('careful', 'hand-edited');
    await writeFile(file, edited);

    const current = await getAgentDefinition('researcher', { fetch: fetcher });
    for (const write of [
      () => updateAgent('researcher', created.hash, definition, { fetch: fetcher }),
      () => deleteAgent('researcher', created.hash, { fetch: fetcher }),
    ]) {
      const fault = await faultOf(write());
      expect(fault).toEqual({ kind: 'stale', currentHash: current.hash });
    }
    expect(await readFile(file, 'utf8')).toBe(edited);
  });

  test('answers a write to a file deleted on disk as not found', async () => {
    const { home, fetcher } = await startConfigured();
    const created = await createAgent('researcher', definition, { fetch: fetcher });
    await rm(join(home, 'agents', 'researcher.md'));
    expect(
      await faultOf(updateAgent('researcher', created.hash, definition, { fetch: fetcher })),
    ).toEqual({ kind: 'not-found' });
  });

  test('refuses a definition that would not load, and writes nothing', async () => {
    const { home, fetcher } = await startConfigured();
    const fault = await faultOf(
      createAgent('researcher', { ...definition, model: 'openai/gpt-4.1' }, { fetch: fetcher }),
    );
    expect(fault.kind).toBe('rejected');
    expect(await Bun.file(join(home, 'agents', 'researcher.md')).exists()).toBe(false);
    const unknownTool = await faultOf(
      createAgent('researcher', { ...definition, tools: ['nope'] }, { fetch: fetcher }),
    );
    expect(unknownTool.kind).toBe('rejected');
  });

  test('shows a code-defined agent as code with no hash, and a file it cannot use as invalid with its problem and hash', async () => {
    const { host, home, fetcher } = await startConfigured();
    const code = await getAgentDefinition('demo:assistant', { fetch: fetcher });
    expect(code).toMatchObject({ source: 'code', hash: null, definition: null });
    expect(code.codeDefinition).toMatchObject({
      name: 'assistant',
      instructions: null,
      tools: [],
      skills: [],
    });
    const runner = await getAgentDefinition('demo:tool-runner', { fetch: fetcher });
    expect(runner.codeDefinition).toMatchObject({ tools: ['lookup-order', 'issue-refund'] });

    await writeFile(join(home, 'agents', 'broken.md'), '---\nmodel: openai/gpt-4.1\n---\nHi\n');
    await host.bureau.agents.refresh();
    const broken = await getAgentDefinition('broken', { fetch: fetcher });
    expect(broken.state).toBe('invalid');
    expect(broken.problem?.code).toBe('unknown-model');
    // An invalid file that parses still carries its definition, and a hash a delete can name.
    expect(typeof broken.hash).toBe('string');
    // The list that holds invalid files says so, and `bureau.agents.list` leaves them out.
    const listings = await listAgentDefinitions({ fetch: fetcher });
    expect(listings.find((listing) => listing.id === 'broken')).toMatchObject({
      state: 'invalid',
      problem: { code: 'unknown-model' },
    });
    await deleteAgent('broken', broken.hash ?? '', { fetch: fetcher });
    expect(await Bun.file(join(home, 'agents', 'broken.md')).exists()).toBe(false);
  });

  test('lists no revision for an agent that has not run, and fails for an agent that does not exist', async () => {
    const { fetcher } = await startConfigured();
    await createAgent('researcher', definition, { fetch: fetcher });
    expect(await listAgentRevisions('researcher', { fetch: fetcher })).toEqual([]);
    expect(await faultOf(listAgentRevisions('nobody', { fetch: fetcher }))).toEqual({
      kind: 'not-found',
    });
  });

  test('lists the version that has run, with its hash and last-run time', async () => {
    const { host, fetcher } = await startConfigured();
    const created = await createAgent('researcher', definition, { fetch: fetcher });
    const result = await runTask(host.bureau, 'researcher', 'Hello');
    expect(result.content).toBe('A reply.');
    const revisions = await listAgentRevisions('researcher', { fetch: fetcher });
    expect(revisions.map((revision) => revision.hash)).toEqual([created.hash]);
    expect(Number.isNaN(Date.parse(revisions[0]?.lastRunAt ?? ''))).toBe(false);
  });
});
