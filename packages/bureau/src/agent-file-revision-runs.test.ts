/**
 * COR-1584 — a run keeps the revision it started with. A run records the revision in the two
 * places it records its definition (the recovery record's `definitionRevision` and the session's
 * `lastAgentRevision`), and a run resumed after a restart is rebuilt from its snapshot with the
 * revision it recorded, not the revision the file has reached since.
 */
import { join } from 'node:path';

import { createAgent, readGenerationProfile } from '@lostgradient/operative';
import * as operative from '@lostgradient/operative';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { decode, resolveStorage, type Storage } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import { waitForCondition, waitForTaskState } from './test';
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

/** The recovery record of a run, read from the durable storage the Bureau was given. */
async function recoveryRecordOf(storage: Storage, runId: string) {
  const bytes = await storage.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`);
  return bytes === null
    ? undefined
    : (decode(bytes) as { definitionRevision: number; agentDefinitionHash?: string });
}

/** The `definitionRevision` the run's recovery record holds. */
async function recordedRevisionOf(storage: Storage, runId: string) {
  const record = await recoveryRecordOf(storage, runId);
  return record?.definitionRevision;
}

/** A durable Bureau over storage the test owns, so the records can be read back. */
async function openDurable(
  storage: Storage,
  options: Parameters<typeof startFileBureau>[0] = {},
): Promise<FileBureauHarness> {
  return open({
    ...options,
    overrides: { storage, durable: true, ...options.overrides },
  });
}

describe('a run of a file agent', () => {
  it('records the revision it started with in its recovery record', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const harness = await openDurable(storage);
    await edit(harness, 'One.\n');
    await edit(harness, 'Two.\n');
    const { bureau } = harness;

    const run = await bureau.tasks.start('researcher', 'hello');
    await run.result();
    await edit(harness, 'Three.\n');
    const later = await bureau.tasks.start('researcher', 'hello again');
    await later.result();

    expect(await recordedRevisionOf(storage, run.id)).toBe(2);
    expect(await recordedRevisionOf(storage, later.id)).toBe(3);
  });

  it('records the revision it started with on its session', async () => {
    const harness = await open();
    await edit(harness, 'One.\n');
    await edit(harness, 'Two.\n');
    const { bureau } = harness;

    const created = await bureau.tasks.start('researcher', 'hello');
    await waitForTaskState(bureau, created.id);

    const session = await bureau.contexts.get(created.contextId);
    expect(session?.metadata['lastAgentRevision']).toBe(2);
  });
});

describe('a run of a code-defined agent', () => {
  it('records the revision the agent was created with, and the catalog lists it', async () => {
    const storage = await resolveStorage({ type: 'memory' });
    const harness = await openDurable(storage, {
      agents: {
        alpha: createAgent({
          name: 'alpha',
          revision: 4,
          generate: async () => ({ content: 'alpha', toolCalls: [] }),
        }),
      },
    });
    const { bureau } = harness;

    const run = await bureau.tasks.start('alpha', 'hello');
    await run.result();

    expect(revisionOf(bureau, 'alpha')).toBe(4);
    expect(readGenerationProfile(bureau.agents.get('alpha')).revision).toBe(4);
    expect(await recordedRevisionOf(storage, run.id)).toBe(4);
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
      durableOwnership: { ownership: 'none' as const },
      maintenance: 'manual' as const,
    };

    const firstStorage = await resolveStorage({ type: 'sqlite', path: storagePath });
    const first = await openDurable(firstStorage, {
      directory: agents,
      scripts: { 'claude-opus-5-5': () => hold },
      overrides,
    });
    await edit(first, 'Version one.\n');
    await edit(first, 'Version two.\n');
    const run = await first.bureau.tasks.start('researcher', 'long question');
    await waitForCondition(
      async () => (await recoveryRecordOf(firstStorage, run.id)) !== undefined,
      'the run is recorded',
      ATTEMPTS,
    );
    expect(await recordedRevisionOf(firstStorage, run.id)).toBe(2);
    await edit(first, 'Version three.\n');
    expect(revisionOf(first.bureau, 'researcher')).toBe(3);

    const built = spyOn(operative, 'createAgent');
    const secondStorage = await resolveStorage({ type: 'sqlite', path: storagePath });
    const second = await openDurable(secondStorage, {
      directory: agents,
      scripts: { 'claude-opus-5-5': () => 'resumed' },
      overrides,
    });
    await second.bureau.waitForRecovery?.();

    const resumedAgents = built.mock.calls
      .map(
        ([agentOptions]) =>
          agentOptions as { name?: string; instructions?: string; revision?: number },
      )
      .filter((agentOptions) => agentOptions.name === 'researcher');
    const resumed = resumedAgents.filter((agentOptions) =>
      agentOptions.instructions?.includes('Version two.'),
    );
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.map((agentOptions) => agentOptions.revision)).toEqual(resumed.map(() => 2));
    expect(revisionOf(second.bureau, 'researcher')).toBe(3);
    expect(await recordedRevisionOf(secondStorage, run.id)).toBe(2);
    built.mockRestore();
  });
});
