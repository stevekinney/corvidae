/**
 * COR-1890 — Bureau's own tools reach agents as the built-in `bureau` plugin's contributions:
 * `bureau:discover-agents` and the five `bureau:workflows-*` tools. The plugin is required, holds the
 * name `bureau` before any other plugin, and the events its tools cause carry `source: 'bureau'`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { eventSourceOf } from '../event-source';
import { agentFileDirectory } from '../sources/agent-file-directory';
import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from '../testing/workflow-tools-bureau.test-support';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import { agentFileText, KNOWN_MODEL } from '../testing/agent-file-fixtures.test-support';
import { startFileBureau, type FileBureauHarness } from '../testing/agent-file-bureau.test-support';
import type { Bureau, BureauDiagnostic } from '../types';
import { BUREAU_PLUGIN_NAME, BUREAU_PLUGIN_VERSION } from './bureau-plugin';
import type { BureauPluginEntry } from './plugin-types';

const harnesses: WorkflowToolsHarness[] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function start(options?: Parameters<typeof startWorkflowToolsBureau>[0]) {
  const harness = await startWorkflowToolsBureau(options);
  harnesses.push(harness);
  return harness;
}

const TRIGGER = { kind: 'schedule', spec: '1h' };
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write the digest' } },
];

const WORKFLOW_TOOLS = [
  'workflows-create',
  'workflows-update',
  'workflows-pause',
  'workflows-resume',
  'workflows-list',
];

function twin(source: BureauPluginEntry['source'], location: string): BureauPluginEntry {
  return {
    descriptor: definePlugin({
      name: BUREAU_PLUGIN_NAME,
      version: '9.0.0',
      description: 'Claims the name Bureau holds.',
      setup: () => ({
        tools: [
          createTool({
            name: 'impostor',
            description: 'Not Bureau’s.',
            input: z.object({}),
            execute: async () => 'x',
          }),
        ],
      }),
    }),
    source,
    location,
  };
}

describe('the built-in bureau plugin', () => {
  it('is a required, running, built-in plugin whose contributions are the six tools, by versioned id', async () => {
    const harness = await start();
    const [listing] = await harness.bureau.plugins.list();

    expect(listing?.descriptor).toMatchObject({
      name: 'bureau',
      version: BUREAU_PLUGIN_VERSION,
      required: true,
    });
    expect(listing?.source).toBe('built-in');
    expect(listing?.status).toBe('running');
    expect(listing?.problems).toEqual([]);
    expect(listing?.contributions.map(({ kind, id }) => `${kind} ${id}`).toSorted()).toEqual(
      ['discover-agents', ...WORKFLOW_TOOLS]
        .map(
          (name) =>
            `tool bureau:${name}@${name === 'discover-agents' ? BUREAU_PLUGIN_VERSION : '1.0.0'}`,
        )
        .toSorted(),
    );
    expect(harness.bureau.plugins.registered()).toContain('bureau');
  });

  it('resolves bureau:discover-agents by id: the tool catalog lists it as Bureau’s, a file agent may use it, and a call finds the agents', async () => {
    const harness = await start({ agents: [] });
    await harness.putAgent('finder', ['bureau:discover-agents']);

    const described = harness.bureau.agents
      .tools()
      .find((tool) => tool.name === 'bureau:discover-agents');
    expect(described).toMatchObject({ source: 'bureau', users: ['finder'] });
    expect(harness.bureau.agents.list().find((file) => file.id === 'finder')?.state).toBe('ready');

    const { result, outcome } = await harness.callTool(
      'bureau__discover-agents',
      { text: 'anchor' },
      { agent: 'finder' },
    );
    expect(outcome).toBe('success');
    expect(JSON.parse(String(result)).map((match: { name: string }) => match.name)).toEqual([
      'anchor',
    ]);
  });

  it('lists the five workflow tools in the tool catalog as Bureau’s, under bureau:', async () => {
    const harness = await start();
    const names = harness.bureau.agents.tools().map((tool) => tool.name);
    for (const name of WORKFLOW_TOOLS) expect(names).toContain(`bureau:${name}`);
    expect(names).not.toContain('workflows-create');
    expect(
      harness.bureau.agents
        .tools()
        .filter((tool) => tool.name.startsWith('bureau:'))
        .every((tool) => tool.source === 'bureau'),
    ).toBe(true);
  });

  it('skips a folder plugin named bureau with name-clash: first is the built-in, second is the folder', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      storage: new MemoryStorage(),
      plugins: [twin('folder', '/plugins/bureau')],
    });
    bureaus.push(bureau);
    await bureau.plugins.ready();

    const listings = await bureau.plugins.list();
    expect(
      listings.map(({ descriptor, source, status }) => [descriptor.name, source, status]),
    ).toEqual([
      ['bureau', 'built-in', 'running'],
      ['bureau', 'folder', 'skipped'],
    ]);
    const problem = listings[1]?.problems[0];
    expect(problem).toMatchObject({
      code: 'name-clash',
      name: 'bureau',
      first: { source: 'built-in' },
      second: { source: 'folder', location: '/plugins/bureau' },
    });
    // The impostor registered nothing; the built-in keeps its tools.
    expect(listings[1]?.contributions).toEqual([]);
    expect(listings[0]?.contributions.map(({ id }) => id)).not.toContain('bureau:impostor@9.0.0');
  });

  it('skips a package plugin named bureau the same way', async () => {
    const bureau = await createBureau<AgentDefinitions>({
      storage: new MemoryStorage(),
      plugins: [twin('package', '@example/bureau')],
    });
    bureaus.push(bureau);
    const [, second] = await bureau.plugins.list();
    expect(second?.status).toBe('skipped');
    expect(second?.problems[0]).toMatchObject({
      code: 'name-clash',
      first: { source: 'built-in' },
      second: { source: 'package' },
    });
  });

  it('refuses a host tool in the bureau namespace, in either spelling, and a host-supplied built-in entry', async () => {
    const tool = createTool({
      name: 'x',
      description: 'x',
      input: z.object({}),
      execute: async () => 'x',
    });
    for (const key of ['bureau:x', 'bureau__x']) {
      const error = await rejectionOf(
        createBureau<AgentDefinitions>({
          storage: new MemoryStorage(),
          agentSource: agentFileDirectory(tmpdir(), { tools: { [key]: tool } }),
          models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
        }),
      );
      expect(String(error), key).toContain('bureau');
    }
    const error = await rejectionOf(
      createBureau<AgentDefinitions>({
        storage: new MemoryStorage(),
        plugins: [twin('built-in', '@example/bureau')],
      }),
    );
    expect(String(error)).toContain('built-in');
  });
});

describe('the source of an event a bureau tool causes', () => {
  it('marks the definitions.changed of a workflow a bureau:workflows-create call writes, and not one written through bureau.workflows', async () => {
    const harness = await start();
    const events: Array<{ catalog: string; added: readonly string[]; source: string | undefined }> =
      [];
    harness.bureau.addEventListener('definitions.changed', (event) => {
      const changed = event as unknown as { catalog: string; added: readonly string[] };
      events.push({ catalog: changed.catalog, added: changed.added, source: eventSourceOf(event) });
    });

    const { outcome } = await harness.callTool('bureau__workflows-create', {
      name: 'Nightly',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(outcome).toBe('success');
    await harness.bureau.workflows!.create(
      'by-api',
      { trigger: TRIGGER, steps: STEPS },
      {
        actor: 'api-key:someone',
      },
    );

    expect(events.filter(({ catalog }) => catalog === 'workflows')).toEqual([
      { catalog: 'workflows', added: ['nightly'], source: 'bureau' },
      { catalog: 'workflows', added: ['by-api'], source: undefined },
    ]);
  });
});

describe('a record that names a tool by its bare name from before the plugin', () => {
  const roots: string[] = [];
  const fixtures: Array<{ dispose(): Promise<void> }> = [];
  const started: FileBureauHarness[] = [];

  afterEach(async () => {
    for (const harness of started.splice(0)) await harness.dispose();
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('is never restored: its agent file is invalid, so the run stays unavailable and no approval is listed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-bare-name-'));
    roots.push(directory);
    const database = createSqliteStorageFixture();
    fixtures.push(database);
    const bare = createTool({
      name: 'workflows-create',
      version: '1.0.0',
      description: 'A host tool that changes something.',
      input: z.object({}),
      metadata: { mutates: true },
      execute: async () => 'x',
    });
    const open = async (tools: Record<string, typeof bare>, diagnostics: BureauDiagnostic[]) => {
      let asked = false;
      const harness = await startFileBureau({
        directory,
        scripts: {
          [KNOWN_MODEL.split('/')[1] as string]: () => {
            if (asked) return 'Done.';
            asked = true;
            return { content: '', toolCalls: [{ name: 'workflows-create', arguments: {} }] };
          },
        },
        overrides: {
          agentApprovalSecret: 'bare-name-secret',
          agentSource: agentFileDirectory(directory, { tools }),
          storage: database.storage,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      });
      started.push(harness);
      return harness;
    };

    // Before: a host tool named `workflows-create` parks an approval pinned to `workflows-create@1.0.0`.
    const before = await open({ 'workflows-create': bare }, []);
    await before.put('old.md', agentFileText({ model: KNOWN_MODEL, tools: '[workflows-create]' }));
    await before.bureau.agents.refresh();
    const task = await before.bureau.tasks.start('old', 'Go.');
    await task.result();
    expect(before.bureau.reviews.list()).toHaveLength(1);
    await before.dispose();
    started.splice(started.indexOf(before), 1);

    // After: only the built-in plugin's `bureau:workflows-create` exists.
    const diagnostics: BureauDiagnostic[] = [];
    const after = await open({}, diagnostics);
    // The agent file names a tool nothing loads, so it is invalid, its run cannot be resolved, and
    // the approval is never restored: nothing runs the bare name's tool.
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.scope === 'recovery' &&
          diagnostic.message.includes('belongs to catalog agent "old"') &&
          diagnostic.message.includes('could not be resolved'),
      ),
    ).toBe(true);
    expect(after.bureau.reviews.list()).toEqual([]);
    expect(after.bureau.agents.list().find((file) => file.id === 'old')?.state).toBe('invalid');
  });
});
