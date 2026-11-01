/**
 * COR-1996 — a `NonRecoverablePolicyError` thrown by `generate` is a policy verdict: a run hook's
 * `onError` cannot `skip` or `retry` it away, and the built-in `retry` option never repeats it. The
 * run ends with the error itself, not with `MAXIMUM_STEPS` or a string of refused steps, and the
 * provider is not asked again.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import { NonRecoverablePolicyError } from './errors';
import type { OperativeHookMap } from './hooks';
import { isNonRetryableGenerateError } from './run-step-utilities';
import type { RunOptions } from './types';

class ForbiddenModelError extends NonRecoverablePolicyError {
  constructor() {
    super('The model "test/forbidden" is forbidden by the deployment model policy.');
    this.name = 'ForbiddenModelError';
  }
}

function runRefused(
  options: Partial<RunOptions> & { readonly action?: 'skip' | 'retry' } = {},
): Promise<{ result: Awaited<ReturnType<typeof createActiveRun>['result']>; calls: () => number }> {
  let calls = 0;
  const { action, ...rest } = options;
  const hooks = new HookRegistry<OperativeHookMap>();
  if (action !== undefined) hooks.on('onError', async () => action);
  const run = createActiveRun({
    generate: async () => {
      calls++;
      throw new ForbiddenModelError();
    },
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    maxSteps: 5,
    hooks,
    ...rest,
  });
  return run.result.then((result) => ({ result, calls: () => calls }));
}

describe('a policy denial from generate', () => {
  it('ends the run with the error when an onError hook returns skip', async () => {
    const { result, calls } = await runRefused({ action: 'skip' });

    expect(result.finishReason).not.toBe('max-steps');
    expect(result.error).toBeDefined();
    expect(result.error?.kind).toBe('policy');
    expect(result.error?.cause).toBeInstanceOf(ForbiddenModelError);
    expect(result.error?.message).toContain('test/forbidden');
    expect(calls()).toBe(1);
  });

  it('ends the run with the error when an onError hook returns retry', async () => {
    const { result, calls } = await runRefused({ action: 'retry' });

    expect(result.error?.kind).toBe('policy');
    expect(result.error?.cause).toBeInstanceOf(ForbiddenModelError);
    expect(calls()).toBe(1);
  });

  it('is not repeated by the built-in retry option', async () => {
    const { result, calls } = await runRefused({
      retry: { attempts: 3, delay: 0, shouldRetry: () => true },
    });

    expect(result.error?.kind).toBe('policy');
    expect(calls()).toBe(1);
  });

  it('is named by isNonRetryableGenerateError', () => {
    expect(isNonRetryableGenerateError(new ForbiddenModelError())).toBe(true);
    expect(isNonRetryableGenerateError(new Error('transient'))).toBe(false);
  });
});
