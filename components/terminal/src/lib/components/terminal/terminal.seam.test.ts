import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../../test/mount-harness.ts';
import { reactiveProps } from '../../../test/reactive-props.svelte.ts';
import {
  createFakeController,
  createFakeFactory,
  type FakeEngine,
} from './terminal-attachment-test-support.ts';
import { engineLoader } from './terminal-engine-loader.ts';
import { settle, waitFor } from './terminal-test-support.ts';
import Terminal from './terminal.svelte';
import type { TerminalGeometry, TerminalProps } from './terminal.types.ts';

/**
 * The component against a fake engine, to reach what happy-dom cannot lay out: a container with a
 * measurable size, and an engine that fails while a session is running. The real engine is
 * covered by the other terminal tests and by the corpus.
 */
const fake = createFakeFactory();
const originalLoad = engineLoader.load;

beforeEach(() => {
  engineLoader.load = () => Promise.resolve(fake.factory);
});

afterEach(async () => {
  await destroyAllHarnesses();
  engineLoader.load = originalLoad;
  fake.created.length = 0;
});

const engine = (): FakeEngine => fake.created.at(-1)!.engine;
const message = (harness: MountedHarness) =>
  harness.target.querySelector('.cinder-terminal__message')?.textContent;

async function mountWithEngine(props: TerminalProps): Promise<MountedHarness> {
  const harness = mountHarness(Terminal, props);
  await waitFor(() => fake.created.length > 0, 'the engine to be created');
  return harness;
}

describe('geometry reaches the host', () => {
  test('reports the engine measurement once, however often the container signals', async () => {
    const geometries: TerminalGeometry[] = [];
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'connecting',
      onGeometryChange: (geometry) => geometries.push(geometry),
    });
    const harness = await mountWithEngine(props);
    engine().measurement = { columns: 100, rows: 30 };
    for (let signal = 0; signal < 20; signal += 1) window.dispatchEvent(new Event('resize'));
    await waitFor(() => geometries.length === 1, 'the geometry');
    window.dispatchEvent(new Event('resize'));
    await quietFor(60);
    expect(geometries).toEqual([{ columns: 100, rows: 30 }]);
    expect(engine().resizes).toEqual([{ columns: 100, rows: 30 }]);
    harness.destroy();
  });

  test('a new measurement is reported, and a hidden one is not', async () => {
    const geometries: TerminalGeometry[] = [];
    const harness = await mountWithEngine({
      title: 'Shell',
      state: 'writable',
      onGeometryChange: (geometry) => geometries.push(geometry),
    });
    engine().measurement = { columns: 100, rows: 30 };
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => geometries.length === 1, 'the first geometry');
    engine().measurement = undefined;
    window.dispatchEvent(new Event('resize'));
    await quietFor(60);
    expect(geometries).toHaveLength(1);
    engine().measurement = { columns: 90, rows: 20 };
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => geometries.length === 2, 'the second geometry');
    expect(geometries[1]).toEqual({ columns: 90, rows: 20 });
    harness.destroy();
  });

  test('a view that does not own the grid never measures or reports', async () => {
    const geometries: TerminalGeometry[] = [];
    const harness = await mountWithEngine({
      title: 'Shell',
      state: 'read-only',
      ownerGeometry: { columns: 120, rows: 40 },
      onGeometryChange: (geometry) => geometries.push(geometry),
    });
    expect(fake.created[0]!.options.geometry).toEqual({ columns: 120, rows: 40 });
    engine().measurement = { columns: 10, rows: 5 };
    window.dispatchEvent(new Event('resize'));
    await quietFor(60);
    expect(geometries).toEqual([]);
    expect(engine().measureCount).toBe(0);
    harness.destroy();
  });

  test('state decides input: only a writable view takes input, and every view hands the engine its label', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      ariaLabel: 'Build',
    });
    const harness = await mountWithEngine(props);
    expect(fake.created[0]!.options.readOnly).toBe(false);
    expect(fake.created[0]!.options.ariaLabel).toBe('Build');
    props.state = 'backpressured';
    harness.flush();
    await waitFor(() => engine().updates.at(-1)?.readOnly === true, 'input to be disabled');
    props.state = 'writable';
    harness.flush();
    await waitFor(() => engine().updates.at(-1)?.readOnly === false, 'input to be enabled');
    harness.destroy();
  });

  test('hands the host link activation to the engine only when the host supplies it', async () => {
    const opened: string[] = [];
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable' });
    const harness = await mountWithEngine(props);
    expect(engine().linkActivations.at(-1)).toBeUndefined();
    props.onLinkActivate = (url) => opened.push(url);
    harness.flush();
    await waitFor(() => engine().linkActivations.at(-1) !== undefined, 'link activation');
    engine().linkActivations.at(-1)?.('https://example.test/');
    expect(opened).toEqual(['https://example.test/']);
    harness.destroy();
  });

  test('forwards a program title to the host', async () => {
    const titles: string[] = [];
    const harness = await mountWithEngine({
      title: 'Shell',
      state: 'writable',
      onTitleChange: (title) => titles.push(title),
    });
    fake.created[0]!.options.onTitle?.('building');
    expect(titles).toEqual(['building']);
    harness.destroy();
  });
});

describe('an engine that fails during a session', () => {
  test('fails closed: disposes the engine, shows the failure, tells the controller, and never replays', async () => {
    const controller = createFakeController();
    const harness = await mountWithEngine({ title: 'Shell', state: 'writable', controller });
    await waitFor(() => controller.subscriptions === 1, 'the subscription');
    const failing = engine();
    failing.throwOn.write = new Error('renderer lost its context');
    controller.emit(Uint8Array.of(0x41));
    await waitFor(() => message(harness) === 'Terminal engine unavailable', 'the failure');
    expect(controller.failures).toEqual([{ phase: 'parse', message: 'renderer lost its context' }]);
    expect(failing.calls.filter((call) => call === 'dispose')).toHaveLength(1);
    expect(controller.unsubscriptions).toBe(1);
    expect(controller.disposals).toBe(0);
    expect(harness.target.querySelector('.cinder-terminal__viewport')).toBeNull();
    expect(
      harness.target.querySelector('[role="region"]')?.getAttribute('data-cinder-status'),
    ).toBe('error');
    // Nothing built a replacement engine or replayed the bytes that were being written.
    expect(fake.created).toHaveLength(1);
    expect(failing.writes).toEqual([]);
    harness.destroy();
  });

  test('a fit that throws also fails closed', async () => {
    const controller = createFakeController();
    const harness = await mountWithEngine({ title: 'Shell', state: 'connecting', controller });
    engine().throwOn.measure = new Error('layout failed');
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => message(harness) === 'Terminal engine unavailable', 'the failure');
    expect(controller.failures).toEqual([{ phase: 'render', message: 'layout failed' }]);
    harness.destroy();
  });

  test('Retry asks the host, and only a new controller builds a new engine', async () => {
    const failedController = createFakeController();
    const replacement = createFakeController();
    let requests = 0;
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: failedController,
      onRecoveryRequest: () => {
        requests += 1;
      },
    });
    const harness = await mountWithEngine(props);
    engine().throwOn.write = new Error('lost');
    failedController.emit(Uint8Array.of(0x41));
    await waitFor(() => message(harness) === 'Terminal engine unavailable', 'the failure');
    const retry = [...harness.target.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry',
    )!;
    retry.click();
    harness.flush();
    await quietFor(40);
    expect(requests).toBe(1);
    expect(fake.created).toHaveLength(1);
    expect(failedController.subscriptions).toBe(1);
    expect(message(harness)).toBe('Terminal engine unavailable');
    props.controller = replacement;
    harness.flush();
    await waitFor(() => fake.created.length === 2, 'a second engine');
    await waitFor(() => message(harness) === 'Connected', 'the connected state');
    expect(replacement.subscriptions).toBe(1);
    expect(failedController.subscriptions).toBe(1);
    harness.destroy();
  });

  test('a geometry handler that throws fails closed instead of escaping the fit', async () => {
    const controller = createFakeController();
    const harness = await mountWithEngine({
      title: 'Shell',
      state: 'writable',
      controller,
      onGeometryChange: () => {
        throw new Error('host geometry handler threw');
      },
    });
    engine().measurement = { columns: 100, rows: 30 };
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => message(harness) === 'Terminal engine unavailable', 'the failure');
    expect(controller.failures).toEqual([
      { phase: 'render', message: 'host geometry handler threw' },
    ]);
    harness.destroy();
  });

  test('changing the class re-resolves the engine colors', async () => {
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', class: 'a' });
    const harness = await mountWithEngine(props);
    await settle();
    const before = engine().updates.length;
    props.class = 'b';
    harness.flush();
    await waitFor(() => engine().updates.length > before, 'the engine to refresh its colors');
    harness.destroy();
  });

  test('changing the style re-resolves the engine colors', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      style: '--cinder-surface-inset: red',
    });
    const harness = await mountWithEngine(props);
    await settle();
    const before = engine().updates.length;
    props.style = '--cinder-surface-inset: blue';
    harness.flush();
    await waitFor(() => engine().updates.length > before, 'the engine to refresh its colors');
    harness.destroy();
  });

  test.each(['exited', 'disconnected'] as const)(
    'ending the session (%s) tells the engine the output is over',
    async (ended) => {
      const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable' });
      const harness = await mountWithEngine(props);
      expect(engine().calls).not.toContain('finishOutput');
      props.state = ended;
      harness.flush();
      await waitFor(() => engine().calls.includes('finishOutput'), 'the end of output');
      harness.destroy();
    },
  );
});
