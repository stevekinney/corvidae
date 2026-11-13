/**
 * COR-2230 — a durable run of a code agent pins the agent's plugin version (its own `version`, else
 * its plugin's) and the hash of its overrides, and a run recovered after either moved settles
 * failed with `definition-drifted`, naming both values, instead of resuming under a definition it
 * did not start with.
 *
 * Every row crashes a run mid-flight (a Bureau that is never disposed, as a dead process would be),
 * lets the agent move, then opens a second Bureau over the same SQLite file, which recovers it.
 * A built-in agent pins only its overrides; a record written before the pin recovers as it always
 * did. A claim by a second execution is tested at the dispatcher, in `bureau-catalog-dispatch.test.ts`.
 */
import {
  createAgent,
  createSessionStore,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { decode, encode } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { AgentOverrides } from './agent-override-store';
import type { Bureau } from './bureau-types/facade';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './catalog-run-recovery-record';
import { createBureau } from './create-bureau';
import {
  createTestDatabase,
  createUnsetTestDatabase,
  createCheckValidator,
  goalRequest,
  goalStatus,
  hangForever,
  pollUntil,
  type TestDatabase,
  workflowStatus,
} from './testing/goal-fixtures.test-support';
import { inspect } from './testing/goal-recovery-fixtures.test-support';
import { versionedPlugin } from './testing/versioned-plugin-agent.test-support';

const bureaus: Bureau<AgentDefinitions>[] = [];
const views: { dispose(): void }[] = [];
let database: TestDatabase = createUnsetTestDatabase();
let counter = 0;

afterEach(async () => {
  // The Bureau that took over disposes first: the one it took over from is still running.
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const view of views.splice(0)) view.dispose();
  await database.remove();
});

function freshDatabase(): TestDatabase {
  counter += 1;
  database = createTestDatabase(`plugin-drift-${counter}`);
  return database;
}

const next = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

/** What the plugin and the agents are on one side of the restart. */
interface World {
  readonly pluginVersion: string;
  /** The plugin agent's own `version`, which replaces the plugin's in its pin. */
  readonly agentVersion?: string | undefined;
  readonly generate: GenerateFunction;
  /** The name of the plugin agent inside `p`; the session rows run `p:echo`, the goal rows `p:worker`. */
  readonly pluginAgent?: string;
  readonly validators?: boolean;
}

/** A Bureau over a new handle on the shared database: the plugin agent `p:echo` and the built-in `scribe`. */
async function bureauOver(world: World): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      scribe: createAgent({
        generate: world.generate,
        toolbox: createToolbox([next]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    plugins: [
      versionedPlugin({
        version: world.pluginVersion,
        ...(world.agentVersion === undefined ? {} : { agentVersion: world.agentVersion }),
        ...(world.pluginAgent === undefined ? {} : { name: world.pluginAgent }),
        generate: world.generate,
      }),
    ],
    ...(world.validators === true ? { validators: [createCheckValidator()] } : {}),
    storage: database.open(),
    durable: true,
    durableOwnership: { ownership: 'none' },
    onDiagnostic: () => undefined,
  });
  bureaus.push(bureau);
  return bureau;
}

/** Takes one step, then hangs at the next: the run a crash leaves behind. */
function dyingAt(reached: { step1: boolean }): GenerateFunction {
  return async ({ step }) => {
    if (step === 0) return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
    reached.step1 = true;
    return new Promise<never>(() => {});
  };
}

const resuming: GenerateFunction = async ({ step }) => ({
  content: `resumed at step ${step}`,
  toolCalls: [],
});

/** Saves `overrides` as the next version of `id`'s overrides. */
async function setOverrides(
  bureau: Bureau<AgentDefinitions>,
  id: string,
  overrides: AgentOverrides,
): Promise<void> {
  const state = await bureau.agents.overrides.get(id);
  if (state === undefined) throw new Error(`Expected "${id}" to take overrides.`);
  await bureau.agents.overrides.save(id, overrides, { expectedHash: state.hash });
}

const A: AgentOverrides = { instructions: 'A.' };
const B: AgentOverrides = { instructions: 'B.' };

interface Side {
  readonly pluginVersion: string;
  readonly agentVersion?: string;
}

interface Row {
  readonly name: string;
  readonly agent: 'p:echo' | 'scribe';
  readonly started: Side;
  readonly recovered: Side;
  /** Saved before the run starts, in order. */
  readonly before?: readonly AgentOverrides[];
  /** Saved after it started and before the restart, in order. */
  readonly after?: readonly AgentOverrides[];
  /** `completed`, or the strings the failure names (never "no longer in the catalog"). */
  readonly expected: 'completed' | readonly (string | RegExp)[];
  /** Strings the failure must not name. */
  readonly absent?: readonly string[];
}

const ROWS: readonly Row[] = [
  // The agent is as it was.
  {
    name: 'a plugin agent unchanged resumes and completes',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    expected: 'completed',
  },
  {
    name: 'a built-in agent unchanged resumes and completes',
    agent: 'scribe',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    expected: 'completed',
  },
  // The plugin's version.
  {
    name: 'a plugin version that moved settles failed, naming both versions',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.1.0' },
    expected: ['definition-drifted', /version was 1\.0\.0 and is now 1\.1\.0/],
    absent: ['no longer in the catalog'],
  },
  {
    name: 'a plugin that moved does not touch a built-in agent, which pins only its overrides',
    agent: 'scribe',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.1.0' },
    expected: 'completed',
  },
  // The agent's own version replaces the plugin's.
  {
    name: 'an agent version that did not move resumes though the plugin did',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0', agentVersion: '2.0.0' },
    recovered: { pluginVersion: '1.1.0', agentVersion: '2.0.0' },
    expected: 'completed',
  },
  {
    name: 'an agent version that moved settles failed, naming both agent versions',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0', agentVersion: '2.0.0' },
    recovered: { pluginVersion: '1.0.0', agentVersion: '2.1.0' },
    expected: ['definition-drifted', /version was 2\.0\.0 and is now 2\.1\.0/],
  },
  {
    name: 'an agent version added settles failed, since the pinned string is the plugin’s',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0', agentVersion: '2.0.0' },
    expected: ['definition-drifted', /version was 1\.0\.0 and is now 2\.0\.0/],
  },
  {
    name: 'an agent version removed settles failed, since the pinned string is the agent’s',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0', agentVersion: '2.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    expected: ['definition-drifted', /version was 2\.0\.0 and is now 1\.0\.0/],
  },
  {
    name: 'an agent version equal to the plugin’s string compares equal to it',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0', agentVersion: '1.0.0' },
    expected: 'completed',
  },
  // The overrides.
  {
    name: 'a new override version saved after the run started settles failed',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    before: [A],
    after: [B],
    expected: ['definition-drifted', /overrides hashed [0-9a-f]{64} and now hash [0-9a-f]{64}/],
  },
  {
    name: 'a first override saved after a run that started with none settles failed',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    after: [A],
    expected: ['definition-drifted'],
  },
  {
    name: 'overrides changed and restored to the same content resume, for the hash is of content',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    before: [A],
    after: [B, A],
    expected: 'completed',
  },
  {
    name: 'overrides cleared after the run started settle failed',
    agent: 'p:echo',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    before: [A],
    after: [{}],
    expected: ['definition-drifted'],
  },
  {
    name: 'a built-in agent whose overrides moved settles failed, naming no version',
    agent: 'scribe',
    started: { pluginVersion: '1.0.0' },
    recovered: { pluginVersion: '1.0.0' },
    before: [A],
    after: [B],
    expected: ['definition-drifted', /overrides hashed/],
    absent: ['version was'],
  },
];

/** What a session's latest run ended as, after the second Bureau recovered it. */
async function runThenRecover(row: Row) {
  freshDatabase();
  const reached = { step1: false };
  const crashed = await bureauOver({ ...row.started, generate: dyingAt(reached) });
  for (const overrides of row.before ?? []) await setOverrides(crashed, row.agent, overrides);
  const run = await crashed.tasks.start(row.agent, 'Recover me');
  await waitUntil(() => reached.step1, { message: 'the run reached step 1' });
  for (const overrides of row.after ?? []) await setOverrides(crashed, row.agent, overrides);
  return { crashed, run };
}

/** A session's metadata, empty for a session the Bureau does not hold. */
async function metadataOf(bureau: Bureau<AgentDefinitions>, contextId: string) {
  const session = await bureau.contexts.get(contextId);
  return session?.metadata ?? {};
}

async function outcomeOf(bureau: Bureau<AgentDefinitions>, contextId: string) {
  await waitUntil(
    async () => {
      const metadata = await metadataOf(bureau, contextId);
      return metadata['lastRunStatus'] !== 'running';
    },
    {
      message: 'the recovered run settled',
    },
  );
  const metadata = await metadataOf(bureau, contextId);
  return {
    status: metadata['lastRunStatus'],
    error: typeof metadata['lastError'] === 'string' ? metadata['lastError'] : '',
  };
}

describe('a session run of a code agent recovered after the agent moved', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const { run } = await runThenRecover(row);

      const restarted = await bureauOver({ ...row.recovered, generate: resuming });
      const outcome = await outcomeOf(restarted, run.contextId);

      if (row.expected === 'completed') {
        expect(outcome).toEqual({ status: 'completed', error: '' });
        return;
      }
      expect(outcome.status).toBe('error');
      for (const named of row.expected) {
        if (typeof named === 'string') expect(outcome.error).toContain(named);
        else expect(outcome.error).toMatch(named);
      }
      for (const absent of row.absent ?? []) expect(outcome.error).not.toContain(absent);
    });
  }

  it('records the pin in the session at the start, and a record without it recovers as it always did', async () => {
    const { crashed, run } = await runThenRecover({
      name: 'legacy',
      agent: 'p:echo',
      started: { pluginVersion: '1.0.0' },
      recovered: { pluginVersion: '1.1.0' },
      expected: 'completed',
    });
    const kv = crashed.internals.kv;
    if (kv === undefined) throw new Error('Expected the Bureau to keep a store.');
    const sessions = createSessionStore(kv);
    const session = await sessions.load(run.contextId);
    expect(session?.metadata).toMatchObject({
      lastAgentPinRunId: run.id,
      lastAgentPluginVersion: '1.0.0',
      lastAgentOverrideHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // The same session as a Bureau from before the pin wrote it: neither key, and the plugin moves.
    const {
      lastAgentPluginVersion: _version,
      lastAgentOverrideHash: _hash,
      ...legacy
    } = session?.metadata ?? {};
    if (session === undefined) throw new Error('Expected the session.');
    await sessions.save({ ...session, metadata: legacy });
    const restarted = await bureauOver({ pluginVersion: '1.1.0', generate: resuming });

    expect(await outcomeOf(restarted, run.contextId)).toEqual({ status: 'completed', error: '' });
  });
});

describe('a goal attempt (a catalog run record) recovered after the agent moved', () => {
  const GOAL_AGENT = 'p:worker';
  const ATTEMPT_RUN = 'goal-g1-a0';
  const attemptKey = `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${ATTEMPT_RUN}`;

  async function dyingGoal(side: Side) {
    freshDatabase();
    const crashed = await bureauOver({
      ...side,
      pluginAgent: 'worker',
      validators: true,
      generate: hangForever,
    });
    await crashed.goals.create({ ...goalRequest(), agentName: GOAL_AGENT });
    await pollUntil(async () => (await goalStatus(crashed)) === 'running');
    // The claim is written before the workflow starts; wait for the attempt's workflow too.
    await pollUntil(async () => (await workflowStatus(crashed, ATTEMPT_RUN)) !== undefined);
    return crashed;
  }

  async function recoveredAttempt(side: Side) {
    const restarted = await bureauOver({
      ...side,
      pluginAgent: 'worker',
      validators: true,
      generate: async () => ({ content: 'done', toolCalls: [] }),
    });
    await restarted.recovery();
    await pollUntil(async () => {
      const status = await workflowStatus(restarted, ATTEMPT_RUN);
      return status === 'completed' || status === 'failed';
    });
    return restarted;
  }

  it('records the pin in the claim', async () => {
    await dyingGoal({ pluginVersion: '1.0.0' });
    const view = await inspect(database.open());
    views.push(view);

    const raw = await view.storage.get(attemptKey);

    expect(decode(raw as Uint8Array)).toMatchObject({
      agentName: GOAL_AGENT,
      agentPluginVersion: '1.0.0',
      agentOverrideHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('resumes and completes when the plugin version and overrides are unchanged', async () => {
    await dyingGoal({ pluginVersion: '1.0.0' });

    const restarted = await recoveredAttempt({ pluginVersion: '1.0.0' });

    expect(await workflowStatus(restarted, ATTEMPT_RUN)).toBe('completed');
  });

  it('settles the attempt’s run failed with definition-drifted, naming both versions, when the plugin moved', async () => {
    await dyingGoal({ pluginVersion: '1.0.0' });

    const restarted = await recoveredAttempt({ pluginVersion: '1.1.0' });

    const state = await restarted.tasks.workflow('goal-g1-a0');
    expect(state?.status).toBe('failed');
    const text = JSON.stringify(state);
    expect(text).toContain('definition-drifted');
    expect(text).toContain('1.0.0');
    expect(text).toContain('1.1.0');
    expect(text).not.toContain('no longer in the catalog');
  });

  it('settles the attempt’s run failed when an override was saved after it started', async () => {
    const crashed = await dyingGoal({ pluginVersion: '1.0.0' });
    await setOverrides(crashed, GOAL_AGENT, A);

    const restarted = await recoveredAttempt({ pluginVersion: '1.0.0' });

    const state = await restarted.tasks.workflow('goal-g1-a0');
    expect(state?.status).toBe('failed');
    expect(JSON.stringify(state)).toContain('definition-drifted');
  });

  it('recovers a claim written before the pin as it always did, though the plugin moved', async () => {
    await dyingGoal({ pluginVersion: '1.0.0' });
    const view = await inspect(database.open());
    views.push(view);
    const raw = await view.storage.get(attemptKey);
    const {
      agentPluginVersion: _version,
      agentOverrideHash: _hash,
      ...legacy
    } = decode(raw as Uint8Array) as Record<string, unknown>;
    await view.storage.put(attemptKey, encode(legacy));

    const restarted = await recoveredAttempt({ pluginVersion: '1.1.0' });

    expect(await workflowStatus(restarted, ATTEMPT_RUN)).toBe('completed');
  });
});
