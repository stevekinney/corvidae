/**
 * COR-1524 — a pending approval restored after a restart is restored on the definition its own run
 * started with. A session keeps one latest hash in its metadata, but its runs may be of different
 * agents (each run's request context names its agent), so the hash a restore reads is the run's.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentSession,
  createModelCatalog,
  createSessionStore,
  stopWhen,
} from '@lostgradient/operative';
import { resolveStorage, textValueStore } from '@lostgradient/weft';
import { createConversationHistory } from 'conversationalist';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import { createAgentSnapshotStore } from './agent-snapshot-store';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import type { Bureau } from './types';

const directories: string[] = [];
const bureaus: Bureau[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('a pending approval restored after a restart', () => {
  it('is restored on its own run’s snapshot, not on the one the session’s latest run recorded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-restored-approvals-'));
    directories.push(directory);
    for (const name of ['alpha-file', 'bravo-file']) {
      await writeFile(
        join(directory, `${name}.md`),
        agentFileText({ model: KNOWN_MODEL }, 'Now.\n'),
      );
    }
    const storage = await resolveStorage({ type: 'memory' });
    const kv = textValueStore(storage);
    const snapshots = createAgentSnapshotStore({
      store: kv,
      nowISO: () => '2026-10-18T00:00:00.000Z',
    });
    const definition = (instructions: string) => ({
      name: 'Agent',
      description: null,
      model: KNOWN_MODEL,
      tools: [],
      skills: [],
      published: false,
      instructions,
    });
    const olderRunId = 'run-older-approval';
    const newestRunId = 'run-newest-approval';
    await snapshots.recordRun(
      { id: 'alpha-file', hash: 'hash-of-alpha', definition: definition('Alpha then.\n') },
      olderRunId,
    );
    await snapshots.recordRun(
      { id: 'bravo-file', hash: 'hash-of-bravo', definition: definition('Bravo then.\n') },
      newestRunId,
    );
    const approval = {
      toolName: 'charge-card',
      arguments: { cents: 250 },
      approvalToken: 'persisted-approval-token',
      action: { message: 'Approve charge' },
    };
    const authority = (agentId: string, principalId: string) => ({
      agentId,
      principalId,
      tenantId: 'bureau',
      ownerId: 'file-agents',
      capabilities: ['tools:execute'],
      authorizationRevision: 'bureau:1',
    });
    await createSessionStore(kv).save(
      createAgentSession({
        id: 'session-reused',
        agentName: 'alpha-file',
        conversationHistory: createConversationHistory({ id: 'session-reused' }),
        metadata: {
          lastRunId: newestRunId,
          lastRunStatus: 'completed',
          // The session's metadata names the latest run's definition only.
          lastAgentDefinitionHash: 'hash-of-bravo',
          lastRequestAuthorities: {
            [olderRunId]: authority('alpha-file', 'principal-older'),
            [newestRunId]: authority('bravo-file', 'principal-newest'),
          },
          pendingApprovalOverrides: {
            [`approval:${olderRunId}:older-call`]: { ...approval, callId: 'older-call' },
            [`approval:${newestRunId}:newest-call`]: { ...approval, callId: 'newest-call' },
          },
        },
      }),
    );

    const bureau = await createBureau({
      agents: {},
      agentDirectory: directory,
      resolveAgentGenerate: () => async () => ({ content: 'ok', toolCalls: [] }),
      stopWhen: stopWhen.noToolCalls(),
      storage,
      durableExecution: true,
    });
    bureaus.push(bureau);

    expect(createModelCatalog().descriptors.length).toBeGreaterThan(0);
    expect(
      Object.fromEntries(
        bureau.listPendingReviews().map((review) => [review.runId, review.agentName]),
      ),
    ).toEqual({ [olderRunId]: 'alpha-file', [newestRunId]: 'bravo-file' });
  });
});
