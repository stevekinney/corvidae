/**
 * COR-1302 — every `AgentRun` carries a stable run identity.
 *
 * `AgentRun.id` is the id its run's liveness snapshot reports, fixed for the
 * handle's whole life. These tests cover the in-memory producers; the durable
 * producers and recovery live in `durable/agent-run-id-recovery.test.ts`, and
 * the Bureau surfaces that accept the id in `bureau`'s
 * `bureau-run-identity.test.ts`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createAgentRun } from './agent-run';
import { stopWhen } from './conditions/index';
import { createAgent } from './create-agent';
import { createLazyAgent } from './create-lazy-agent';
import { createActiveRun } from './create-run';
import type { RunnableAgent } from './runnable-agent';
import type { RunOptions } from './types';

function textGenerate(content = 'done'): RunOptions['generate'] {
  return async () => ({ content, toolCalls: [] });
}

function runOptions(overrides: Pick<RunOptions, 'runId' | 'runtime'> = {}): RunOptions {
  return {
    generate: textGenerate(),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
    ...overrides,
  };
}

/** A generate that never answers until the run is aborted. */
function hangingGenerate(): RunOptions['generate'] {
  return ({ signal }) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

describe('ActiveRun.runId (COR-1302)', () => {
  it('is the caller-supplied RunOptions.runId, and equals snapshot().id', async () => {
    const activeRun = createActiveRun(runOptions({ runId: 'caller-run-id' }));
    expect(activeRun.runId).toBe('caller-run-id');
    expect(activeRun.snapshot().id).toBe('caller-run-id');
    await activeRun.result;
    expect(activeRun.snapshot().id).toBe(activeRun.runId);
  });

  it('is the id minted through the runtime identifier seam when no runId is supplied', async () => {
    const runtime = createManualRuntimeServices({ identifierSeed: 'cor-1302-minted' });
    const expected = createManualRuntimeServices({ identifierSeed: 'cor-1302-minted' });
    const activeRun = createActiveRun(runOptions({ runtime }));
    expect(activeRun.runId).toBe(expected.identifiers.next('run'));
    expect(activeRun.snapshot().id).toBe(activeRun.runId);
    await activeRun.result;
  });

  it('prefers an injected RunIdentifierSeam over the runtime seam, and still equals snapshot().id', async () => {
    const activeRun = createActiveRun(runOptions(), undefined, {
      identifiers: { next: () => 'seam-run-id' },
    });
    expect(activeRun.runId).toBe('seam-run-id');
    expect(activeRun.snapshot().id).toBe('seam-run-id');
    await activeRun.result;
  });
});

describe('AgentRun.id (COR-1302)', () => {
  it('createAgentRun stamps the handle with the wrapped run’s runId', async () => {
    const activeRun = createActiveRun(runOptions({ runId: 'wrapped-run' }));
    const run = createAgentRun(activeRun);
    expect(run.id).toBe('wrapped-run');
    expect(run.id).toBe(activeRun.runId);
    expect(run.id).toBe(run.snapshot().id);
    await run.result();
    expect(run.id).toBe(run.snapshot().id);
  });

  it('does not change across the run’s life', async () => {
    const run = createAgent({ generate: textGenerate() }).run('hi');
    const before = run.id;
    await run.result();
    expect(run.id).toBe(before);
  });

  it('createAgent().run() reports the same id as its snapshot, before and after settlement', async () => {
    const run = createAgent({ generate: textGenerate() }).run('hi');
    expect(run.id).toBe(run.snapshot().id);
    await run.result();
    expect(run.id).toBe(run.snapshot().id);
  });

  it('createAgent().run() uses AgentRunContext.runId as the run’s id when one is supplied', async () => {
    const run = createAgent({ generate: textGenerate() }).run('hi', { runId: 'context-run-id' });
    expect(run.id).toBe('context-run-id');
    expect(run.snapshot().id).toBe('context-run-id');
    await run.result();
    expect(run.snapshot().id).toBe('context-run-id');
  });

  it('a lazy agent’s handle has its final id before the module loads, and the loaded run keeps it', async () => {
    let releaseLoad: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const runtime = createManualRuntimeServices({ identifierSeed: 'cor-1302-lazy' });
    const agent = createLazyAgent(
      async () => {
        await loaded;
        return { default: createAgent({ name: 'lazy', generate: textGenerate() }) };
      },
      { label: 'lazy', runtime },
    );

    const run = agent.run('hi');
    const idBeforeLoad = run.id;
    expect(run.snapshot().id).toBe(idBeforeLoad);
    expect(idBeforeLoad).not.toBe('lazy');

    releaseLoad?.();
    await run.result();
    expect(run.id).toBe(idBeforeLoad);
    expect(run.snapshot().id).toBe(idBeforeLoad);
  });

  it('a lazy agent honors a caller-supplied AgentRunContext.runId', async () => {
    const agent = createLazyAgent(
      async () => ({ default: createAgent({ name: 'lazy', generate: textGenerate() }) }),
      { label: 'lazy' },
    );
    const run = agent.run('hi', { runId: 'lazy-context-run-id' });
    expect(run.id).toBe('lazy-context-run-id');
    expect(run.snapshot().id).toBe('lazy-context-run-id');
    await run.result();
    expect(run.snapshot().id).toBe('lazy-context-run-id');
  });

  it('a lazy agent’s handle keeps its id when a hand-written loaded agent ignores AgentRunContext.runId', async () => {
    // The documented exception to `id === snapshot().id`: a hand-written
    // `RunnableAgent` that drops the context's `runId` runs under its own id,
    // and the wrapping handle cannot rename that run. Its `id` stays the one
    // it handed out; only `snapshot()`, which reads the run itself once it
    // exists, reports the agent's own id.
    const inner = createAgent({ name: 'inner', generate: textGenerate() });
    const ignoresRunId: RunnableAgent = {
      name: 'ignores-run-id',
      hasOutput: false,
      run: (input) => inner.run(input, { runId: 'agent-chosen-run-id' }),
    };
    const agent = createLazyAgent(async () => ({ default: ignoresRunId }), { label: 'lazy' });

    const run = agent.run('hi', { runId: 'handed-out-run-id' });
    expect(run.id).toBe('handed-out-run-id');
    expect(run.snapshot().id).toBe('handed-out-run-id');
    await run.result();
    expect(run.id).toBe('handed-out-run-id');
    expect(run.snapshot().id).toBe('agent-chosen-run-id');
  });

  it('gives two concurrent runs of one agent distinct ids, and the same two ids on a replay with the same identifier seed', async () => {
    async function scenario(): Promise<[string, string]> {
      const runtime = createManualRuntimeServices({ identifierSeed: 'cor-1302-concurrency' });
      const agent = createAgent({ generate: hangingGenerate(), runtime });
      const first = agent.run('first');
      const second = agent.run('second');
      const ids: [string, string] = [first.id, second.id];
      expect(first.id).toBe(first.snapshot().id);
      expect(second.id).toBe(second.snapshot().id);
      first.abort('scenario finished');
      second.abort('scenario finished');
      await Promise.all([first.result(), second.result()]);
      return ids;
    }

    const firstReplay = await scenario();
    expect(firstReplay[0]).not.toBe(firstReplay[1]);
    const secondReplay = await scenario();
    expect(secondReplay).toEqual(firstReplay);
  });
});
