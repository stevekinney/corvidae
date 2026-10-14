import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

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
import type { TerminalProps } from './terminal.types.ts';

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

afterEach(() => {
  destroyAllHarnesses();
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
    // No capture control and no fallback: only the retry.
    expect(
      [...harness.target.querySelectorAll('button')].map((button) => button.textContent?.trim()),
    ).toEqual(['Retry']);
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

  test('Retry on a renderer-owned failure reloads the engine and does not call the host', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    let requests = 0;
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
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
    await waitFor(() => loads === 2, 'a second load attempt');
    expect(requests).toBe(0);
  });

  test('does not switch engines or retry on its own', async () => {
    behavior = () => Promise.reject(new Error('blocked'));
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'writable' });
    await failed(harness);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(loads).toBe(1);
  });

  test('retry loads the engine again and, on success, mounts it and drops the failure', async () => {
    let attempt = 0;
    behavior = () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('flaky asset')) : loadRendererEngineFactory();
    };
    const controller = createFakeController();
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      state: 'writable',
      controller,
    } as TerminalProps);
    await failed(harness);
    required(harness, 'button').click();
    harness.flush();
    await waitFor(() => harness.target.querySelector('.xterm') !== null, 'the engine after retry');
    expect(loads).toBe(2);
    expect(required(harness, '[role="region"]').getAttribute('data-cinder-status')).toBe(
      'connected',
    );
    expect(controller.failures).toHaveLength(1);
    expect(controller.subscriptions).toBe(1);
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
