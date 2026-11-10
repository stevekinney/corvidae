/**
 * COR-2106 — the run-scoped `executionContext` a run gives its tool calls is built in one place, so
 * a host that resumes a parked call (Bureau, after an approval) gives it what an uninterrupted call
 * would have had.
 */
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import {
  type BureauChildInvariants,
  bureauInvariantsField,
  readBureauInvariants,
} from './bureau-invariants';
import { createChildRunRegistry } from './child-run';
import type { ChildSignalPort } from './child-signals';
import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import {
  runScopedExecutionContext,
  runScopedExecutionContextOf,
} from './run-scoped-execution-context';
import type { RunOptions } from './types';

const invariants: BureauChildInvariants = () => {
  throw new Error('not called by this test');
};

/** A run that calls a probe tool once, and what the probe saw of its execution context. */
async function runProbe(options: Partial<RunOptions>): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> | undefined;
  const probe = createTool({
    name: 'probe',
    description: 'Records its execution context',
    input: z.object({}),
    async execute(_input, context) {
      seen = context.executionContext;
      return 'ok';
    },
  });
  let step = 0;
  const run = createActiveRun({
    generate: async () =>
      step++ === 0
        ? { content: '', toolCalls: [{ id: 'call-1', name: 'probe', arguments: {} }] }
        : { content: 'done', toolCalls: [] },
    toolbox: createToolbox([probe]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    ...options,
  } as RunOptions);
  await run.result;
  if (seen === undefined) throw new Error('the probe tool did not run');
  return seen;
}

describe('runScopedExecutionContextOf (COR-2106)', () => {
  const childRegistry = createChildRunRegistry();
  const delegatedAuthority = { policyVersion: 'policy-1' } as unknown as NonNullable<
    RunOptions['delegatedAuthority']
  >;
  const parentSignals = { name: 'parent-port' } as unknown as ChildSignalPort;
  const delegatedToolCapabilities = ['probe'] as const;
  const full: Partial<RunOptions> = {
    runId: 'run-1',
    childRegistry,
    delegatedAuthority,
    delegatedToolCapabilities,
    parentSignals,
    executeOptions: { executionContext: { fromCaller: true } },
  };

  it('is what an uninterrupted call receives, field for field', async () => {
    const callSeen = await runProbe(full);

    const resumed = runScopedExecutionContextOf({ ...full } as RunOptions);

    expect(resumed).toBeDefined();
    expect(callSeen['childRegistry']).toBe(childRegistry);
    expect(resumed?.['childRegistry']).toBe(callSeen['childRegistry']);
    expect(resumed?.['delegatedAuthority']).toBe(callSeen['delegatedAuthority']);
    expect(resumed?.['parentSignals']).toBe(callSeen['parentSignals']);
    expect(resumed?.['delegatedToolCapabilities']).toBe(callSeen['delegatedToolCapabilities']);
    expect(resumed?.['parentRunId']).toBe(callSeen['parentRunId']);
    expect(resumed?.['fromCaller']).toBe(true);
    // The whole context, not a listed subset: a field the run adds later is compared too.
    expect(resumed).toEqual(callSeen);
  });

  it('carries Bureau’s invariant factory, so a resumed child is not standalone', async () => {
    const options = { ...full, ...bureauInvariantsField(invariants) } as RunOptions;

    const callSeen = await runProbe(options);
    const resumed = runScopedExecutionContextOf(options);

    expect(readBureauInvariants(callSeen)).toBe(invariants);
    expect(readBureauInvariants(resumed)).toBe(invariants);
  });

  it('is undefined for a run with nothing run-scoped, as a call then keeps the toolbox’s own context', () => {
    expect(runScopedExecutionContextOf({} as RunOptions)).toBeUndefined();
    expect(
      runScopedExecutionContext({
        executeOptions: { executionContext: { only: 'caller' } },
        runId: undefined,
        childRegistry: undefined,
        delegatedAuthority: undefined,
        delegatedToolCapabilities: undefined,
        parentSignals: undefined,
        bureauInvariants: undefined,
      }),
    ).toBeUndefined();
  });
});
