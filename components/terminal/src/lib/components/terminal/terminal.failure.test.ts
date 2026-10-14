import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../../test/mount-harness.ts';
import { reactiveProps } from '../../../test/reactive-props.svelte.ts';
import { createFakeController } from './terminal-attachment-test-support.ts';
import * as realLoader from './terminal-engine-loader.ts';
import { waitFor } from './terminal-test-support.ts';
import type { TerminalProps } from './terminal.types.ts';

// Mocking replaces the module's exports in place, so keep the real function before it happens.
const loadRealEngine = realLoader.loadRendererEngineFactory;

/** How the next engine load behaves. Swapped per test. */
let behavior: () => Promise<unknown> = () => loadRealEngine();
let loads = 0;

beforeAll(() => {
  mock.module('./terminal-engine-loader.ts', () => ({
    loadRendererEngineFactory: () => {
      loads += 1;
      return behavior();
    },
  }));
});

// Mocked modules persist for the whole test process, so put the real loader back for any file
// that runs after this one.
afterAll(() => {
  mock.module('./terminal-engine-loader.ts', () => ({ loadRendererEngineFactory: loadRealEngine }));
});

afterEach(() => {
  destroyAllHarnesses();
  behavior = () => loadRealEngine();
  loads = 0;
});

const { default: Terminal } = await import('./terminal.svelte');

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
      return attempt === 1 ? Promise.reject(new Error('flaky asset')) : loadRealEngine();
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
