/**
 * COR-1584 — a session run of a file agent that is resumed after a restart is rebuilt with the
 * revision it started at, on every path that resumes one:
 *
 * - a session run restored with its pending approval (`resolveRecoveredSessionAgent` in
 *   `create-bureau.ts`), where the run's own reference names the revision, because the session's
 *   metadata names only its latest run's;
 * - a session run the durable engine resumes (`resolveRecoveredSessionAgent` in
 *   `runtime-composition.ts`).
 *
 * The rebuilt agent is observed through the `createAgent` call that builds it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createAgentSession, createSessionStore } from '@lostgradient/operative';
import * as operative from '@lostgradient/operative';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { resolveStorage, textValueStore } from '@lostgradient/weft';
import { createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createAgentSnapshotStore } from './agent-snapshot-store';
import { createBureau } from './create-bureau';
import { waitForCondition } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';
import { agentFileDirectory } from './sources/agent-file-directory';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** What a `createAgent` call was given, for the agents a test built. */
interface Build {
  readonly instructions: string | undefined;
  readonly revision: number | undefined;
}

/** The revision each rebuilt agent was given, by the (trimmed) instructions it was built from. */
function buildsOf(built: { mock: { calls: unknown[][] } }, name: string): Build[] {
  return built.mock.calls
    .map(([options]) => options as { name?: string; instructions?: string; revision?: number })
    .filter((options) => options.name === name)
    .map((options) => ({
      instructions: options.instructions?.trim(),
      revision: options.revision,
    }));
}

function revisionBuiltFor(builds: readonly Build[], instructions: string): number[] {
  return (
    builds
      .filter((build) => build.instructions === instructions)
      // An agent built with no revision reports 1, as `createAgent` defaults it.
      .map((build) => build.revision ?? 1)
  );
}

describe('a pending approval restored after a restart', () => {
  const definition = (instructions: string) => ({
    name: 'Agent',
    description: null,
    model: KNOWN_MODEL,
    tools: [],
    skills: [],
    published: false,
    instructions,
  });
  const approval = {
    toolName: 'charge-card',
    arguments: { cents: 250 },
    approvalToken: 'persisted-approval-token',
    action: { message: 'Approve charge' },
  };
  const authority = (principalId: string) => ({
    agentId: 'alpha-file',
    principalId,
    tenantId: 'bureau',
    ownerId: 'file-agents',
    capabilities: ['tools:execute'],
    authorizationRevision: 'bureau:1',
  });

  /**
   * One session whose two runs are of the same agent at different revisions. The older run
   * (revision 2) is pending; the session's metadata names the newer run's revision (3) and hash.
   */
  async function restoreTwoRuns(options: { readonly referencesNameRevision: boolean }) {
    const directory = createTemporaryDirectory('bureau-revision-resume-approvals');
    cleanups.push(() => removeTemporaryPath(directory));
    await writeFile(
      join(directory, 'alpha-file.md'),
      agentFileText({ model: KNOWN_MODEL }, 'Now.\n'),
    );
    const storage = await resolveStorage({ type: 'memory' });
    const kv = textValueStore(storage);
    const snapshots = createAgentSnapshotStore({
      store: kv,
      nowISO: () => '2026-10-18T00:00:00.000Z',
    });
    const named = (revision: number) =>
      options.referencesNameRevision ? { definitionRevision: revision } : {};
    await snapshots.recordRun(
      { id: 'alpha-file', hash: 'hash-two', definition: definition('Older run.\n'), ...named(2) },
      'run-older',
    );
    await snapshots.recordRun(
      { id: 'alpha-file', hash: 'hash-three', definition: definition('Newer run.\n'), ...named(3) },
      'run-newer',
    );
    await createSessionStore(kv).save(
      createAgentSession({
        id: 'session-reused',
        agentName: 'alpha-file',
        conversationHistory: createConversationHistory({ id: 'session-reused' }),
        metadata: {
          lastRunId: 'run-newer',
          lastRunStatus: 'completed',
          lastAgentDefinitionHash: 'hash-three',
          lastAgentRevision: 3,
          lastRequestAuthorities: {
            'run-older': authority('principal-older'),
            'run-newer': authority('principal-newer'),
          },
          pendingApprovalOverrides: {
            'approval:run-older:older-call': { ...approval, callId: 'older-call' },
            'approval:run-newer:newer-call': { ...approval, callId: 'newer-call' },
          },
        },
      }),
    );
    const built = spyOn(operative, 'createAgent');
    cleanups.push(() => built.mockRestore());
    const bureau: Bureau = await createBureau<AgentDefinitions>({
      agents: {},
      agentSource: agentFileDirectory(directory),
      models: { generate: () => async () => ({ content: 'ok', toolCalls: [] }) },
      storage,
      durableExecution: true,
      onDiagnostic: () => undefined,
    });
    cleanups.push(() => bureau.dispose());
    expect(
      bureau
        .listPendingReviews()
        .map((review) => review.runId)
        .toSorted(),
    ).toEqual(['run-newer', 'run-older']);
    return buildsOf(built, 'alpha-file');
  }

  it('is rebuilt at the revision its own reference recorded, though the session names a later run’s', async () => {
    const builds = await restoreTwoRuns({ referencesNameRevision: true });

    expect(revisionBuiltFor(builds, 'Older run.')).toEqual([2]);
    expect(revisionBuiltFor(builds, 'Newer run.')).toEqual([3]);
  });

  it('is rebuilt at the session’s revision when its reference was written before references named one, if it is the session’s latest run', async () => {
    const builds = await restoreTwoRuns({ referencesNameRevision: false });

    expect(revisionBuiltFor(builds, 'Newer run.')).toEqual([3]);
    // Nothing recorded the older run's revision, and the session's metadata is the newer run's.
    expect(revisionBuiltFor(builds, 'Older run.')).toEqual([1]);
  });
});

describe('a session run the durable engine resumes after a restart', () => {
  const file = (instructions: string) => agentFileText({ model: KNOWN_MODEL }, instructions);
  async function open(
    options: NonNullable<Parameters<typeof startFileBureau>[0]>,
  ): Promise<FileBureauHarness> {
    const harness = await startFileBureau({
      ...options,
      overrides: { onDiagnostic: () => undefined, ...options.overrides },
    });
    cleanups.push(() => harness.dispose());
    return harness;
  }
  async function edit(harness: FileBureauHarness, instructions: string): Promise<void> {
    await harness.put('researcher.md', file(instructions));
    await harness.bureau.agents.refresh();
  }

  it('is rebuilt with the revision it started at, not the revision the file has reached since', async () => {
    const directory = createTemporaryDirectory('bureau-revision-resume-session');
    cleanups.push(() => removeTemporaryPath(directory));
    const agents = createTemporaryDirectory('bureau-revision-resume-agents');
    cleanups.push(() => removeTemporaryPath(agents));
    const storagePath = join(directory, 'bureau.sqlite');
    const hold = new Promise<never>(() => undefined);
    const overrides = {
      durableExecution: true,
      durableOwnership: { ownership: 'none' as const },
      durableBackgroundTasks: 'manual' as const,
      storage: { type: 'sqlite' as const, path: storagePath },
    };

    const first = await open({
      directory: agents,
      scripts: { 'claude-opus-5-5': () => hold },
      overrides,
    });
    await edit(first, 'Version one.\n');
    await edit(first, 'Version two.\n');
    const created = await first.bureau.createRun({
      message: 'long question',
      agentName: 'researcher',
    });
    await waitForCondition(
      async () => {
        const session = await first.bureau.getSession(created.sessionId);
        return session?.metadata['lastAgentRevision'] === 2 && first.observed.length > 0;
      },
      'the session run is recorded and calling the model',
      400,
    );
    await edit(first, 'Version three.\n');

    const built = spyOn(operative, 'createAgent');
    cleanups.push(() => built.mockRestore());
    const second = await open({
      directory: agents,
      scripts: { 'claude-opus-5-5': () => 'resumed' },
      overrides,
    });
    const report = await second.bureau.waitForRecovery?.();

    expect(report?.perRunFailures).toEqual([]);
    const resumed = revisionBuiltFor(buildsOf(built, 'researcher'), 'Version two.');
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed).toEqual(resumed.map(() => 2));
  });
});
