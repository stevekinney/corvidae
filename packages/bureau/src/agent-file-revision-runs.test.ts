/**
 * COR-1584 — a run keeps the revision it started with. A run records the revision in the two
 * places it records its definition (the recovery record's `definitionRevision` and the session's
 * `lastAgentRevision`), and a run resumed after a restart is rebuilt from its snapshot with the
 * revision it recorded, not the revision the file has reached since.
 */
import { join } from 'node:path';

import { createAgent, readGenerationProfile } from '@lostgradient/operative';
import * as operative from '@lostgradient/operative';
import { createTemporaryDirectory, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import { waitForCondition, waitForRunState } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const ATTEMPTS = 400;
const file = (instructions: string) => agentFileText({ model: KNOWN_MODEL }, instructions);

async function open(
  options: Parameters<typeof startFileBureau>[0] = {},
): Promise<FileBureauHarness> {
  const harness = await startFileBureau({
    ...options,
    overrides: { onDiagnostic: () => undefined, ...options.overrides },
  });
  cleanups.push(() => harness.dispose());
  return harness;
}

/** Writes `instructions` as the file and rescans, so the file is a new revision. */
async function edit(harness: FileBureauHarness, instructions: string): Promise<void> {
  await harness.put('researcher.md', file(instructions));
  await harness.bureau.agents.refresh();
}

function revisionOf(bureau: Bureau, id: string): number | undefined {
  return bureau.agents.list().find((listing) => listing.id === id)?.definitionRevision;
}

async function recoveryRecordOf(bureau: Bureau, runId: string) {
  const text = await bureau.kv?.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`);
  return text === null || text === undefined
    ? undefined
    : (JSON.parse(text) as { definitionRevision: number; agentDefinitionHash?: string });
}

describe('a run of a file agent', () => {
  it('records the revision it started with in its recovery record', async () => {
    const harness = await open();
    await edit(harness, 'One.\n');
    await edit(harness, 'Two.\n');
    const { bureau } = harness;

    const run = bureau.run('researcher', 'hello');
    await run.result();
    await edit(harness, 'Three.\n');
    const later = bureau.run('researcher', 'hello again');
    await later.result();

    expect((await recoveryRecordOf(bureau, run.id))?.definitionRevision).toBe(2);
    expect((await recoveryRecordOf(bureau, later.id))?.definitionRevision).toBe(3);
  });

  it('records the revision it started with on its session', async () => {
    const harness = await open();
    await edit(harness, 'One.\n');
    await edit(harness, 'Two.\n');
    const { bureau } = harness;

    const created = await bureau.createRun({ message: 'hello', agentName: 'researcher' });
    await waitForRunState(bureau, created.id);

    const session = await bureau.getSession(created.sessionId);
    expect(session?.metadata['lastAgentRevision']).toBe(2);
  });
});

describe('a run of a code-defined agent', () => {
  it('records the revision the agent was created with, and the catalog lists it', async () => {
    const harness = await open({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          revision: 4,
          generate: async () => ({ content: 'alpha', toolCalls: [] }),
        }),
      },
    });
    const { bureau } = harness;

    const run = bureau.run('alpha', 'hello');
    await run.result();

    expect(revisionOf(bureau, 'alpha')).toBe(4);
    expect(readGenerationProfile(bureau.agents.get('alpha')).revision).toBe(4);
    expect((await recoveryRecordOf(bureau, run.id))?.definitionRevision).toBe(4);
  });
});

describe('a run resumed after a restart', () => {
  it('is rebuilt with the revision it recorded, not the revision the file has reached since', async () => {
    const directory = createTemporaryDirectory('bureau-revision-restart');
    cleanups.push(() => removeTemporaryPath(directory));
    const agents = createTemporaryDirectory('bureau-revision-agents');
    cleanups.push(() => removeTemporaryPath(agents));
    const storagePath = join(directory, 'bureau.sqlite');
    const hold = new Promise<never>(() => undefined);
    const overrides = {
      storage: { type: 'sqlite' as const, path: storagePath },
      durableExecution: true as const,
      durableOwnership: { ownership: 'none' as const },
      durableBackgroundTasks: 'manual' as const,
    };

    const first = await open({
      directory: agents,
      scripts: { 'claude-opus-5-5': () => hold },
      overrides,
    });
    await edit(first, 'Version one.\n');
    await edit(first, 'Version two.\n');
    const run = first.bureau.run('researcher', 'long question');
    await waitForCondition(
      async () => (await recoveryRecordOf(first.bureau, run.id)) !== undefined,
      'the run is recorded',
      ATTEMPTS,
    );
    expect((await recoveryRecordOf(first.bureau, run.id))?.definitionRevision).toBe(2);
    await edit(first, 'Version three.\n');
    expect(revisionOf(first.bureau, 'researcher')).toBe(3);

    const built = spyOn(operative, 'createAgent');
    const second = await open({
      directory: agents,
      scripts: { 'claude-opus-5-5': () => 'resumed' },
      overrides,
    });
    await second.bureau.waitForRecovery?.();

    const resumedAgents = built.mock.calls
      .map(([agentOptions]) => agentOptions as { name?: string; instructions?: string; revision?: number })
      .filter((agentOptions) => agentOptions.name === 'researcher');
    const resumed = resumedAgents.filter((agentOptions) =>
      agentOptions.instructions?.includes('Version two.'),
    );
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.map((agentOptions) => agentOptions.revision)).toEqual(resumed.map(() => 2));
    expect(revisionOf(second.bureau, 'researcher')).toBe(3);
    expect((await recoveryRecordOf(second.bureau, run.id))?.definitionRevision).toBe(2);
    built.mockRestore();
  });
});
