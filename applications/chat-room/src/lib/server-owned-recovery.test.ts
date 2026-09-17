import { describe, expect, it } from 'bun:test';
import type { AgentRun } from './server-owned-recovery-test-helpers';
import {
  classifyRecovery,
  createAgent,
  describeRecoveryError,
  disposeRecoveredRunWhenSettled,
  expectRejectsWith,
  handleThatRecovers,
  spyOn,
} from './server-owned-recovery-test-helpers';

function createRecoveredFixtureRun(result: Promise<void>): AgentRun {
  const run = createAgent({
    generate: async () => ({ content: 'fixture', toolCalls: [] }),
  }).run('fixture');
  Object.defineProperty(run, 'result', { value: () => result });
  return run;
}

describe('classifyRecovery', () => {
  it('reports a live re-attach as recovered', async () => {
    const run = createAgent({
      generate: async () => ({ content: 'recovered', toolCalls: [] }),
    }).run('fixture');
    const outcome = await classifyRecovery(handleThatRecovers({ returns: run }));

    expect(outcome.kind).toBe('recovered');
    if (outcome.kind !== 'recovered') return;
    expect(outcome.run).toBe(run);
  });

  it('distinguishes "nothing to resume" from "attempted and failed"', async () => {
    // Both return `null` from `recover()`. The ONLY thing separating a healthy
    // idle session from a run whose work is gone is the emitter's `failures`
    // array — which is the entire reason this module exists rather than
    // callers reading the return value.
    const benign = await classifyRecovery(handleThatRecovers({ returns: null }));
    expect(benign.kind).toBe('nothing-to-resume');

    const failed = await classifyRecovery(
      handleThatRecovers({
        returns: null,
        failures: [{ runId: 'session:3', error: new Error('no workflow services available') }],
      }),
    );
    expect(failed.kind).toBe('orphaned');
    if (failed.kind !== 'orphaned') return;
    expect(failed.failures).toEqual([
      { runId: 'session:3', reason: 'no workflow services available' },
    ]);
  });

  it('carries no live error object into the outcome', async () => {
    // The credential boundary again: whatever the engine threw stays
    // server-side, and the outcome carries a sentence. A string by
    // construction means a route cannot forward the cause by accident.
    const failed = await classifyRecovery(
      handleThatRecovers({
        returns: null,
        failures: [{ runId: 'r', error: new Error('postgres://user:hunter2@host/db unreachable') }],
      }),
    );

    expect(failed.kind).toBe('orphaned');
    if (failed.kind !== 'orphaned') return;

    // ENUMERATED, not serialized. `JSON.stringify(new Error(...))` produces
    // `{}` — an `Error` has no enumerable own properties — so a classifier
    // that kept the live error in an extra field would pass a
    // `not.toContain('stack')` assertion while carrying the whole cause. That
    // is what the first version of this test did.
    //
    // Checking the KEYS is what makes the claim falsifiable: the shape is
    // exactly the two fields, and anything smuggled alongside them fails
    // here.
    const [failure] = failed.failures;
    expect(Object.keys(failure ?? {}).toSorted()).toEqual(['reason', 'runId']);
    for (const value of Object.values(failure ?? {})) {
      expect(typeof value).toBe('string');
    }
    expect(failure?.reason).toContain('unreachable');
  });

  it('removes its listener even when recover() throws', async () => {
    // The handle outlives this call. A listener left attached to a
    // long-lived emitter accumulates one per attempt, and each one closes
    // over a dead classification.
    const handle = handleThatRecovers({ returns: null, throws: new Error('engine exploded') });

    await expectRejectsWith(classifyRecovery(handle), (error) => {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).toContain('engine exploded');
    });
    expect(handle.listenerCount()).toBe(0);
  });
});

describe('disposeRecoveredRunWhenSettled', () => {
  it.each(['resolved', 'rejected'] as const)(
    'contains disposal failures after a %s result',
    async (outcome) => {
      const warning = spyOn(process.stderr, 'write').mockImplementation(() => true);
      let disposeCalls = 0;
      const result =
        outcome === 'resolved' ? Promise.resolve() : Promise.reject(new Error('run failed'));
      const run = createRecoveredFixtureRun(result);
      Object.defineProperty(run, Symbol.dispose, {
        value: () => {
          disposeCalls += 1;
          throw new Error('secret disposal details');
        },
      });
      try {
        disposeRecoveredRunWhenSettled(run);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(disposeCalls).toBe(1);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          '[server-owned] recovered run cleanup failed; details withheld\n',
        );
      } finally {
        warning.mockRestore();
      }
    },
  );

  it('disposes an actual settled AgentRun without changing its terminal result', async () => {
    let releaseGeneration!: () => void;
    const generationHeld = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const agent = createAgent({
      generate: async () => {
        await generationHeld;
        return { content: 'recovered', toolCalls: [] };
      },
      instructions: 'Return the supplied fixture response.',
    });
    const run = agent.run('fixture');
    let disposeCalls = 0;
    const originalDispose = run[Symbol.dispose].bind(run);
    Object.defineProperty(run, Symbol.dispose, {
      value: () => {
        disposeCalls += 1;
        originalDispose();
      },
    });

    disposeRecoveredRunWhenSettled(run);
    await Promise.resolve();
    expect(disposeCalls).toBe(0);
    releaseGeneration();
    const result = await run.result();
    expect(run.snapshot().status).toBe('terminal');
    expect(await run.result()).toBe(result);
    expect(result.finishReason).toBe('stop-condition');
    expect(disposeCalls).toBe(1);
  });

  it('keeps the recovered execution alive until settlement, then disposes the wrapper', async () => {
    let resolveResult!: () => void;
    let disposeCalls = 0;
    let abortCalls = 0;
    const result = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });
    const run = createRecoveredFixtureRun(result);
    Object.defineProperty(run, 'abort', {
      value: () => {
        abortCalls += 1;
      },
    });
    Object.defineProperty(run, Symbol.dispose, {
      value: () => {
        disposeCalls += 1;
      },
    });

    disposeRecoveredRunWhenSettled(run);
    await Promise.resolve();
    expect(disposeCalls).toBe(0);
    expect(abortCalls).toBe(0);

    resolveResult();
    await result;
    await Promise.resolve();
    expect(disposeCalls).toBe(1);
    expect(abortCalls).toBe(0);
  });

  it('also releases the wrapper when the recovered run rejects', async () => {
    let rejectResult!: (reason: Error) => void;
    let disposeCalls = 0;
    const result = new Promise<void>((_resolve, reject) => {
      rejectResult = reject;
    });
    const run = createRecoveredFixtureRun(result);
    Object.defineProperty(run, Symbol.dispose, {
      value: () => {
        disposeCalls += 1;
      },
    });

    disposeRecoveredRunWhenSettled(run);
    rejectResult(new Error('recovered run failed'));
    await expectRejectsWith(result, (error) => {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) expect(error.message).toContain('recovered run failed');
    });
    await Promise.resolve();
    expect(disposeCalls).toBe(1);
  });
});

describe('describeRecoveryError', () => {
  it('renders a value that refuses to describe itself', () => {
    // Runs while classifying a failure, so it must not turn one failure into
    // two — the same hazard `describeCause` has in the runtime module.
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    };

    expect(describeRecoveryError(hostile)).toBe('a object that could not be described');
    expect(describeRecoveryError(new TypeError('bad'))).toBe('TypeError: bad');
    expect(describeRecoveryError(new Error('plain'))).toBe('plain');
    expect(describeRecoveryError('already a string')).toBe('already a string');
  });
});
