import { afterEach, describe, expect, test } from 'bun:test';

import {
  destroyAllHarnesses,
  mountHarness,
  type MountedHarness,
} from '../../../test/mount-harness.ts';
import { reactiveProps } from '../../../test/reactive-props.svelte.ts';
import { createFakeController } from './terminal-attachment-test-support.ts';
import { engineLoader } from './terminal-engine-loader.ts';
import { settle, waitFor } from './terminal-test-support.ts';
import Terminal from './terminal.svelte';
import {
  TERMINAL_FRAME_STATUS,
  TERMINAL_STATE_MESSAGE,
  type TerminalProps,
  type TerminalRendererController,
  type TerminalState,
} from './terminal.types.ts';

const ESC = '\u001b';
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

afterEach(async () => {
  await destroyAllHarnesses();
});

function query(harness: MountedHarness, selector: string): HTMLElement | null {
  return harness.target.querySelector<HTMLElement>(selector);
}

function required(harness: MountedHarness, selector: string): HTMLElement {
  const element = query(harness, selector);
  if (element === null) throw new Error(`Expected ${selector} to be rendered`);
  return element;
}

async function mountReady(props: TerminalProps): Promise<MountedHarness> {
  const harness = mountHarness(Terminal, props);
  await waitFor(
    () =>
      query(harness, '.xterm') !== null &&
      !required(harness, '.cinder-terminal__viewport').hasAttribute('inert'),
    'the engine to mount',
  );
  return harness;
}

describe('structure', () => {
  test('renders the frame as a labelled region with its title and status', () => {
    const harness = mountHarness(Terminal, { title: 'Build shell', state: 'writable' });
    const region = required(harness, '[role="region"]');
    const heading = required(harness, 'h2');
    expect(heading.textContent).toBe('Build shell');
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(region.getAttribute('data-cinder-status')).toBe('connected');
    expect(required(harness, '.cinder-terminal-frame__status').textContent).toBe('connected');
  });

  test('is inert and says it is loading until the engine mounts, then becomes interactive', async () => {
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'writable' });
    const viewport = required(harness, '.cinder-terminal__viewport');
    expect(viewport.hasAttribute('inert')).toBe(true);
    expect(required(harness, '.cinder-terminal__message').textContent).toBe('Loading terminal…');
    expect(query(harness, '.xterm')).toBeNull();
    await waitFor(() => query(harness, '.xterm') !== null, 'the engine');
    await waitFor(() => !viewport.hasAttribute('inert'), 'the viewport to become interactive');
    expect(required(harness, '.cinder-terminal__message').textContent).toBe('Connected');
  });

  test('merges a custom class onto the frame', () => {
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'empty', class: 'mine' });
    const region = required(harness, '[role="region"]');
    expect(region.classList.contains('cinder-terminal')).toBe(true);
    expect(region.classList.contains('mine')).toBe(true);
  });

  test('passes native attributes through to the frame', () => {
    const harness = mountHarness(Terminal, {
      title: 'Shell',
      'data-testid': 'terminal',
    } as TerminalProps);
    expect(required(harness, '[role="region"]').getAttribute('data-testid')).toBe('terminal');
  });

  test('shows the frame recovery control only for a non-empty error and a handler', () => {
    let requests = 0;
    const withError = mountHarness(Terminal, {
      title: 'Shell',
      state: 'failed',
      error: 'Could not start the shell.',
      onRecoveryRequest: () => {
        requests += 1;
      },
    });
    expect(required(withError, '[role="alert"]').textContent).toContain(
      'Could not start the shell.',
    );
    required(withError, '.cinder-terminal-frame__reload').click();
    expect(requests).toBe(1);
    const without = mountHarness(Terminal, { title: 'Shell', state: 'failed' });
    expect(query(without, '[role="alert"]')).toBeNull();
  });
});

describe('states', () => {
  const states = Object.keys(TERMINAL_FRAME_STATUS) as TerminalState[];

  test.each(states)('renders %s in its frame status with its specified message', (state) => {
    const harness = mountHarness(Terminal, { title: 'Shell', state });
    expect(required(harness, '[role="region"]').getAttribute('data-cinder-status')).toBe(
      TERMINAL_FRAME_STATUS[state],
    );
    const message = required(harness, '.cinder-terminal__message').textContent;
    const pending =
      state !== 'empty' &&
      !['denied', 'failed', 'cleanup-incomplete', 'engine-load-failed'].includes(state);
    // Before the engine mounts a live state says it is loading; every other state says itself.
    expect(message).toBe(pending ? TERMINAL_STATE_MESSAGE.loading : TERMINAL_STATE_MESSAGE[state]);
  });

  test('empty shows no engine and no capture control', () => {
    const harness = mountHarness(Terminal, { title: 'Shell' });
    expect(query(harness, '.cinder-terminal__viewport')).toBeNull();
    expect(required(harness, '.cinder-terminal__message').textContent).toBe('No terminal session');
    expect(harness.target.querySelectorAll('button')).toHaveLength(0);
  });

  test('exposes exactly one live status: the detailed message, with the coarse frame chip quiet', async () => {
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'writable' });
    await waitFor(
      () => query(harness, '.cinder-terminal-frame__status')?.getAttribute('role') === null,
      'the frame chip to stop announcing',
    );
    const statuses = harness.target.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.classList.contains('cinder-terminal__message')).toBe(true);
    // The chip keeps its visible text; it is only no longer a second live region.
    expect(required(harness, '.cinder-terminal-frame__status').textContent).toBe('connected');
    expect(harness.target.querySelectorAll('[aria-live]')).toHaveLength(0);
  });

  test('announces a state change the coarse frame status does not distinguish', async () => {
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable' });
    const harness = await mountReady(props);
    const live = required(harness, '[role="status"]');
    expect(live.textContent).toBe(TERMINAL_STATE_MESSAGE.writable);
    for (const next of ['backpressured', 'read-only', 'writable'] as const) {
      props.state = next;
      harness.flush();
      // Every one of these keeps the frame at status="connected"; only the message tells them apart.
      expect(required(harness, '[role="region"]').getAttribute('data-cinder-status')).toBe(
        'connected',
      );
      const statuses = harness.target.querySelectorAll('[role="status"]');
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toBe(live);
      expect(live.textContent).toBe(TERMINAL_STATE_MESSAGE[next]);
    }
  });

  test('a denied session mounts no engine, input surface, or controller subscription', async () => {
    let loads = 0;
    const original = engineLoader.load;
    engineLoader.load = () => {
      loads += 1;
      return original();
    };
    try {
      const controller = createFakeController();
      const harness = mountHarness(Terminal, { title: 'Shell', state: 'denied', controller });
      await settle();
      await settle();
      expect(loads).toBe(0);
      expect(controller.subscriptions).toBe(0);
      expect(query(harness, '.cinder-terminal__viewport')).toBeNull();
      expect(query(harness, '.xterm')).toBeNull();
      expect(harness.target.querySelectorAll('textarea')).toHaveLength(0);
      expect(required(harness, '.cinder-terminal__message').textContent).toBe('Access denied');
    } finally {
      engineLoader.load = original;
    }
  });

  test('a live session that becomes denied tears its engine and subscription down', async () => {
    const controller = createFakeController();
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable', controller });
    const harness = await mountReady(props);
    props.state = 'denied';
    harness.flush();
    expect(query(harness, '.xterm')).toBeNull();
    expect(harness.target.querySelectorAll('textarea')).toHaveLength(0);
    expect(controller.unsubscriptions).toBe(controller.subscriptions);
  });

  test('finishes output that ended while the engine was still loading', async () => {
    // The controller replays a held unicode prefix on subscribe, as a real one replays its buffer.
    let acknowledged = 0;
    const controller = {
      ...createFakeController(),
      subscribeOutput(listener: Parameters<TerminalRendererController['subscribeOutput']>[0]) {
        listener(Uint8Array.of(0xe2, 0x82), () => (acknowledged += 1));
        return () => {};
      },
    };
    for (const state of ['exited', 'disconnected'] as const) {
      acknowledged = 0;
      const harness = mountHarness(Terminal, { title: 'Shell', state, controller });
      await waitFor(() => acknowledged === 1, `the held prefix to be finished in ${state}`);
      await destroyAllHarnesses();
      expect(harness.target.isConnected).toBe(false);
    }
  });

  test('writable offers the capture control, composed from the Cinder Button, and read-only does not', () => {
    const writable = mountHarness(Terminal, { title: 'Shell', state: 'writable' });
    const buttons = [...writable.target.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Capture terminal keys']);
    expect(buttons[0]!.className).toContain('cinder-button');
    for (const state of [
      'read-only',
      'loading',
      'connecting',
      'backpressured',
      'exited',
    ] as const) {
      const other = mountHarness(Terminal, { title: 'Shell', state });
      expect(other.target.querySelectorAll('button')).toHaveLength(0);
    }
  });

  test('keeps the engine, and so the retained output, as the state moves between live and ended', async () => {
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable' });
    const harness = await mountReady(props);
    const engine = required(harness, '.xterm');
    for (const next of [
      'backpressured',
      'exited',
      'disconnected',
      'failed',
      'read-only',
      'writable',
    ] as const) {
      props.state = next;
      harness.flush();
      expect(required(harness, '.xterm')).toBe(engine);
    }
  });

  test('tears the engine down when the state returns to empty', async () => {
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'writable' });
    const harness = await mountReady(props);
    props.state = 'empty';
    harness.flush();
    expect(query(harness, '.xterm')).toBeNull();
    expect(query(harness, '.cinder-terminal__viewport')).toBeNull();
  });
});

describe('the engine on the client', () => {
  test('labels the input surface and follows a changed label', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      ariaLabel: 'Build output',
    });
    const harness = await mountReady(props);
    const textarea = required(harness, 'textarea');
    expect(textarea.getAttribute('aria-label')).toBe('Build output');
    props.ariaLabel = 'Deploy output';
    harness.flush();
    await settle();
    expect(textarea.getAttribute('aria-label')).toBe('Deploy output');
  });

  test('defaults the input label', async () => {
    const harness = await mountReady({ title: 'Shell', state: 'writable' });
    expect(required(harness, 'textarea').getAttribute('aria-label')).toBe('Terminal');
  });

  test('mirrors output to a live region only when asked', async () => {
    const quiet = await mountReady({ title: 'Quiet', state: 'writable' });
    expect(query(quiet, '.xterm-accessibility')).toBeNull();
    const props = reactiveProps<TerminalProps>({
      title: 'Loud',
      state: 'writable',
      announceOutput: true,
    });
    const loud = await mountReady(props);
    expect(query(loud, '.xterm-accessibility')).not.toBeNull();
  });

  test('stays editable-free and does not steal focus on mount', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const harness = await mountReady({ title: 'Shell', state: 'writable' });
    expect(document.activeElement).toBe(outside);
    expect(harness.target.querySelector('[autofocus]')).toBeNull();
    outside.remove();
  });

  test('mounts exactly one engine however often its state changes', async () => {
    const props = reactiveProps<TerminalProps>({ title: 'Shell', state: 'loading' });
    const harness = await mountReady(props);
    props.state = 'connecting';
    harness.flush();
    props.state = 'writable';
    harness.flush();
    await settle();
    expect(harness.target.querySelectorAll('.xterm')).toHaveLength(1);
    expect(harness.target.querySelectorAll('textarea')).toHaveLength(1);
  });
});

describe('output', () => {
  test('subscribes to the controller once the engine is mounted and renders what it sends', async () => {
    const controller = createFakeController();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    expect(controller.subscriptions).toBe(1);
    const acknowledged: number[] = [];
    controller.everRegistered[0]!(bytes(`${ESC}[31mred${ESC}[0m text`), () => acknowledged.push(1));
    await waitFor(() => acknowledged.length === 1, 'the chunk to be parsed');
    await waitFor(
      () => (harness.target.textContent ?? '').includes('red text'),
      'the text to paint',
    );
  });

  test('acknowledges output at the parse boundary while painting never runs', async () => {
    const controller = createFakeController();
    await mountReady({ title: 'Shell', state: 'writable', controller });
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    try {
      const acknowledged: number[] = [];
      controller.everRegistered[0]!(bytes('parsed while hidden'), () => acknowledged.push(1));
      await waitFor(() => acknowledged.length === 1, 'the chunk to be parsed');
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });

  test('reports a title the program sets as bounded text, never as a frame title', async () => {
    const titles: string[] = [];
    const controller = createFakeController();
    const harness = await mountReady({
      title: 'Shell',
      state: 'writable',
      controller,
      onTitleChange: (title) => titles.push(title),
    });
    controller.everRegistered[0]!(
      bytes(`${ESC}]0;evil <b>title</b>${'x'.repeat(400)}\u0007`),
      () => {},
    );
    await waitFor(() => titles.length === 1, 'the title');
    expect(titles[0]!.startsWith('evil <b>title</b>')).toBe(true);
    expect(Array.from(titles[0]!)).toHaveLength(256);
    expect(required(harness, 'h2').textContent).toBe('Shell');
  });

  test('renders output as text, never as markup', async () => {
    const controller = createFakeController();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    const acknowledged: number[] = [];
    controller.everRegistered[0]!(bytes('<img src=x onerror=alert(1)><script>1</script>'), () =>
      acknowledged.push(1),
    );
    await waitFor(() => acknowledged.length === 1, 'the chunk to be parsed');
    expect(harness.target.querySelector('img')).toBeNull();
    expect(harness.target.querySelector('.cinder-terminal__viewport script')).toBeNull();
  });
});

describe('cleanup and session replacement', () => {
  test('destroying the component releases the engine and unsubscribes, and never disposes the borrowed controller', async () => {
    const controller = createFakeController();
    const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
    harness.destroy();
    expect(controller.unsubscriptions).toBe(1);
    expect(controller.disposals).toBe(0);
    expect(controller.failures).toEqual([]);
    expect(harness.target.querySelector('.xterm')).toBeNull();
    // The controller is still usable after the view is gone.
    expect(controller.emit(bytes('after'))).toBe(0);
  });

  test('destroying before the import resolves attaches nothing', async () => {
    const controller = createFakeController();
    const harness = mountHarness(Terminal, { title: 'Shell', state: 'writable', controller });
    const before = document.querySelectorAll('.xterm').length;
    harness.destroy();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.subscriptions).toBe(0);
    expect(document.querySelectorAll('.xterm')).toHaveLength(before);
    expect(document.querySelectorAll('textarea.xterm-helper-textarea')).toHaveLength(0);
  });

  test('replacing the controller unsubscribes the old one without disposing it, and subscribes the new one once', async () => {
    const first = createFakeController();
    const second = createFakeController();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
    });
    const harness = await mountReady(props);
    expect(first.subscriptions).toBe(1);
    props.controller = second;
    harness.flush();
    await waitFor(() => second.subscriptions === 1, 'the new controller to be subscribed');
    expect(first.unsubscriptions).toBe(1);
    expect(first.disposals).toBe(0);
    expect(second.subscriptions).toBe(1);
    expect(harness.target.querySelectorAll('.xterm')).toHaveLength(1);
    // Output from the replaced controller no longer reaches the screen.
    expect(first.emit(bytes('stale'))).toBe(0);
    const acknowledged: number[] = [];
    second.everRegistered[0]!(bytes('fresh'), () => acknowledged.push(1));
    await waitFor(() => acknowledged.length === 1, 'the new session output to be parsed');
    harness.destroy();
    expect(second.unsubscriptions).toBe(1);
    expect(second.disposals).toBe(0);
  });

  test('replacing the controller before the first import resolves attaches only the latest', async () => {
    const first = createFakeController();
    const second = createFakeController();
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'writable',
      controller: first,
    });
    const harness = mountHarness(Terminal, props);
    props.controller = second;
    harness.flush();
    await waitFor(() => second.subscriptions === 1, 'the latest controller to be subscribed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.subscriptions).toBe(0);
    expect(harness.target.querySelectorAll('.xterm')).toHaveLength(1);
  });

  test('a long-lived controller survives many views', async () => {
    const controller = createFakeController();
    for (let round = 0; round < 3; round += 1) {
      const harness = await mountReady({ title: 'Shell', state: 'writable', controller });
      harness.destroy();
    }
    expect(controller.subscriptions).toBe(3);
    expect(controller.unsubscriptions).toBe(3);
    expect(controller.disposals).toBe(0);
  });
});

describe('geometry', () => {
  test('never reports the frame estimate, even when its observer measures a positive size', async () => {
    const original = globalThis.ResizeObserver;
    const callbacks: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    try {
      const geometries: unknown[] = [];
      await mountReady({
        title: 'Shell',
        state: 'writable',
        onGeometryChange: (geometry) => geometries.push(geometry),
      });
      expect(callbacks.length).toBeGreaterThan(0);
      for (const callback of callbacks) {
        callback(
          [{ contentRect: { width: 800, height: 360 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(geometries).toEqual([]);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  test('a container with no layout reports no geometry, rather than inventing one', async () => {
    const geometries: unknown[] = [];
    await mountReady({
      title: 'Shell',
      state: 'writable',
      onGeometryChange: (geometry) => geometries.push(geometry),
    });
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(geometries).toEqual([]);
  });

  test('a view that does not own the grid adopts the owner grid and reports nothing', async () => {
    const geometries: unknown[] = [];
    const harness = await mountReady({
      title: 'Shell',
      state: 'read-only',
      ownerGeometry: { columns: 120, rows: 40 },
      onGeometryChange: (geometry) => geometries.push(geometry),
    });
    expect(required(harness, '.cinder-terminal__viewport').getAttribute('data-grid')).toBe('owner');
    await waitFor(
      () => harness.target.querySelectorAll('.xterm-rows > div').length === 40,
      'the owner row count',
    );
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(geometries).toEqual([]);
  });

  test('a view that owns the grid is fitted', async () => {
    const harness = await mountReady({ title: 'Shell', state: 'connecting' });
    expect(required(harness, '.cinder-terminal__viewport').getAttribute('data-grid')).toBe(
      'fitted',
    );
  });

  test('follows an owner grid that changes', async () => {
    const props = reactiveProps<TerminalProps>({
      title: 'Shell',
      state: 'read-only',
      ownerGeometry: { columns: 120, rows: 40 },
    });
    const harness = await mountReady(props);
    props.ownerGeometry = { columns: 100, rows: 20 };
    harness.flush();
    await waitFor(
      () => harness.target.querySelectorAll('.xterm-rows > div').length === 20,
      'the new owner row count',
    );
  });
});
