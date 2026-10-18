/**
 * COR-1524 — what a resumed run of a file agent builds from: its snapshot, with the model and tools
 * resolved against the catalogs as they are now, and a typed failure, never the current file, when
 * the snapshot is gone or can no longer be rebuilt.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentSnapshotError, type AgentFileDefinition } from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import { createFileAgentRuntime } from './agent-file-runtime';
import {
  AGENT_RUN_REFERENCE_KEY_PREFIX,
  AGENT_SNAPSHOT_KEY_PREFIX,
  createAgentSnapshotStore,
} from './agent-snapshot-store';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

async function start() {
  const fixture = await createAgentFileFixture({ watch: false });
  fixtures.push(fixture);
  const snapshots = createAgentSnapshotStore({ nowISO: () => '2026-10-18T00:00:00.000Z' });
  const runtime = createFileAgentRuntime({
    files: fixture.catalog,
    snapshots,
    diagnose: (message, cause) => {
      throw new Error(`${message} ${String(cause)}`);
    },
  });
  return { fixture, snapshots, runtime };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

const DEFINITION: AgentFileDefinition = {
  name: 'Helper',
  description: null,
  model: KNOWN_MODEL,
  tools: ['lookup-order'],
  skills: [],
  published: false,
  instructions: 'Recorded instructions.\n',
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject.');
}

describe('agentForRecordedRun', () => {
  it('rebuilds the agent from the snapshot, not from the file', async () => {
    const { fixture, runtime } = await start();
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL }, 'Current file.\n'));
    await fixture.catalog.refresh();
    await runtime.snapshots.recordRun(
      { id: 'helper', hash: 'aa', definition: DEFINITION },
      'run-1',
    );

    const { agent, binding } = await runtime.agentForRecordedRun('helper', 'aa');
    expect(binding).toEqual({ id: 'helper', hash: 'aa', definition: DEFINITION });
    expect(readFileAgentBinding(agent)?.definition.instructions).toBe('Recorded instructions.\n');
    expect(agent).not.toBe(fixture.catalog.find('helper'));
  });

  it('rebuilds a snapshot whose file is gone, and whose name a code agent has since taken', async () => {
    const { runtime } = await start();
    await runtime.snapshots.recordRun({ id: 'alpha', hash: 'aa', definition: DEFINITION }, 'run-1');
    const { binding } = await runtime.agentForRecordedRun('alpha', 'aa');
    expect(binding.id).toBe('alpha');
  });

  it('fails with snapshot-missing when the snapshot is not stored', async () => {
    const { runtime } = await start();
    const error = await rejection(runtime.agentForRecordedRun('helper', 'ff'));
    expect(error).toBeInstanceOf(AgentSnapshotError);
    expect(error).toMatchObject({ code: 'snapshot-missing', agentId: 'helper', hash: 'ff' });
  });

  it('fails with snapshot-unresolvable when its tool or model is no longer available', async () => {
    const { runtime } = await start();
    await runtime.snapshots.recordRun(
      { id: 'tools', hash: 'aa', definition: { ...DEFINITION, tools: ['refund-order'] } },
      'run-1',
    );
    await runtime.snapshots.recordRun(
      { id: 'model', hash: 'bb', definition: { ...DEFINITION, model: 'anthropic/none' } },
      'run-2',
    );
    for (const [id, hash] of [
      ['tools', 'aa'],
      ['model', 'bb'],
    ] as const) {
      const error = await rejection(runtime.agentForRecordedRun(id, hash));
      expect(error, id).toBeInstanceOf(AgentSnapshotError);
      expect(error, id).toMatchObject({ code: 'snapshot-unresolvable' });
    }
  });
});

describe('a code agent', () => {
  it('has no binding, so recording its run does nothing', async () => {
    const { runtime, snapshots } = await start();
    expect(await runtime.recordRunStart({}, 'run-1')).toBeUndefined();
    expect(await snapshots.revisions('alpha')).toEqual([]);
  });
});

describe('the persisted keys', () => {
  it('are versioned and disjoint from every other prefix the Bureau stores under', () => {
    const OTHER_PREFIXES = [
      CATALOG_RUN_RECOVERY_KEY_PREFIX,
      'bureau-child:',
      'bureau-delegation:',
      'bureau-goal:',
      'bureau-steering-run:',
      'command-ledger:v1',
      'agent-session:',
      'agent-session-v2:body:',
      'agent-session-outbox:',
      'asset:v1:',
      'audit:v1:',
      'audit-dedupe:v1:',
      'audit-retention:v1:',
      'audit-sequence:v1:',
      'durable-run:',
      'goal:',
      'outbox-dedupe:',
      'schedule:',
      'session:',
      'session-deletion-owner:v1:',
      'session-input-identity:v1',
      'session-input-open:v2:',
      'steering-key:v1',
      'steering-log:v1',
      'webhook-delivery:v1:',
    ];
    const ours = [AGENT_SNAPSHOT_KEY_PREFIX, AGENT_RUN_REFERENCE_KEY_PREFIX];
    expect(AGENT_SNAPSHOT_KEY_PREFIX.startsWith(AGENT_RUN_REFERENCE_KEY_PREFIX)).toBe(false);
    expect(AGENT_RUN_REFERENCE_KEY_PREFIX.startsWith(AGENT_SNAPSHOT_KEY_PREFIX)).toBe(false);
    for (const prefix of ours) {
      expect(prefix).toMatch(/:v1:$/);
      for (const other of OTHER_PREFIXES) {
        expect(prefix.startsWith(other), `${prefix} starts with ${other}`).toBe(false);
        expect(other.startsWith(prefix), `${other} starts with ${prefix}`).toBe(false);
      }
    }
  });
});
