/**
 * COR-2128 — a plugin declares, for each hook, how it replays, what happens when it throws, and
 * where it sorts: `{ handler, replay, onError, priority }`, the function being the same hook with
 * none of them. The unit tests below read the registry `interceptorsOf` builds; the runs show the
 * outcome a file agent gets for a throwing hook, and a hook asking to sort last still running in
 * front of the agent's guardrails.
 *
 * COR-2125 — every point of Operative's hook map is a point a plugin's interceptor can hook, and
 * a file agent that lists the interceptor runs it there. The registry `interceptorsOf` builds has
 * one entry for each point an interceptor defines, and the runs below show a plugin observing a
 * failed run (`onRunError`) and replacing a tool result (`validateToolResult`), the two points the
 * interceptor could not reach before.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { PluginInterceptor } from '@lostgradient/interborough-plugin';
import { HookRegistry, mergeHookRegistries } from '@lostgradient/lifecycle';
import { AGENT_POLICY_PINNED_LAST_PRIORITY, type OperativeHookMap } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  createAgentContributions,
  INTERCEPTOR_POINTS,
  INTERCEPTOR_PRIORITY_FLOOR,
  interceptorsOf,
} from './agent-contributions';
import { waitForTaskState } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import {
  type FileBureauHarness,
  type Script,
  startFileBureau,
} from './testing/agent-file-bureau.test-support';

/** An interceptor with a handler at every point, which does nothing. */
function interceptorAtEveryPoint(name: string): PluginInterceptor {
  const points = Object.fromEntries(INTERCEPTOR_POINTS.map((point) => [point, async () => {}]));
  return { name, ...points };
}

describe('interceptorsOf, every hook point', () => {
  it('registers one entry for each of the twenty points, under its own id', () => {
    const contributions = createAgentContributions([
      { plugin: 'x', interceptors: [interceptorAtEveryPoint('everything')] },
    ]);
    const registry = interceptorsOf({ interceptors: ['x:everything'] }, contributions);
    if (registry === undefined) throw new Error('Expected a registry.');

    expect(INTERCEPTOR_POINTS).toHaveLength(20);
    expect(
      registry
        .describePlan()
        .entries.map(({ hookName, id }) => ({ hookName, id }))
        .toSorted((a, b) => a.hookName.localeCompare(b.hookName)),
    ).toEqual(
      INTERCEPTOR_POINTS.toSorted().map((point) => ({
        hookName: point,
        id: `x:everything:${point}`,
      })),
    );
  });

  it('registers only the points an interceptor defines', () => {
    const contributions = createAgentContributions([
      { plugin: 'x', interceptors: [{ name: 'quiet', onRunError: async () => {} }] },
    ]);
    const registry = interceptorsOf({ interceptors: ['x:quiet'] }, contributions);
    expect(registry?.getHookNames()).toEqual(['onRunError']);
  });
});

/** The plan entries of the registry one interceptor registers, by hook name. */
function planOf(interceptor: PluginInterceptor) {
  const contributions = createAgentContributions([{ plugin: 'x', interceptors: [interceptor] }]);
  const registry = interceptorsOf({ interceptors: [`x:${interceptor.name}`] }, contributions);
  if (registry === undefined) throw new Error('Expected a registry.');
  return Object.fromEntries(
    registry.describePlan().entries.map((entry) => [entry.hookName, entry]),
  );
}

describe('a hook declared as { handler, replay, onError, priority }', () => {
  it('shows replay: safe in the plan, and effectful for a hook that declares none', () => {
    const plan = planOf({
      name: 'probe',
      onStep: { handler: async () => {}, replay: 'safe' },
      onRunStart: { handler: async () => {}, replay: 'effectful' },
      onRunComplete: async () => {},
      afterCompaction: { handler: async () => {} },
    });
    expect(plan['onStep']?.replay).toBe('safe');
    expect(plan['onRunStart']?.replay).toBe('effectful');
    expect(plan['onRunComplete']?.replay).toBe('effectful');
    expect(plan['afterCompaction']?.replay).toBe('effectful');
  });

  it('keeps the priority it names above the floor, and sorts the function form at 0', () => {
    const plan = planOf({
      name: 'probe',
      onStep: { handler: async () => {}, priority: 50 },
      onRunComplete: async () => {},
    });
    expect(plan['onStep']?.priority).toBe(50);
    expect(plan['onRunComplete']?.priority).toBe(0);
  });

  it.each([
    ['below the floor', Number.MIN_SAFE_INTEGER],
    ['at the guardrails’ own priority', AGENT_POLICY_PINNED_LAST_PRIORITY],
    ['the lowest finite number', -Number.MAX_VALUE],
  ])('raises a priority %s to the floor', (_name, priority) => {
    const plan = planOf({ name: 'probe', onStep: { handler: async () => {}, priority } });
    expect(plan['onStep']?.priority).toBe(INTERCEPTOR_PRIORITY_FLOOR);
    expect(INTERCEPTOR_PRIORITY_FLOOR).toBe(AGENT_POLICY_PINNED_LAST_PRIORITY + 1);
  });

  it('survives the agent tier’s merge in front of the guardrails the agent registers after it', () => {
    const contributions = createAgentContributions([
      {
        plugin: 'x',
        interceptors: [
          {
            name: 'probe',
            prepareStep: { handler: async () => {}, priority: Number.MIN_SAFE_INTEGER },
          },
        ],
      },
    ]);
    const registry = interceptorsOf({ interceptors: ['x:probe'] }, contributions);
    // The same order `createAgent` takes: the agent tier is merged, then the guardrails register.
    const merged = mergeHookRegistries<OperativeHookMap>(undefined, registry, undefined);
    merged.on('prepareStep', async () => {}, {
      id: 'agent:guardrails-prepare-step',
      priority: AGENT_POLICY_PINNED_LAST_PRIORITY,
    });
    expect(merged.describePlan().entries.map((entry) => entry.id)).toEqual([
      'x:probe:prepareStep',
      'agent:guardrails-prepare-step',
    ]);
  });

  it('hands the registry its own onError, so the merge keeps it', () => {
    const onError = () => 'continue' as const;
    const contributions = createAgentContributions([
      {
        plugin: 'x',
        interceptors: [{ name: 'probe', onStep: { handler: async () => {}, onError } }],
      },
    ]);
    const registry = interceptorsOf({ interceptors: ['x:probe'] }, contributions);
    const merged = mergeHookRegistries<OperativeHookMap>(new HookRegistry(), registry);
    expect(merged.getHandlers('onStep')[0]?.options.onError).toBe(onError);
  });

  it.each([
    ['a handler that is not a function', { handler: 'nope' }, 'must be a function or an object'],
    ['a hook that is neither', 7, 'must be a function or an object'],
    ['a replay of its own invention', { handler: async () => {}, replay: 'maybe' }, '`replay`'],
    [
      'an onError that is not a function',
      { handler: async () => {}, onError: 'continue' },
      '`onError`',
    ],
    ['a priority of NaN', { handler: async () => {}, priority: Number.NaN }, '`priority`'],
    ['an infinite priority', { handler: async () => {}, priority: -Infinity }, '`priority`'],
  ])('refuses %s when the plugin’s contributions are collected', (_name, onStep, message) => {
    expect(() =>
      createAgentContributions([
        { plugin: 'x', interceptors: [{ name: 'probe', onStep } as unknown as PluginInterceptor] },
      ]),
    ).toThrow(message);
  });
});

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

/** Starts a Bureau whose `helper` agent lists `x:probe`, over the interceptor `probe` provides. */
async function startAgent(
  probe: PluginInterceptor,
  options: {
    readonly durable: boolean;
    readonly tools?: boolean;
    readonly script: Script;
  },
): Promise<FileBureauHarness> {
  const harness = await startFileBureau({
    scripts: { 'claude-opus-5-5': options.script },
    overrides: {
      durable: options.durable,
      agentContributions: createAgentContributions([{ plugin: 'x', interceptors: [probe] }]),
    },
  });
  harnesses.push(harness);
  await harness.put(
    'helper.md',
    agentFileText({
      model: KNOWN_MODEL,
      interceptors: '[x:probe]',
      ...(options.tools === true ? { tools: '[lookup-order]' } : {}),
    }),
  );
  await harness.bureau.agents.refresh();
  return harness;
}

describe.each([false, true])(
  'a file agent that lists a plugin interceptor, durable %p',
  (durable) => {
    it('fires the plugin’s onRunError once when the agent’s run fails', async () => {
      const failures: unknown[] = [];
      const harness = await startAgent(
        {
          name: 'probe',
          onRunError: async (context) => {
            failures.push(context.error);
          },
        },
        {
          durable,
          script: () => {
            throw new Error('The model is down.');
          },
        },
      );

      const task = await harness.bureau.tasks.start('helper', 'Hello');
      const result = await task.result();
      await waitForTaskState(harness.bureau, task.id);
      await waitUntil(() => failures.length > 0, { message: 'the plugin’s onRunError to fire' });

      expect(result.finishReason).toBe('error');
      expect(failures).toHaveLength(1);
      expect(String(failures[0])).toContain('The model is down.');
    });

    it('uses the replacement the plugin’s validateToolResult returns', async () => {
      const settled: unknown[] = [];
      let generations = 0;
      const harness = await startAgent(
        {
          name: 'probe',
          validateToolResult: async (result) => ({ ...result, result: 'REPLACED' }),
          onStep: async (step) => {
            settled.push(...step.results.map((entry) => entry.result));
          },
        },
        {
          durable,
          tools: true,
          script: () => {
            generations += 1;
            return generations === 1
              ? { content: '', toolCalls: [{ name: 'lookup-order', arguments: {} }] }
              : { content: 'Done.' };
          },
        },
      );

      const task = await harness.bureau.tasks.start('helper', 'Look it up.');
      const result = await task.result();
      await waitForTaskState(harness.bureau, task.id);

      expect(result.content).toBe('Done.');
      expect(settled).toEqual(['REPLACED']);
    });
  },
);

describe.each([false, true])(
  'a hook of a file agent’s interceptor that throws or sorts last, durable %p',
  (durable) => {
    const boom = async () => {
      throw new Error('The hook broke.');
    };

    /** How a run ends when `onStep` is the interceptor's only hook. */
    async function finishReasonWith(
      onStep: NonNullable<PluginInterceptor['onStep']>,
    ): Promise<string> {
      const harness = await startAgent(
        { name: 'probe', onStep },
        { durable, script: () => 'Hi there.' },
      );
      const task = await harness.bureau.tasks.start('helper', 'Hello');
      const result = await task.result();
      await waitForTaskState(harness.bureau, task.id);
      return result.finishReason;
    }

    it('does not fail the step when the hook says onError: continue', async () => {
      expect(await finishReasonWith({ handler: boom, onError: () => 'continue' })).toBe(
        'stop-condition',
      );
    });

    it('fails the step when the hook says onError: abort', async () => {
      expect(await finishReasonWith({ handler: boom, onError: () => 'abort' })).toBe('error');
    });

    it('fails the step, as on main, for a bare function or an object with no onError', async () => {
      expect(await finishReasonWith(boom)).toBe('error');
      expect(await finishReasonWith({ handler: boom, replay: 'safe' })).toBe('error');
    });

    it('runs a hook that asks to sort last in front of the agent’s output guardrail', async () => {
      const email = 'jane.doe@example.com';
      // The default output guardrail sits at the pinned-last priority, so only a hook that still
      // runs before it can have its leak caught. A priority below the floor, unclamped, sorts after.
      const harness = await startAgent(
        {
          name: 'probe',
          validateResponse: {
            handler: async (response) => ({ ...response, content: `Reach her at ${email}.` }),
            priority: Number.MIN_SAFE_INTEGER,
          },
        },
        { durable, script: () => 'Hi there.' },
      );
      const task = await harness.bureau.tasks.start('helper', 'Hello');
      const result = await task.result();
      await waitForTaskState(harness.bureau, task.id);
      expect(result.finishReason).toBe('tripwire');
    });
  },
);
