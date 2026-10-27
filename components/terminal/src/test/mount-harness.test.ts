import { afterEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';

import HarnessProbe from './harness-probe.svelte';
import HarnessThrowingEffect from './harness-throwing-effect.svelte';
import HarnessThrowingUpdate from './harness-throwing-update.svelte';
import {
  destroyAllHarnesses,
  liveHarnessCount,
  mountHarness,
  takeUnmountFailures,
} from './mount-harness.ts';

afterEach(destroyAllHarnesses);

async function failureOf(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the work to fail');
}

function queryRequired(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

describe('mount harness', () => {
  test('renders the component into a container attached to the document', () => {
    const harness = mountHarness(HarnessProbe, { label: 'Session one' });

    expect(harness.target.isConnected).toBe(true);
    expect(document.body.contains(harness.target)).toBe(true);
    expect(queryRequired(harness.target, '[data-testid="harness-label"]').textContent).toBe(
      'Session one',
    );
    expect(harness.destroyed).toBe(false);
    expect(liveHarnessCount()).toBe(1);
  });

  test('applies reactive updates after a flush', () => {
    const harness = mountHarness(HarnessProbe, { label: 'Counter' });
    const button = queryRequired(harness.target, 'button');
    expect(button.textContent).toBe('Clicked 0 times');

    button.click();
    button.click();
    harness.flush();

    expect(button.textContent).toBe('Clicked 2 times');
  });

  test('runs effect setup once on mount and teardown once on destroy', () => {
    const calls: string[] = [];
    const harness = mountHarness(HarnessProbe, {
      label: 'Lifecycle',
      onsetup: () => calls.push('setup'),
      onteardown: () => calls.push('teardown'),
    });
    expect(calls).toEqual(['setup']);

    harness.destroy();

    expect(calls).toEqual(['setup', 'teardown']);
  });

  test('removes the rendered DOM and the container when destroyed', () => {
    const harness = mountHarness(HarnessProbe, { label: 'Gone' });
    const { target } = harness;

    harness.destroy();

    expect(harness.destroyed).toBe(true);
    expect(target.isConnected).toBe(false);
    expect(target.children).toHaveLength(0);
    expect(document.querySelector('[data-testid="harness-probe"]')).toBeNull();
    expect(liveHarnessCount()).toBe(0);
  });

  test('destroying twice runs teardown only once', () => {
    const calls: string[] = [];
    const harness = mountHarness(HarnessProbe, {
      label: 'Twice',
      onteardown: () => calls.push('teardown'),
    });

    harness.destroy();
    harness.destroy();

    expect(calls).toEqual(['teardown']);
  });

  test('keeps harnesses independent and destroys all of them on request', async () => {
    const calls: string[] = [];
    const first = mountHarness(HarnessProbe, {
      label: 'First',
      onteardown: () => calls.push('first'),
    });
    const second = mountHarness(HarnessProbe, {
      label: 'Second',
      onteardown: () => calls.push('second'),
    });
    expect(first.target).not.toBe(second.target);

    first.destroy();
    expect(second.target.isConnected).toBe(true);
    expect(calls).toEqual(['first']);

    await destroyAllHarnesses();

    expect(calls).toEqual(['first', 'second']);
    expect(liveHarnessCount()).toBe(0);
    expect(document.body.children).toHaveLength(0);
  });

  test('removes the container and rethrows when mounting throws', () => {
    const failing = (() => {
      throw new Error('mount failed');
    }) as unknown as Component<Record<string, unknown>>;

    expect(() => mountHarness(failing, {})).toThrow('mount failed');

    expect(document.body.children).toHaveLength(0);
    expect(liveHarnessCount()).toBe(0);
  });

  test('unmounts the component and removes the container when the first flush throws', () => {
    const calls: string[] = [];

    expect(() =>
      mountHarness(HarnessThrowingEffect, { onteardown: () => calls.push('teardown') }),
    ).toThrow('effect failed');

    expect(calls).toEqual(['teardown']);
    expect(document.body.children).toHaveLength(0);
    expect(liveHarnessCount()).toBe(0);
  });

  /** Run `action`, let pending promise jobs settle, and return every rejection nothing handled. */
  async function unhandledRejectionsDuring(action: () => void): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      action();
      // load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', listener);
    }
    return unhandled;
  }

  test('rethrows the mount error, not a teardown error, and leaks no rejection', async () => {
    let thrown: unknown;
    const unhandled = await unhandledRejectionsDuring(() => {
      try {
        mountHarness(HarnessThrowingEffect, { teardownThrows: true });
      } catch (error) {
        thrown = error;
      }
    });

    expect((thrown as Error).message).toStartWith('effect failed');
    expect(unhandled).toEqual([]);
    expect(document.body.children).toHaveLength(0);
  });

  test('records a teardown that rejects on destroy instead of leaking the rejection', async () => {
    takeUnmountFailures();
    const harness = mountHarness(HarnessProbe, {
      label: 'Failing teardown',
      onteardown: () => {
        throw new Error('teardown failed');
      },
    });

    const unhandled = await unhandledRejectionsDuring(() => harness.destroy());

    expect(unhandled).toEqual([]);
    expect(takeUnmountFailures()).toEqual([new Error('teardown failed')]);
    expect(takeUnmountFailures()).toEqual([]);
    expect(harness.destroyed).toBe(true);
  });

  test('fails cleanup when a component teardown rejects during destroyAllHarnesses', async () => {
    takeUnmountFailures();
    mountHarness(HarnessProbe, {
      label: 'Failing teardown',
      onteardown: () => {
        throw new Error('teardown failed');
      },
    });

    const thrown = await failureOf(destroyAllHarnesses);

    expect((thrown as Error).message).toBe('teardown failed');
    expect(takeUnmountFailures()).toEqual([]);
    expect(liveHarnessCount()).toBe(0);
  });

  test('detaches the container even when the flush during destroy throws', () => {
    const first = mountHarness(HarnessProbe, { label: 'First' });
    const second = mountHarness(HarnessThrowingUpdate, {});
    queryRequired(second.target, 'button').click();

    expect(() => first.destroy()).toThrow('update failed');

    expect(first.destroyed).toBe(true);
    expect(first.target.isConnected).toBe(false);
    expect(liveHarnessCount()).toBe(1);
    expect(() => second.destroy()).not.toThrow();
  });

  test('destroys every harness and rethrows the only error when one destroy fails', async () => {
    const first = mountHarness(HarnessProbe, { label: 'First' });
    const failing = mountHarness(HarnessThrowingUpdate, {});
    const last = mountHarness(HarnessProbe, { label: 'Last' });
    queryRequired(failing.target, 'button').click();

    expect(((await failureOf(destroyAllHarnesses)) as Error).message).toStartWith('update failed');

    expect([first, failing, last].map((harness) => harness.destroyed)).toEqual([true, true, true]);
    expect(document.body.children).toHaveLength(0);
    expect(liveHarnessCount()).toBe(0);
  });

  test('collects the errors in an AggregateError when several destroys fail', async () => {
    const triggers: HarnessProbeTarget[] = [];
    mountHarness(HarnessProbe, {
      label: 'One',
      onteardown: () => queryRequired(triggers[0]!, 'button').click(),
    });
    mountHarness(HarnessProbe, {
      label: 'Two',
      onteardown: () => queryRequired(triggers[1]!, 'button').click(),
    });
    triggers.push(
      mountHarness(HarnessThrowingUpdate, {}).target,
      mountHarness(HarnessThrowingUpdate, {}).target,
    );

    const thrown = await failureOf(destroyAllHarnesses);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect(document.body.children).toHaveLength(0);
    expect(liveHarnessCount()).toBe(0);
  });
});

type HarnessProbeTarget = HTMLElement;
