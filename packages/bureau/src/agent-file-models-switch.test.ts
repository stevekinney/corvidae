/**
 * COR-1559 — a session of a file agent can be switched to a model the file allows. Its frontmatter
 * `model` is the default; an optional `models` list narrows the choice, and the deployment's
 * catalog applies without one. A switch is decided when it is admitted, reaches the provider call
 * through a per-step wrapper that reads only the step's steering, and never falls back to the
 * default when the model it names can no longer be used.
 */
import type { BackendDescriptor, GenerateFunction } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForTaskState } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import type { BureauDiagnostic } from './types';
import { startTaskFrom } from './test/task-start-request.ts';

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const OPUS_5 = { provider: 'anthropic', model: 'claude-opus-5' } as const;
const GPT_4_1 = { provider: 'openai', model: 'gpt-4.1' } as const;

/**
 * A resolver whose generates take two steps (a tool call, then an answer) and record the model of
 * the descriptor each was resolved for, holding the first step until released.
 */
function recordingResolver(options: { readonly cannotSetUp?: string } = {}) {
  const calls: string[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const generate = (descriptor: BackendDescriptor): GenerateFunction => {
    if (descriptor.model === options.cannotSetUp) {
      throw new Error(`no credentials for ${descriptor.model}`);
    }
    return async (context) => {
      const first = calls.length === 0;
      calls.push(descriptor.model);
      if (first) {
        entered.resolve();
        await release.promise;
      }
      const history = context.conversation.current;
      const last = history.messages[history.ids.at(-1) ?? ''];
      if (last?.toolResult !== undefined) return { content: 'done', toolCalls: [] };
      return {
        content: '',
        toolCalls: [{ id: `call-${calls.length}`, name: 'lookup-order', arguments: {} }],
      };
    };
  };
  return {
    calls,
    generate,
    entered: entered.promise,
    release: () => release.resolve(),
  };
}

async function start(
  resolver: ReturnType<typeof recordingResolver>,
  file: string,
  diagnostics: BureauDiagnostic[] = [],
) {
  const harness = await startFileBureau({
    overrides: {
      models: { generate: resolver.generate },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  });
  harnesses.push(harness);
  await harness.put('picker.md', file);
  await harness.bureau.agents.refresh();
  return harness;
}

const PICKER = (models?: string) =>
  agentFileText({
    model: KNOWN_MODEL,
    tools: '[lookup-order]',
    ...(models === undefined ? {} : { models }),
  });

async function runPicker(harness: FileBureauHarness, sessionId?: string) {
  return startTaskFrom(harness.bureau, {
    input: 'go',
    agentName: 'picker',
    principal: 'alice',
    ...(sessionId === undefined ? {} : { contextId: sessionId }),
  });
}

const steer = (
  harness: FileBureauHarness,
  sessionId: string,
  id: string,
  choice: { provider: string; model: string },
) =>
  harness.bureau.contexts.steer(sessionId, {
    id,
    principal: 'alice',
    requestedValue: { target: 'model', override: choice.model, provider: choice.provider } as never,
  });

describe('a file agent with no models list', () => {
  it('allows any catalog model and uses it from the live run’s next step', async () => {
    const resolver = recordingResolver();
    const harness = await start(resolver, PICKER());
    const run = await runPicker(harness);
    await resolver.entered;

    const outcome = await steer(harness, run.contextId, 'switch', GPT_4_1);
    resolver.release();
    await waitForTaskState(harness.bureau, run.id);

    expect(outcome.outcome).toBe('accepted');
    expect(resolver.calls).toEqual(['claude-opus-5-5', 'gpt-4.1']);
  });

  it('uses the model for the session’s later runs too', async () => {
    const resolver = recordingResolver();
    resolver.release();
    const harness = await start(resolver, PICKER());
    const first = await runPicker(harness);
    await waitForTaskState(harness.bureau, first.id);

    const outcome = await steer(harness, first.contextId, 'idle', OPUS_5);
    const second = await runPicker(harness, first.contextId);
    await waitForTaskState(harness.bureau, second.id);

    expect(outcome.outcome).toBe('accepted');
    expect(resolver.calls).toEqual([
      'claude-opus-5-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-5',
    ]);
  });

  it('keeps using the default for a session that was never switched', async () => {
    const resolver = recordingResolver();
    resolver.release();
    const harness = await start(resolver, PICKER());
    const run = await runPicker(harness);
    await waitForTaskState(harness.bureau, run.id);

    expect(resolver.calls).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
  });
});

describe('a file agent with a models list', () => {
  it('rejects a catalog model outside the list with model-not-allowed', async () => {
    const resolver = recordingResolver();
    resolver.release();
    const harness = await start(resolver, PICKER(`[${KNOWN_MODEL}, openai/gpt-4.1]`));
    const run = await runPicker(harness);
    await waitForTaskState(harness.bureau, run.id);

    const outside = await steer(harness, run.contextId, 'outside', OPUS_5);
    const inside = await steer(harness, run.contextId, 'inside', GPT_4_1);

    expect(outside).toEqual({
      outcome: 'rejected',
      failure: { failedAt: expect.any(String), reason: 'model-not-allowed' },
    });
    expect(inside.outcome).toBe('accepted');
  });

  it('rejects a listed model the host cannot set up as model-not-allowed, and changes nothing', async () => {
    const resolver = recordingResolver({ cannotSetUp: 'gpt-4.1' });
    resolver.release();
    const harness = await start(resolver, PICKER(`[${KNOWN_MODEL}, openai/gpt-4.1]`));
    const run = await runPicker(harness);
    await waitForTaskState(harness.bureau, run.id);

    const outcome = await steer(harness, run.contextId, 'unusable', GPT_4_1);

    expect(outcome.outcome === 'rejected' && outcome.failure.reason).toBe('model-not-allowed');
    const steering = await harness.bureau.contexts.steering(run.contextId);
    expect(steering?.model).toBeNull();
  });
});

describe('an override that can no longer be used', () => {
  it('fails the step with an error naming the model, never falling back to the default', async () => {
    const diagnostics: BureauDiagnostic[] = [];
    const resolver = recordingResolver();
    resolver.release();
    const harness = await start(resolver, PICKER(`[${KNOWN_MODEL}, openai/gpt-4.1]`), diagnostics);
    const first = await runPicker(harness);
    await waitForTaskState(harness.bureau, first.id);
    const switched = await steer(harness, first.contextId, 'switch', GPT_4_1);
    expect(switched.outcome).toBe('accepted');
    const callsBefore = resolver.calls.length;

    // A person edits the file by hand, and the model it listed is no longer in it.
    await harness.put('picker.md', PICKER(`[${KNOWN_MODEL}]`));
    await harness.bureau.agents.refresh();
    const second = await runPicker(harness, first.contextId);
    await waitForTaskState(harness.bureau, second.id);

    const summary = harness.bureau.tasks.detail(second.id);
    expect(summary?.status).toBe('error');
    expect(summary?.error).toContain('gpt-4.1');
    // No provider call was made for it, with the override or with the default.
    expect(resolver.calls).toHaveLength(callsBefore);
    // The session still reports the override it was switched to.
    expect(await harness.bureau.contexts.steering(first.contextId)).toMatchObject({
      model: { provider: 'openai', model: 'gpt-4.1' },
    });
  });
});
