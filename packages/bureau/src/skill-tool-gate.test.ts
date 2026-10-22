/**
 * COR-1628 — a call to a tool the active skills' `allowed-tools` exclude is refused with
 * `SKILL_TOOL_DENIED` before it runs, on every path that composes a skill-narrowed toolbox: a
 * Bureau run, a `createAgent` agent with `createAgentSkills`, a run whose recorded skills cannot
 * be verified, and a durable run that recovers after a crash.
 */
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  ToolSettledBubbleEvent,
  type Toolbox,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Conversation, getMessages } from 'conversationalist';
import { z } from 'zod';

import { createAgentSkills } from './agent-skills';
import { createRuntimeComposition } from './runtime-composition';
import { createSkillArtifactLoader, createSkillClient } from './skills';
import { createScheduleFireHarness, pollUntil } from './schedule-fire-fixtures.test-support';
import {
  letStepsCommit,
  pollForTime,
  removeSkillRoots,
  skillCatalogOnDisk,
  skillsRecorded,
} from './skill-policy-fixtures.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});
afterAll(removeSkillRoots);

const REFUSAL = `Tool "ping" is not available: the active skills' allowed-tools exclude it.`;

/** `ping` records each execution. The skill tools come from the skills subsystem. */
function pingToolbox(executions: string[]): Toolbox {
  return createToolbox([
    createTool({
      name: 'ping',
      version: '1.0.0',
      description: 'Pings',
      input: z.object({}),
      async execute() {
        executions.push('ping');
        return 'pong';
      },
    }),
  ]) as unknown as Toolbox;
}

/** Step 0 activates `lock`, which allows only `deactivate_skill`; step 1 calls `ping`. */
function activateThenPing(
  onLaterStep?: (context: GenerateContext) => Promise<void>,
): GenerateFunction {
  return async (context) => {
    if (context.step === 0) {
      return {
        content: '',
        toolCalls: [{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }],
      };
    }
    if (context.step === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'ping-1', name: 'ping', arguments: {} }],
      };
    }
    await onLaterStep?.(context);
    return { content: 'done', toolCalls: [] };
  };
}

/** What a conversation recorded for one tool call. */
function resultOf(
  messages: ReadonlyArray<ReturnType<typeof getMessages>[number]>,
  callId: string,
): { outcome: string; code?: string; content: unknown } | undefined {
  const message = messages.find((candidate) => candidate.toolResult?.callId === callId);
  const toolResult = message?.toolResult;
  if (toolResult === undefined) return undefined;
  return {
    outcome: toolResult.outcome,
    ...(toolResult.error === undefined ? {} : { code: toolResult.error.code }),
    content: toolResult.content,
  };
}

describe('a Bureau run narrowed by an active skill (COR-1628)', () => {
  it('refuses a call to a hidden tool and records the refusal in the session', async () => {
    const catalog = await skillCatalogOnDisk();
    const executions: string[] = [];
    const bureau = await harness.open({
      generate: activateThenPing(),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog: await catalog.discover() },
      toolbox: pingToolbox(executions),
    });

    const run = await bureau.createRun({ message: 'activate, then ping' });
    const recorded = await pollUntil(async () => {
      const session = await bureau.getSession(run.sessionId);
      const messages = session === undefined ? [] : getMessages(session.conversationHistory);
      return resultOf(messages, 'ping-1');
    }, 'the refusal to be recorded in the session');

    expect(recorded).toEqual({ outcome: 'error', code: 'SKILL_TOOL_DENIED', content: REFUSAL });
    expect(executions).toEqual([]);
    const settled = await pollUntil(async () => {
      const records =
        (await bureau.auditTrail?.query({ runId: run.id, type: 'tool.settled' })) ?? [];
      return records.find((record) => JSON.stringify(record.detail).includes('ping-1'));
    }, 'the refused call to be audited as settled');
    expect(JSON.stringify(settled.detail)).toContain('error');
  });
});

describe('a createAgent agent narrowed by createAgentSkills (COR-1628)', () => {
  it('refuses a call to a hidden tool, settles it as an error, and records it', async () => {
    const catalog = await skillCatalogOnDisk();
    const executions: string[] = [];
    const agent = createAgent({
      generate: activateThenPing(),
      toolbox: pingToolbox(executions),
      guardrails: false,
      skills: createAgentSkills({ catalog: await catalog.discover() }),
    });
    const run = agent.run('activate, then ping');
    const settled: Array<[string, string]> = [];
    for await (const event of run) {
      if (event instanceof ToolSettledBubbleEvent) settled.push([event.toolCallId, event.status]);
    }

    const result = await run.result();

    expect(executions).toEqual([]);
    expect(settled).toContainEqual(['ping-1', 'error']);
    const refused = result.steps
      .flatMap((step) => step.results)
      .find((entry) => entry.toolCallId === 'ping-1');
    expect(refused?.error?.code).toBe('SKILL_TOOL_DENIED');
    expect(refused?.content).toBe(REFUSAL);
    expect(resultOf(result.conversation.getMessages(), 'ping-1')).toEqual({
      outcome: 'error',
      code: 'SKILL_TOOL_DENIED',
      content: REFUSAL,
    });
  });
});

describe('a run whose recorded skills cannot be verified (COR-1628)', () => {
  it('refuses every call with SKILL_TOOL_DENIED', async () => {
    const executions: string[] = [];
    // Records the run was given, with no skill client to enforce them: the policy is
    // `{ allowList: [] }`, so the model sees no tool and a call to one is refused.
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: pingToolbox(executions),
    });
    const runRuntime = await runtime.createRunRuntime(
      { message: 'Hello', sessionId: 'unverifiable-skill-session' },
      {
        liveStreaming: false,
        initialActiveSkillRecords: [
          { name: 'lock' } as unknown as NonNullable<
            Parameters<typeof runtime.createRunRuntime>[1]
          >['initialActiveSkillRecords'] extends ReadonlyArray<infer Record> | undefined
            ? Record
            : never,
        ],
      },
    );

    expect(runRuntime.toolbox.tools()).toEqual([]);
    const results = await runRuntime.toolbox.execute([
      { id: 'ping-1', name: 'ping', arguments: {} },
      { id: 'ping-2', name: 'Ping', arguments: {} },
    ]);

    expect(results.map((result) => result.error?.code)).toEqual([
      'SKILL_TOOL_DENIED',
      'SKILL_TOOL_DENIED',
    ]);
    expect(executions).toEqual([]);
  });
});

describe('a run whose stored skill fails recovery (COR-1628)', () => {
  it('refuses every call with SKILL_TOOL_DENIED', async () => {
    const catalog = await skillCatalogOnDisk();
    const discovered = await catalog.discover();
    const client = createSkillClient({
      catalog: discovered,
      loadArtifact: createSkillArtifactLoader({}),
    });
    await client.activate('lock');
    // A digest the catalog cannot produce is what a rewritten bundle looks like.
    const tampered = client
      .activationRecords()
      .map((record) => ({ ...record, instructionsDigest: 'f'.repeat(64) }));
    const executions: string[] = [];
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: pingToolbox(executions),
      skills: { catalog: discovered },
    });
    const runRuntime = await runtime.createRunRuntime(
      { message: 'Hello', sessionId: 'tampered-skill-session' },
      { liveStreaming: false, initialActiveSkillRecords: tampered },
    );
    // Recovery runs in the first step's `prepareStep`, which every step awaits.
    const conversation = new Conversation();
    for (const { handler } of runRuntime.hooks.getHandlers('prepareStep')) {
      await handler({ step: 0, conversation });
    }

    const result = await runRuntime.toolbox.execute({ id: 'ping-1', name: 'ping', arguments: {} });

    expect(result.error?.code).toBe('SKILL_TOOL_DENIED');
    expect(executions).toEqual([]);
  });
});

describe('a durable run that refused a call and recovered (COR-1628)', () => {
  it('replays the same refusal and does not run the tool', async () => {
    const catalog = await skillCatalogOnDisk();
    const path = harness.nextDatabasePath();
    const executions: string[] = [];
    let reachedLaterStep = false;
    const first = await harness.open({
      generate: activateThenPing(
        (context) =>
          new Promise((_resolve, reject) => {
            reachedLaterStep = true;
            context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog: await catalog.discover() },
      toolbox: pingToolbox(executions),
      storage: { type: 'sqlite', path },
    });
    const run = await first.createRun({ message: 'activate, then ping' });
    await pollForTime(
      async () =>
        reachedLaterStep && (await skillsRecorded(first, run.sessionId)) ? true : undefined,
      'the refused step to commit',
    );
    await letStepsCommit();
    expect(executions).toEqual([]);

    // The process "crashes": a second Bureau recovers the run from the same store.
    const replayed: Array<{ outcome: string; code?: string; content: unknown } | undefined> = [];
    const recovered = await harness.open({
      generate: activateThenPing(async (context) => {
        replayed.push(resultOf(getMessages(context.conversation.current), 'ping-1'));
      }),
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog: await catalog.discover() },
      toolbox: pingToolbox(executions),
      storage: { type: 'sqlite', path },
    });
    await pollUntil(
      () => (replayed.length > 0 ? true : undefined),
      'the recovered run to continue',
    );

    expect(replayed[0]).toEqual({ outcome: 'error', code: 'SKILL_TOOL_DENIED', content: REFUSAL });
    expect(executions).toEqual([]);
    expect(recovered.listRuns().some((candidate) => candidate.id === run.id)).toBe(true);
  });
});
