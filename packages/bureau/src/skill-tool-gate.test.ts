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
  withActiveSkillToolPolicy,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { Conversation, getMessages } from 'conversationalist';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { activeSkillToolPolicy, createAgentSkills } from './agent-skills';
import { createRuntimeComposition } from './runtime-composition';
import { createSkillArtifactLoader, createSkillClient, discoverSkills } from './skills';
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

const exemptionRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    exemptionRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

/**
 * A catalog whose `reader` skill narrows the run with `allowed-tools: Read` (naming none of the
 * lifecycle tools) and ships one resource, plus a `helper` skill with no narrowing to activate.
 */
async function exemptionCatalog() {
  const root = await mkdtemp(join(tmpdir(), 'bureau-lifecycle-exemption-'));
  exemptionRoots.push(root);
  const skills = [
    { name: 'reader', allowedTools: 'Read', resources: { 'references/guide.md': '# Guide' } },
    { name: 'helper', allowedTools: undefined, resources: {} },
  ];
  for (const skill of skills) {
    const directory = join(root, skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      [
        '---',
        `name: ${skill.name}`,
        `description: The ${skill.name} skill`,
        ...(skill.allowedTools === undefined ? [] : [`allowed-tools: ${skill.allowedTools}`]),
        '---',
        '',
        `Instructions for ${skill.name}.`,
        '',
      ].join('\n'),
    );
    for (const [path, content] of Object.entries(skill.resources)) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), content);
    }
  }
  return discoverSkills({
    sources: [{ id: 'user', kind: 'user', location: root, precedence: 20 }],
  });
}

/** `ping` and `deactivate_skill_cache` record each execution; neither is a lifecycle tool. */
function hostToolbox(executions: string[]): Toolbox {
  return createToolbox(
    ['ping', 'deactivate_skill_cache'].map((name) =>
      createTool({
        name,
        version: '1.0.0',
        description: name,
        input: z.object({}),
        async execute() {
          executions.push(name);
          return name;
        },
      }),
    ),
  ) as unknown as Toolbox;
}

interface ScriptedCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

interface ScriptedRun {
  /** The tool names the model was shown at each step. */
  readonly toolsByStep: string[][];
  /** What the conversation recorded for each scripted call. */
  readonly results: Record<string, ReturnType<typeof resultOf>>;
  readonly executions: string[];
}

type RunPath = 'bureau' | 'createAgent';

/**
 * Plays one scripted step per entry of `script` and then stops, recording what the model was
 * shown at each step and what the conversation recorded for every scripted call, on either path
 * that composes a skill-narrowed toolbox.
 */
async function playScript(path: RunPath, script: ScriptedCall[][]): Promise<ScriptedRun> {
  const catalog = await exemptionCatalog();
  const executions: string[] = [];
  const toolsByStep: string[][] = [];
  const results: ScriptedRun['results'] = {};
  const finished = Promise.withResolvers<void>();
  const generate: GenerateFunction = async (context) => {
    toolsByStep.push(context.toolbox.tools().map((tool) => tool.name));
    const calls = script[context.step];
    if (calls !== undefined) return { content: '', toolCalls: calls };
    const messages = getMessages(context.conversation.current);
    for (const call of script.flat()) results[call.id] = resultOf(messages, call.id);
    finished.resolve();
    return { content: 'done', toolCalls: [] };
  };

  if (path === 'createAgent') {
    const agent = createAgent({
      generate,
      toolbox: hostToolbox(executions),
      guardrails: false,
      skills: createAgentSkills({ catalog }),
    });
    await agent.run('play the script').result();
  } else {
    const bureau = await harness.open({
      generate,
      stopWhen: stopWhen.noToolCalls(),
      skills: { catalog },
      toolbox: hostToolbox(executions),
    });
    await bureau.createRun({ message: 'play the script' });
    await finished.promise;
  }
  return { toolsByStep, results, executions };
}

const SKILL_LIFECYCLE_NAMES = ['activate_skill', 'load_skill_resource', 'deactivate_skill'];

const LIFECYCLE_CALLS: Array<[string, Record<string, unknown>]> = [
  ['activate_skill', { name: 'helper' }],
  ['load_skill_resource', { skillName: 'reader', path: 'references/guide.md' }],
  ['deactivate_skill', { name: 'reader' }],
];

describe.each(['bureau', 'createAgent'] as const)(
  'the skill lifecycle tools under an active skill that does not list them, on the %s path (COR-1633)',
  (path) => {
    it.each(LIFECYCLE_CALLS)('keeps %s visible and runs a call to it', async (name, args) => {
      const run = await playScript(path, [
        [{ id: 'activate-1', name: 'activate_skill', arguments: { name: 'reader' } }],
        [{ id: 'lifecycle-1', name, arguments: args }],
      ]);

      // Step 2 is the model's view after `reader` narrowed the run to `Read`.
      expect(run.toolsByStep[1]).toEqual([
        'activate_skill',
        'load_skill_resource',
        'deactivate_skill',
      ]);
      expect(run.results['lifecycle-1']?.code).toBeUndefined();
      expect(run.results['lifecycle-1']?.outcome).toBe('success');
    });

    it('lets a skill that allows only Read load its resource and then deactivate itself', async () => {
      const run = await playScript(path, [
        [{ id: 'activate-1', name: 'activate_skill', arguments: { name: 'reader' } }],
        [
          {
            id: 'load-1',
            name: 'load_skill_resource',
            arguments: { skillName: 'reader', path: 'references/guide.md' },
          },
        ],
        [{ id: 'deactivate-1', name: 'deactivate_skill', arguments: { name: 'reader' } }],
      ]);

      expect(run.results['load-1']).toMatchObject({ outcome: 'success' });
      expect(JSON.stringify(run.results['load-1']?.content)).toContain('# Guide');
      expect(run.results['deactivate-1']).toMatchObject({ outcome: 'success' });
      expect(JSON.stringify(run.results['deactivate-1']?.content)).toContain('"deactivated":true');
      // While `reader` is active the host tools are hidden; once it is deactivated they return.
      expect(run.toolsByStep[1]).not.toContain('ping');
      expect(run.toolsByStep[3]).toEqual(
        expect.arrayContaining(['ping', 'deactivate_skill_cache', 'activate_skill']),
      );
    });

    it('exempts exact names only: a host tool that merely starts with a lifecycle name stays hidden', async () => {
      const run = await playScript(path, [
        [{ id: 'activate-1', name: 'activate_skill', arguments: { name: 'reader' } }],
        [{ id: 'cache-1', name: 'deactivate_skill_cache', arguments: {} }],
      ]);

      expect(run.toolsByStep[1]).not.toContain('deactivate_skill_cache');
      expect(run.results['cache-1']).toMatchObject({ outcome: 'error', code: 'SKILL_TOOL_DENIED' });
      expect(run.executions).toEqual([]);
    });
  },
);

describe('the gate judges a call by the tool it reaches (COR-1633)', () => {
  // `combineToolboxes` does not carry a toolbox's `resolution` option over, so a Bureau run's
  // composed toolbox answers a near-miss name with NOT_FOUND. The exemption is still pinned
  // against a toolbox that does resolve, because it is the policy the builders hand the gate.
  function resolvingToolbox(executions: string[]) {
    const stub = (name: string) =>
      createTool({
        name,
        version: '1.0.0',
        description: name,
        input: z.object({}),
        async execute() {
          executions.push(name);
          return name;
        },
      });
    return createToolbox(['ping', 'deactivate_skill_cache', ...SKILL_LIFECYCLE_NAMES].map(stub), {
      resolution: true,
    }) as unknown as Toolbox;
  }

  it('runs a near-miss name that resolves to a lifecycle tool, and refuses one that resolves to a hidden tool', async () => {
    const executions: string[] = [];
    const gated = withActiveSkillToolPolicy(resolvingToolbox(executions), () =>
      activeSkillToolPolicy(['Read']),
    );

    expect(gated.tools().map((tool) => tool.name)).toEqual(SKILL_LIFECYCLE_NAMES);
    const results = await gated.execute([
      { id: 'near-lifecycle', name: 'Activate_Skill', arguments: {} },
      { id: 'near-hidden', name: 'Deactivate_Skill_Cache', arguments: {} },
      { id: 'exact-hidden', name: 'deactivate_skill_cache', arguments: {} },
    ]);

    expect(results.map((result) => result.error?.code)).toEqual([
      undefined,
      'SKILL_TOOL_DENIED',
      'SKILL_TOOL_DENIED',
    ]);
    expect(executions).toEqual(['activate_skill']);
  });
});

describe('a run whose stored skill fails recovery refuses the lifecycle tools (COR-1633)', () => {
  it('hides and refuses all three, because an unverified run must not regain tools', async () => {
    const catalog = await exemptionCatalog();
    const client = createSkillClient({
      catalog,
      loadArtifact: createSkillArtifactLoader({}),
    });
    await client.activate('reader');
    const tampered = client
      .activationRecords()
      .map((record) => ({ ...record, instructionsDigest: 'f'.repeat(64) }));
    const runtime = await createRuntimeComposition({
      generate: async () => ({ content: 'ok', toolCalls: [] }),
      toolbox: hostToolbox([]),
      skills: { catalog },
    });
    const runRuntime = await runtime.createRunRuntime(
      { message: 'Hello', sessionId: 'tampered-lifecycle-session' },
      { liveStreaming: false, initialActiveSkillRecords: tampered },
    );
    const conversation = new Conversation();
    for (const { handler } of runRuntime.hooks.getHandlers('prepareStep')) {
      await handler({ step: 0, conversation });
    }

    expect(runRuntime.toolbox.tools()).toEqual([]);
    const results = await runRuntime.toolbox.execute(
      LIFECYCLE_CALLS.map(([name, args], index) => ({
        id: `call-${index}`,
        name,
        arguments: args,
      })),
    );

    expect(results.map((result) => result.error?.code)).toEqual([
      'SKILL_TOOL_DENIED',
      'SKILL_TOOL_DENIED',
      'SKILL_TOOL_DENIED',
    ]);
  });
});
