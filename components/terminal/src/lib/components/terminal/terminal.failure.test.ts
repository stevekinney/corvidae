import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../../test/mount-harness.ts';
import { reactiveProps } from '../../../test/reactive-props.svelte.ts';
import { createFakeController } from './terminal-attachment-test-support.ts';
import { engineLoader, loadRendererEngineFactory } from './terminal-engine-loader.ts';
import { waitFor } from './terminal-test-support.ts';
import Terminal from './terminal.svelte';
import type { TerminalProps, TerminalRendererController, TerminalState } from './terminal.types.ts';

/** How the next engine load behaves. Swapped per test. */
let behavior: () => ReturnType<typeof loadRendererEngineFactory> = () =>
  loadRendererEngineFactory();
let loads = 0;
const originalLoad = engineLoader.load;

beforeEach(() => {
  engineLoader.load = () => {
    loads += 1;
    return behavior();
  };
});

afterEach(async () => {
  await destroyAllHarnesses();
  engineLoader.load = originalLoad;
  behavior = () => loadRendererEngineFactory();
  loads = 0;
});

async function failed(harness: MountedHarness): Promise<void> {
  await waitFor(
    () =>
      harness.target.querySelector('.cinder-terminal__message')?.textContent ===
      'Terminal engine unavailable',
    'the failure message',
  );
}

function required(harness: MountedHarness, selector: string): HTMLElement {
  const element = harness.target.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

describe('engine failure fails closed', () => {
  test('a load failure shows the specified failure, builds nothing, and tells the controller once', async () => {
    behavior = () => Promise.reject(new Error('wasm blocked by policy'));
    const controller = createFakeController();
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      controller,
    } as TerminalProps);
    await failed(harness);
    expect(required(harness, '[role="region"]').getAttribute('data-cinder-status')).toBe('error');
    expect(harness.target.querySelector('.xterm')).toBeNull();
    expect(harness.target.querySelector('.cinder-terminal__viewport')).toBeNull();
    expect(harness.target.querySelector('textarea')).toBeNull();
    expect(controller.failures).toEqual([{ phase: 'load', message: 'wasm blocked by policy' }]);
    expect(controller.subscriptions).toBe(0);
    expect(controller.disposals).toBe(0);
    // No capture control, no fallback, and with no handler to ask, no inert recovery control.
    expect(harness.target.querySelectorAll('button')).toHaveLength(0);
  });

  test('Retry on a host-supplied engine-load-failed state asks the host to recover', async () => {
    let requests = 0;
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'engine-load-failed',
      onRecoveryRequest: () => {
        requests += 1;
      },
    } as TerminalProps);
    const retry = [...harness.target.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    )!;
    retry.click();
    harness.flush();
    expect(requests).toBe(1);
    expect(loads).toBe(0);
  });

  test('a host-supplied engine-load-failed state with no recovery handler offers no inert Retry', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'engine-load-failed',
    } as TerminalProps);
    expect(harness.target.querySelector('.cinder-terminal__message')?.textContent).toBe(
      'Terminal engine unavailable',
    );
    expect(
      [...harness.target.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ).not.toContain('Retry');
  });

  test('Retry on a renderer-owned failure asks the host and does not remount the failed controller', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    let requests = 0;
    const controller = createFakeController();
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      controller,
      onRecoveryRequest: () => {
        requests += 1;
      },
    } as TerminalProps);
    await failed(harness);
    const retry = [...harness.target.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    )!;
    retry.click();
    harness.flush();
    await quietFor(60);
    expect(requests).toBe(1);
    // The controller was revoked by the failure, so it is never subscribed to again.
    expect(loads).toBe(1);
    expect(controller.subscriptions).toBe(0);
    expect(controller.failures).toHaveLength(1);
    expect(harness.target.querySelector('.xterm')).toBeNull();
  });

  test('a controller-less renderer failure can be retried locally, because nothing was revoked', async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : loadRendererEngineFactory();
    };
    let requests = 0;
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      onRecoveryRequest: () => {
        requests += 1;
      },
    } as TerminalProps);
    await failed(harness);
    required(harness, 'button').click();
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the engine after retry');
    expect(requests).toBe(1);
    expect(loads).toBe(2);
  });

  test('renders exactly one recovery control when the host passes an error and a handler', async () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'engine-load-failed',
      error: 'The engine asset is blocked.',
      onRecoveryRequest: () => {},
    } as TerminalProps);
    const labels = [...harness.target.querySelectorAll('button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['Reload']);
  });

  test('renders exactly one recovery control for a renderer failure that carries an error', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      error: 'The engine asset is blocked.',
      controller: createFakeController(),
      onRecoveryRequest: () => {},
    } as TerminalProps);
    await failed(harness);
    expect(harness.target.querySelectorAll('button')).toHaveLength(1);
  });

  test('does not switch engines or retry on its own', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'writable' });
    await failed(harness);
    await quietFor(60);
    expect(loads).toBe(1);
  });

  test('a replacement controller from the host mounts a new engine and drops the failure', async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky asset')) : loadRendererEngineFactory();
    };
    const failedController = createFakeController();
    const replacement = createFakeController();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: failedController,
      onRecoveryRequest: () => {
        props.controller = replacement;
      },
    });
    const harness = mountHarness(Terminal, props);
    await failed(harness);
    required(harness, 'button').click();
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the engine after retry');
    expect(loads).toBe(2);
    expect(required(harness, '[role="region"]').getAttribute('data-cinder-status')).toBe(
      'connected',
    );
    expect(failedController.failures).toHaveLength(1);
    expect(failedController.subscriptions).toBe(0);
    expect(replacement.subscriptions).toBe(1);
  });

  test('a failure while the view is empty is shown once the session starts', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'empty' });
    const harness = mountHarness(Terminal, props);
    expect(loads).toBe(0);
    props.state = 'loading';
    harness.flush();
    await failed(harness);
  });
});

/** Props whose controller a test swaps or clears after mounting. */
type MutableControllerProps = {
  title: string;
  state: TerminalState;
  controller: TerminalRendererController | undefined;
  onRecoveryRequest?: () => void;
};

describe('recovery controls and controller-bound failures (COR-1516)', () => {
  test("the frame's Reload clears a controller-less renderer failure the way Retry does", async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : loadRendererEngineFactory();
    };
    let requests = 0;
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      error: 'The engine asset is blocked.',
      onRecoveryRequest: () => {
        requests += 1;
      },
    } as TerminalProps);
    await failed(harness);
    const labels = [...harness.target.querySelectorAll('button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['Reload']);
    required(harness, 'button').click();
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the engine after reload');
    expect(requests).toBe(1);
    expect(loads).toBe(2);
  });

  test('Reload on a failure bound to a controller asks the host and does not remount that controller', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    const controller = createFakeController();
    let requests = 0;
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      error: 'The engine asset is blocked.',
      controller,
      onRecoveryRequest: () => {
        requests += 1;
      },
    } as TerminalProps);
    await failed(harness);
    required(harness, 'button').click();
    harness.flush();
    await quietFor(60);
    expect(requests).toBe(1);
    expect(loads).toBe(1);
    expect(controller.subscriptions).toBe(0);
  });

  test('clearing the controller does not clear a failure tied to it', async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : loadRendererEngineFactory();
    };
    const revoked = createFakeController();
    const props = reactiveProps<MutableControllerProps>({
      title: 'Shell',
      state: 'writable',
      controller: revoked,
    });
    // Reactive props proxy their values, so the same controller is the one read back, not `revoked`.
    const sameController = props.controller;
    const harness = mountHarness(Terminal, props as unknown as TerminalProps);
    await failed(harness);
    props.controller = undefined;
    harness.flush();
    await quietFor(60);
    expect(required(harness, '.cinder-terminal__message').textContent).toBe(
      'Terminal engine unavailable',
    );
    expect(loads).toBe(1);
    expect(harness.target.querySelector('.xterm')).toBeNull();
    // Bringing the revoked controller back is not a replacement either.
    props.controller = sameController;
    harness.flush();
    await quietFor(60);
    expect(required(harness, '.cinder-terminal__message').textContent).toBe(
      'Terminal engine unavailable',
    );
    expect(loads).toBe(1);
    expect(revoked.subscriptions).toBe(0);
    // A distinct, defined controller is.
    const replacement = createFakeController();
    props.controller = replacement;
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the replacement engine');
    expect(replacement.subscriptions).toBe(1);
    expect(loads).toBe(2);
  });

  test('a replaced failure stays gone when the old controller comes back', async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : loadRendererEngineFactory();
    };
    const revoked = createFakeController();
    const replacement = createFakeController();
    const props = reactiveProps<MutableControllerProps>({
      title: 'Shell',
      state: 'writable',
      controller: revoked,
    });
    const sameController = props.controller;
    const harness = mountHarness(Terminal, props as unknown as TerminalProps);
    await failed(harness);
    props.controller = replacement;
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the replacement engine');
    props.controller = sameController;
    harness.flush();
    await waitFor(
      () => revoked.subscriptions === 1,
      'the original controller to mount again, because its failure was already replaced',
    );
  });

  test('Retry with no controller after a controller-bound failure is an explicit controller-less retry', async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky')) : loadRendererEngineFactory();
    };
    const props = reactiveProps<MutableControllerProps>({
      title: 'Shell',
      state: 'writable',
      controller: createFakeController(),
      onRecoveryRequest: () => {},
    });
    const harness = mountHarness(Terminal, props as unknown as TerminalProps);
    await failed(harness);
    props.controller = undefined;
    harness.flush();
    await quietFor(30);
    expect(loads).toBe(1);
    required(harness, 'button').click();
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the engine after retry');
    expect(loads).toBe(2);
  });
});
