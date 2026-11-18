/**
 * COR-2429 — a disabled agent starts nothing new, by any path, and a run that already started on
 * it finishes. Two guards:
 *
 * - **Every place a run looks an agent up by name is listed.** The source of every lookup of an
 *   agent for a run (`agentCatalog.find`, `agentCatalog.findToStart`, `bureau.agents.find`,
 *   `resolveSessionAgentRun`) and every
 *   grant of the resume exemption (`alreadyStarted:`) is counted per file and compared with the
 *   table below, which says what each one is. A new start path fails here until it is listed, and
 *   so does a new exemption, which must name its evidence that the run already started.
 * - **Each start path refuses a disabled agent, and a resume finishes.** One table of starts, each
 *   run on a Bureau whose agent was disabled after the setup it needs, by that Bureau or by another
 *   over the same store, none of which may call the agent's model.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { SessionRegenerateRefusedError } from './session-regenerate';

const SOURCE_ROOT = import.meta.dir;
const LOOKUP =
  /\bagentCatalog\.find(?:ToStart)?\(|\bbureau\.agents\.find\(|\bresolveSessionAgentRun\(|\balreadyStarted:/g;

/**
 * Every source file that looks an agent up for a run, how many times, and why each is safe for a
 * disabled agent: a lookup without `includeDisabled` does not find one, so a start through it is
 * refused, and only the resolver exempts a run that carries `alreadyStarted` evidence.
 */
const LISTED: Readonly<Record<string, { readonly count: number; readonly why: string }>> = {
  'bureau-catalog-dispatch.ts': {
    count: 6,
    why: 'a child run and a goal attempt are planned through findToStart(), which reads the gate from the store, so the find() of the start in the same turn sees a disable another Bureau wrote; a workflow step is checked by findToStart() in child-runs.ts first; a durable catalog run re-reads its overrides',
  },
  'create-bureau.ts': {
    count: 2,
    why: 'the facade find() the HTTP handlers (A2A, schedules, memory) use, and the resolver, which exempts only alreadyStarted',
  },
  'runtime-composition.ts': {
    count: 2,
    why: 'the resolver accessor, and a catalog run resolving from its own record: written once dispatch admitted it (alreadyStarted)',
  },
  'runtime-composition-types.ts': { count: 1, why: 'the resolveSessionAgentRun signature' },
  'composition-seams/session-agent-runs.ts': {
    count: 3,
    why: 'its definition and a session run being recovered after a restart (alreadyStarted)',
  },
  'composition-seams/scheduled-run-services.ts': {
    count: 2,
    why: 'a scheduled fire: alreadyStarted only when its first attempt recorded a reference or wrote its session',
  },
  'bureau-seams/run-creation.ts': {
    count: 2,
    why: 'a new chat or task run: refused; alreadyStarted only for a start that brings nothing of its own and continues a chat ending in a decided tool result, which finishes the run that parked on it',
  },
  'bureau-seams/session-regeneration.ts': {
    count: 1,
    why: 'Regenerate or Try again: no recorded, refused',
  },
  'bureau-seams/session-restore.ts': {
    count: 2,
    why: 'a session run restored after it started (alreadyStarted)',
  },
  'bureau-seams/child-runs.ts': {
    count: 1,
    why: 'a workflow step: findToStart(), which reads the gate from the store, refused',
  },
  'bureau-seams/schedule-operations.ts': {
    count: 2,
    why: 'creating or retargeting a schedule: find(), refused',
  },
  'bureau-seams/session-forks.ts': { count: 3, why: 'a fork of a chat: find(), refused' },
  'bureau-seams/approved-tool-scan.ts': { count: 1, why: 'reads tools, starts nothing' },
  'http/create-bureau-handler.ts': {
    count: 6,
    why: 'the A2A card, an A2A or AG-UI start, and the agent lists: find(), refused',
  },
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'testing' || entry.name === '__fixtures__') {
        continue;
      }
      files.push(...sourceFiles(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !/\.test\.ts$|\.test-support\.ts$|\.d\.ts$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('every place a run looks an agent up by name (COR-2429)', () => {
  it('is listed, with why a disabled agent starts nothing there', () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const count = readFileSync(file, 'utf8').match(LOOKUP)?.length ?? 0;
      if (count > 0) found[relative(SOURCE_ROOT, file)] = count;
    }

    const listed = Object.fromEntries(
      Object.entries(LISTED).map(([file, entry]) => [file, entry.count]),
    );
    expect(found).toEqual(listed);
  });
});

/** What one start path came to on a disabled agent. */
type Outcome = 'refused' | 'ran';

interface Fixture {
  readonly bureau: Bureau<AgentDefinitions>;
  /** How many times the disabled agent's model was asked. */
  readonly calls: () => number;
  readonly disable: () => Promise<void>;
}

const opened: Array<Bureau<AgentDefinitions>> = [];
afterEach(async () => {
  for (const bureau of opened.splice(0)) await bureau.dispose();
});

/**
 * Where the agent is disabled: on the Bureau the run starts on, or on another Bureau over the same
 * store, whose disable the first learns only from the store (COR-2429).
 */
type DisabledBy = 'this Bureau' | 'another Bureau on the same store';

async function fixture(
  maintenance?: 'manual',
  disabledBy: DisabledBy = 'this Bureau',
): Promise<Fixture> {
  let calls = 0;
  const helper: GenerateFunction = async () => {
    calls += 1;
    return { content: 'done', toolCalls: [] };
  };
  const asking: GenerateFunction = async (context: GenerateContext) =>
    context.step === 0
      ? {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Which?' },
            },
          ],
        }
      : { content: 'thanks', toolCalls: [] };
  const storage = new MemoryStorage();
  const open = async () => {
    const opening = await createBureau<AgentDefinitions>({
      agents: {
        helper: createAgent({ generate: helper, toolbox: createToolbox([]) }),
        asker: createAgent({
          generate: asking,
          toolbox: createToolbox([]),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage,
      durable: true,
      ...(maintenance === undefined ? {} : { maintenance }),
    });
    opened.push(opening);
    return opening;
  };
  const bureau = await open();
  const disabler = disabledBy === 'this Bureau' ? bureau : await open();
  return {
    bureau,
    calls: () => calls,
    disable: async () => {
      await disabler.agents.disable('helper', { disabledBy: 'operator' });
    },
  };
}

/** The durable state `workflowId` settles in. */
async function settled(bureau: Bureau<AgentDefinitions>, workflowId: string): Promise<string> {
  let status = '';
  await waitUntil(async () => {
    const state = await bureau.durableEngine()?.get(workflowId);
    status = state?.status ?? '';
    return status !== '' && status !== 'pending' && status !== 'running';
  });
  return status;
}

/** A start through `start`, read as refused when it throws or settles anything but completed. */
async function outcomeOf(start: () => Promise<string | undefined>): Promise<Outcome> {
  try {
    const status = await start();
    return status === 'completed' ? 'ran' : 'refused';
  } catch {
    return 'refused';
  }
}

/**
 * Each way a run starts on an agent, with what it needs set up while the agent is enabled. A start
 * path listed above that a Bureau test can reach is a row here.
 */
const STARTS: ReadonlyArray<{
  readonly path: string;
  /** A fire on time is driven by `maintain()`, so its Bureau runs no maintenance of its own. */
  readonly maintenance?: 'manual';
  readonly start: (fixture: Fixture) => Promise<Outcome>;
}> = [
  {
    path: 'a task or chat run (tasks.start)',
    start: async ({ bureau, disable }) => {
      await disable();
      return outcomeOf(async () => {
        const run = await bureau.tasks.start('helper', 'hello');
        return settled(bureau, run.id);
      });
    },
  },
  {
    path: 'a schedule firing on time',
    maintenance: 'manual',
    start: async ({ bureau, disable }) => {
      const schedule = await bureau.schedules.create({
        agentName: 'helper',
        input: 'check in',
        spec: '1h',
      });
      const at = schedule?.nextFireAt;
      if (schedule === undefined || at === null || at === undefined) {
        throw new Error('The schedule has no first occurrence.');
      }
      await disable();
      return outcomeOf(async () => {
        await bureau.maintain(at);
        // The fire is the one durable run the Bureau holds; it settles without asking the model.
        const engine = bureau.durableEngine();
        let fired: { readonly id: string; readonly status: string } | undefined;
        await waitUntil(async () => {
          const listed = await engine?.list();
          fired = listed?.items.find(
            (item) => item.status !== 'pending' && item.status !== 'running',
          );
          return fired !== undefined;
        });
        return fired?.status;
      });
    },
  },
  {
    path: 'a schedule run now',
    start: async ({ bureau, disable }) => {
      const schedule = await bureau.schedules.create({
        agentName: 'helper',
        input: 'check in',
        spec: '1h',
      });
      if (schedule === undefined) throw new Error('The schedule was not created.');
      await disable();
      return outcomeOf(async () => {
        const fired = await bureau.schedules.runNow(schedule.id);
        if (fired === undefined || fired.outcome === 'skipped') return 'skipped';
        return settled(bureau, fired.workflowId);
      });
    },
  },
  {
    path: 'Regenerate or Try again on a chat',
    start: async ({ bureau, calls, disable }) => {
      const run = await bureau.tasks.start('helper', 'hello', { principal: 'alice' });
      const answer = `${run.id}:step:0`;
      await waitUntil(async () => {
        const stored = await bureau.contexts.get(run.contextId);
        return stored?.conversationHistory.ids.at(-1) === answer;
      });
      const before = calls();
      await disable();
      const refusal = await rejectionOf(
        bureau.contexts.regenerate(run.contextId, {
          owner: 'alice',
          commandId: 'regenerate-1',
          messageId: answer,
        }),
      );
      expect(refusal).toBeInstanceOf(SessionRegenerateRefusedError);
      return calls() === before ? 'refused' : 'ran';
    },
  },
  {
    path: 'a child run',
    start: async ({ bureau, disable }) => {
      const parent = await bureau.tasks.start('asker', 'deploy', { principal: 'alice' });
      await waitUntil(() => bureau.reviews.list().some((review) => review.runId === parent.id));
      await disable();
      return outcomeOf(async () => {
        const dispatched = await bureau.children.dispatch({
          parentRunId: parent.id,
          agentName: 'helper',
          input: 'go',
        });
        if (dispatched.outcome !== 'started') return dispatched.outcome;
        return settled(bureau, dispatched.child.childRunId);
      });
    },
  },
];

describe('a start of a run on a disabled agent (COR-2429)', () => {
  const DISABLERS: readonly DisabledBy[] = ['this Bureau', 'another Bureau on the same store'];
  for (const disabledBy of DISABLERS) {
    for (const { path, maintenance, start } of STARTS) {
      it(`is refused: ${path}, disabled by ${disabledBy}, and its model is never asked`, async () => {
        // No maintenance pass runs between the disable and the start, so nothing but the start
        // path itself can have read the gate again from the store.
        const opened = await fixture(maintenance ?? 'manual', disabledBy);
        const before = opened.calls();

        const outcome = await start(opened);

        expect(outcome).toBe('refused');
        // Regenerate's setup asks once before the agent is disabled; nothing asks after.
        expect(opened.calls()).toBe(path.startsWith('Regenerate') ? before + 1 : before);
      });
    }
  }

  it('lets a run that already started finish, parked on a question when the agent was disabled', async () => {
    const { bureau } = await fixture();
    const run = await bureau.tasks.start('asker', 'deploy', { principal: 'alice' });
    await waitUntil(() => bureau.reviews.list().some((review) => review.runId === run.id));
    await bureau.agents.disable('asker', { disabledBy: 'operator' });
    const review = bureau.reviews.list().find((candidate) => candidate.runId === run.id);
    if (review === undefined) throw new Error('Expected the question.');

    await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'alice',
      payload: 'production',
    });

    const finished = await bureau.tasks.wait(run.id);
    expect(finished?.status).toBe('completed');
    expect(await rejectionOf(bureau.tasks.start('asker', 'again'))).toBeDefined();
  });
});
