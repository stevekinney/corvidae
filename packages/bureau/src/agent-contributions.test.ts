/**
 * COR-2125 — every point of Operative's hook map is a point a plugin's interceptor can hook, and
 * a file agent that lists the interceptor runs it there. The registry `interceptorsOf` builds has
 * one entry for each point an interceptor defines, and the runs below show a plugin observing a
 * failed run (`onRunError`) and replacing a tool result (`validateToolResult`), the two points the
 * interceptor could not reach before.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { PluginInterceptor } from '@lostgradient/interborough-plugin';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  createAgentContributions,
  INTERCEPTOR_POINTS,
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
