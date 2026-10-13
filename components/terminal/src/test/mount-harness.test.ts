import { afterEach, describe, expect, test } from 'bun:test';
import type { Component } from 'svelte';

import HarnessProbe from './harness-probe.svelte';
import HarnessThrowingEffect from './harness-throwing-effect.svelte';
import { destroyAllHarnesses, liveHarnessCount, mountHarness } from './mount-harness.ts';

afterEach(destroyAllHarnesses);

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

  test('keeps harnesses independent and destroys all of them on request', () => {
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

    destroyAllHarnesses();

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

  test('rethrows the mount error, not a teardown error, and still removes the container', () => {
    expect(() => mountHarness(HarnessThrowingEffect, { teardownThrows: true })).toThrow(
      'effect failed',
    );

    expect(document.body.children).toHaveLength(0);
  });
});
