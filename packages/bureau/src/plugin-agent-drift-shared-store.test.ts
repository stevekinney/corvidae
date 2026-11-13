/**
 * COR-2230 — Bureaus that share one store do not see the overrides one of them saved until they
 * read the store. The pin a run recorded is compared with the overrides in force, so a Bureau
 * that never reloaded must read the store before it compares: otherwise it refuses a run it
 * reclaims for drift though the stored overrides never changed after the run started.
 *
 * Bureau A and Bureau B share one SQLite file under the default `workflow-lease` ownership. B is
 * built before the overrides are saved through A, so what B loaded at construction is the empty
 * set. A starts a run, which pins the saved overrides, and stops renewing its claim; B's engine
 * reclaims the lapsed run and recovers it.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { AgentOverrides } from './agent-override-store';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import {
  createTestDatabase,
  createUnsetTestDatabase,
  type TestDatabase,
} from './testing/goal-fixtures.test-support';

const bureaus: Bureau<AgentDefinitions>[] = [];
let database: TestDatabase = createUnsetTestDatabase();

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.shutdown();
  await database.remove();
});

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** Short lease timings, so a run its owner stopped renewing is reclaimed within a second or two. */
const leaseOptions = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 200,
  workflowClaimRenewIntervalMs: 50,
} as const;

/** A Bureau over its own handle on the shared file, whose built-in agent `scribe` answers `generate`. */
async function bureauOver(
  generate: GenerateFunction,
  options: { readonly maintenance?: 'manual' } = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      scribe: createAgent({
        name: 'scribe',
        instructions: 'Base.',
        generate,
        toolbox: createToolbox([next]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.open(),
    durable: true,
    durableOwnership: leaseOptions,
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    onDiagnostic: () => undefined,
  });
  bureaus.push(bureau);
  return bureau;
}

async function save(bureau: Bureau<AgentDefinitions>, overrides: AgentOverrides): Promise<void> {
  const state = await bureau.agents.overrides.get('scribe');
  if (state === undefined) throw new Error('Expected "scribe" to take overrides.');
  await bureau.agents.overrides.save('scribe', overrides, { expectedHash: state.hash });
}

describe('a run reclaimed on a store shared by Bureaus, one of which never reloaded the overrides', () => {
  /**
   * The Bureau built first loaded the empty overrides and nothing makes it read them again; the one
   * built second saves them. The starter never renews its claim (manual maintenance) and never
   * finishes its run, so the other Bureau's engine reclaims it.
   */
  it.each([
    [
      'the Bureau that never reloaded reclaims the run the saving Bureau started',
      'reclaimer-stale',
    ],
    ['the saving Bureau reclaims the run the Bureau that never reloaded started', 'starter-stale'],
  ] as const)('%s, and resumes under the saved overrides', async (_label, stale) => {
    database = createTestDatabase(`shared-store-${stale}`);
    const seen: string[] = [];
    const resumed: GenerateFunction = async ({ step, conversation }) => {
      const system = conversation.getFirstSystemMessage()?.content;
      seen.push(typeof system === 'string' ? system : '');
      return { content: `resumed at step ${step}`, toolCalls: [] };
    };
    const reached = { step1: false };
    const dying: GenerateFunction = async ({ step }) => {
      if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
      reached.step1 = true;
      return new Promise<never>(() => {});
    };
    const startsLapsing = () => bureauOver(dying, { maintenance: 'manual' });
    let reclaiming: Bureau<AgentDefinitions>;
    let starting: Bureau<AgentDefinitions>;
    if (stale === 'reclaimer-stale') {
      reclaiming = await bureauOver(resumed);
      starting = await startsLapsing();
      await save(starting, { instructions: 'Saved through A.' });
    } else {
      starting = await startsLapsing();
      reclaiming = await bureauOver(resumed);
      await save(reclaiming, { instructions: 'Saved through A.' });
    }
    const run = await starting.tasks.start('scribe', 'Recover me');
    await waitUntil(() => reached.step1, { message: 'the run reached step 1' });

    await waitUntil(
      async () => {
        const session = await reclaiming.contexts.get(run.contextId);
        const status = session?.metadata['lastRunStatus'];
        return status === 'completed' || status === 'error';
      },
      { message: 'the reclaiming Bureau settled the run' },
    );

    const session = await reclaiming.contexts.get(run.contextId);
    expect(session?.metadata['lastError']).toBeUndefined();
    expect(session?.metadata['lastRunStatus']).toBe('completed');
    // The agent it resumed under is the one the saved overrides describe.
    expect(seen).not.toEqual([]);
    expect(seen.at(-1)).toBe('Saved through A.');
  });
});
