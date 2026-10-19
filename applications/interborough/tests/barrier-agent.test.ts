import { describe, expect, test } from 'bun:test';

import {
  BARRIER_AGENT_NAME,
  BARRIER_FIRST_REPLY,
  BARRIER_FOLLOW_UP_REPLY,
  BARRIER_SHORT_AGENT_NAME,
  createBarrier,
  createBarrierAgents,
} from './e2e/barrier-agent.ts';

const context = (step: number, signal?: AbortSignal) =>
  ({ step, ...(signal === undefined ? {} : { signal }) }) as never;

describe('the barrier', () => {
  test('holds a first step until it is released, and counts it while it waits', async () => {
    const barrier = createBarrier();
    const first = barrier.generate(context(0));
    await Promise.resolve();

    expect(barrier.waiting()).toBe(1);
    barrier.release();

    expect(await first).toEqual({ content: BARRIER_FIRST_REPLY, toolCalls: [] });
    expect(barrier.waiting()).toBe(0);
  });

  test('answers a later step at once, without waiting', async () => {
    const barrier = createBarrier();

    expect(await barrier.generate(context(1))).toEqual({
      content: BARRIER_FOLLOW_UP_REPLY,
      toolCalls: [],
    });
    expect(barrier.waiting()).toBe(0);
  });

  test('releases every waiting step, and a step that arrives after waits for the next release', async () => {
    const barrier = createBarrier();
    const one = barrier.generate(context(0));
    const two = barrier.generate(context(0));
    await Promise.resolve();
    barrier.release();
    await Promise.all([one, two]);

    const late = barrier.generate(context(0));
    await Promise.resolve();

    expect(barrier.waiting()).toBe(1);
    barrier.release();
    await late;
  });

  test('stops waiting when its run is aborted', async () => {
    const barrier = createBarrier();
    const controller = new AbortController();
    const step = barrier.generate(context(0, controller.signal));
    await Promise.resolve();

    controller.abort();

    const failure = await step.then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(String(failure)).toContain('aborted');
    expect(barrier.waiting()).toBe(0);
  });
});

describe('the barrier agents', () => {
  test('are two agents over one barrier, one of which has a single step', () => {
    const agents = createBarrierAgents(createBarrier());

    expect(Object.keys(agents)).toEqual([BARRIER_AGENT_NAME, BARRIER_SHORT_AGENT_NAME]);
    expect(agents[BARRIER_AGENT_NAME]?.name).toBe(BARRIER_AGENT_NAME);
    expect(agents[BARRIER_SHORT_AGENT_NAME]?.name).toBe(BARRIER_SHORT_AGENT_NAME);
  });
});
