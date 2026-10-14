import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createFakeController,
  createFakeFactory,
  createManualScheduler,
  defaultSettings,
  deferred,
  type FakeController,
  type FakeEngine,
} from './terminal-attachment-test-support.ts';
import { createTerminalAttachment, type AttachmentSettings } from './terminal-attachment.ts';
import type { RendererEngineFactory } from './terminal-engine-adapter.ts';
import { INITIAL_GEOMETRY } from './terminal-engine-adapter.ts';
import type { TerminalGeometry, TerminalRendererFailure } from './terminal.types.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);

/** Let every pending promise continuation run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeMediaQueryList extends EventTarget {
  matches = false;
  constructor(readonly media: string) {
    super();
  }
  change(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

const originalMatchMedia = globalThis.matchMedia;
const originalResizeObserver = globalThis.ResizeObserver;
let mediaLists: FakeMediaQueryList[] = [];
let resizeObservers: Array<{ notify(): void; disconnected: boolean }> = [];
const hosts: HTMLElement[] = [];

beforeEach(() => {
  mediaLists = [];
  resizeObservers = [];
  globalThis.matchMedia = ((query: string) => {
    const list = new FakeMediaQueryList(query);
    mediaLists.push(list);
    return list;
  }) as unknown as typeof matchMedia;
  globalThis.ResizeObserver = class {
    private readonly entry: { notify(): void; disconnected: boolean };
    constructor(callback: ResizeObserverCallback) {
      this.entry = {
        notify: () => callback([], this),
        disconnected: false,
      };
      resizeObservers.push(this.entry);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      this.entry.disconnected = true;
    }
  };
});

afterEach(() => {
  globalThis.matchMedia = originalMatchMedia;
  globalThis.ResizeObserver = originalResizeObserver;
  for (const host of hosts.splice(0)) host.remove();
});

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  return host;
}

type Setup = {
  attachment: ReturnType<typeof createTerminalAttachment>;
  factory: ReturnType<typeof createFakeFactory>;
  loader: ReturnType<typeof deferred<RendererEngineFactory>>;
  controller: FakeController;
  scheduler: ReturnType<typeof createManualScheduler>;
  host: HTMLElement;
  geometries: TerminalGeometry[];
  failures: TerminalRendererFailure[];
  titles: string[];
  readyCount: () => number;
  settings: AttachmentSettings;
  engine: () => FakeEngine;
  /** Resolve the engine import and let the attachment finish initializing. */
  load(): Promise<FakeEngine>;
};

function setup(
  options: { settings?: Partial<AttachmentSettings>; withController?: boolean } = {},
): Setup {
  const host = makeHost();
  const factory = createFakeFactory();
  const loader = deferred<RendererEngineFactory>();
  const controller = createFakeController();
  const scheduler = createManualScheduler();
  const geometries: TerminalGeometry[] = [];
  const failures: TerminalRendererFailure[] = [];
  const titles: string[] = [];
  let ready = 0;
  const settings: AttachmentSettings = { ...defaultSettings, ...options.settings };
  const attachment = createTerminalAttachment({
    host,
    controller: options.withController === false ? undefined : controller,
    loadEngine: () => loader.promise,
    readSettings: () => settings,
    onReady: () => {
      ready += 1;
    },
    onGeometry: (geometry) => geometries.push(geometry),
    onFailure: (failure) => failures.push(failure),
    onTitle: (title) => titles.push(title),
    scheduleFit: scheduler.schedule,
  });
  const engine = () => factory.created.at(-1)!.engine;
  return {
    attachment,
    factory,
    loader,
    controller,
    scheduler,
    host,
    geometries,
    failures,
    titles,
    readyCount: () => ready,
    settings,
    engine,
    async load() {
      loader.resolve(factory.factory);
      await settle();
      return engine();
    },
  };
}

describe('lifecycle', () => {
  test('constructs, mounts, and subscribes only after the import resolves', async () => {
    const s = setup();
    expect(s.factory.created).toHaveLength(0);
    expect(s.controller.subscriptions).toBe(0);
    expect(s.attachment.ready).toBe(false);
    const engine = await s.load();
    expect(s.factory.created).toHaveLength(1);
    expect(engine.calls.slice(0, 2)).toEqual(['mount', 'setLinkActivation']);
    expect(s.controller.subscriptions).toBe(1);
    expect(s.readyCount()).toBe(1);
    expect(s.attachment.ready).toBe(true);
    s.attachment.dispose();
  });

  test('an import that resolves after disposal constructs nothing, mounts nothing, subscribes to nothing', async () => {
    const s = setup();
    s.attachment.dispose();
    s.loader.resolve(s.factory.factory);
    await settle();
    expect(s.factory.created).toHaveLength(0);
    expect(s.controller.subscriptions).toBe(0);
    expect(s.readyCount()).toBe(0);
    expect(s.failures).toEqual([]);
    expect(s.host.childElementCount).toBe(0);
  });

  test('an import that fails after disposal reports nothing', async () => {
    const s = setup();
    s.attachment.dispose();
    s.loader.reject(new Error('asset missing'));
    await settle();
    expect(s.failures).toEqual([]);
    expect(s.controller.failures).toEqual([]);
  });

  test('disposal releases the subscription, engine, observers, and pending fit, once', async () => {
    const s = setup();
    const engine = await s.load();
    expect(s.scheduler.pending).toBe(1);
    s.attachment.dispose();
    s.attachment.dispose();
    expect(s.controller.unsubscriptions).toBe(1);
    expect(engine.calls.filter((call) => call === 'dispose')).toHaveLength(1);
    expect(s.scheduler.pending).toBe(0);
    expect(resizeObservers.every((observer) => observer.disconnected)).toBe(true);
    expect(s.attachment.ready).toBe(false);
    expect(s.host.querySelector('span')).toBeNull();
  });

  test('disposal never disposes the borrowed controller', async () => {
    const s = setup();
    await s.load();
    s.attachment.dispose();
    expect(s.controller.disposals).toBe(0);
    expect(s.controller.emit(bytes(0x41))).toBe(0);
  });

  test('a signal that fires after disposal does nothing', async () => {
    const s = setup();
    const engine = await s.load();
    s.attachment.dispose();
    const before = engine.calls.length;
    window.dispatchEvent(new Event('resize'));
    for (const observer of resizeObservers) observer.notify();
    for (const list of mediaLists) list.change(true);
    s.attachment.refresh();
    expect(engine.calls.length).toBe(before);
  });

  test('works without a controller', async () => {
    const s = setup({ withController: false });
    await s.load();
    expect(s.controller.subscriptions).toBe(0);
    expect(s.attachment.ready).toBe(true);
    s.attachment.dispose();
  });

  test('a replacement attachment owns the controller subscription the old one released', async () => {
    const first = setup();
    await first.load();
    first.attachment.dispose();
    // The same controller, borrowed by a second attachment.
    const second = setup();
    const factory = createFakeFactory();
    const replacement = createTerminalAttachment({
      host: second.host,
      controller: first.controller,
      loadEngine: () => Promise.resolve(factory.factory),
      readSettings: () => defaultSettings,
      onReady: () => {},
      onGeometry: () => {},
      onFailure: () => {},
      onTitle: () => {},
      scheduleFit: second.scheduler.schedule,
    });
    await settle();
    expect(first.controller.subscriptions).toBe(2);
    expect(first.controller.unsubscriptions).toBe(1);
    expect(first.controller.emit(bytes(0x41))).toBe(0);
    factory.created[0]!.engine.acknowledge[0]?.();
    expect(factory.created[0]!.engine.writes).toHaveLength(1);
    // The old engine saw nothing of what the new subscription received.
    expect(first.engine().writes).toHaveLength(0);
    replacement.dispose();
    second.attachment.dispose();
  });
});

describe('output', () => {
  test('writes each chunk to the engine in order and acknowledges it once, at the parse boundary', async () => {
    const s = setup();
    const engine = await s.load();
    const acknowledged: number[] = [];
    const listener = s.controller.everRegistered[0]!;
    listener(bytes(1), () => acknowledged.push(1));
    listener(bytes(2), () => acknowledged.push(2));
    expect(engine.writes.map((chunk) => chunk[0])).toEqual([1, 2]);
    expect(acknowledged).toEqual([]);
    engine.acknowledge[1]!();
    engine.acknowledge[1]!();
    engine.acknowledge[0]!();
    expect(acknowledged).toEqual([2, 1]);
    s.attachment.dispose();
  });

  test('a chunk delivered after disposal is neither written nor acknowledged', async () => {
    const s = setup();
    const engine = await s.load();
    const listener = s.controller.everRegistered[0]!;
    s.attachment.dispose();
    let acknowledged = 0;
    listener(bytes(1), () => (acknowledged += 1));
    expect(engine.writes).toHaveLength(0);
    expect(acknowledged).toBe(0);
  });
});

describe('failing closed', () => {
  test('an import failure disposes nothing it never built, reports once, and tells the controller', async () => {
    const s = setup();
    s.loader.reject(new Error('wasm blocked'));
    await settle();
    expect(s.failures).toEqual([{ phase: 'load', message: 'wasm blocked' }]);
    expect(s.controller.failures).toEqual(s.failures);
    expect(s.factory.created).toHaveLength(0);
    expect(s.controller.subscriptions).toBe(0);
    expect(s.readyCount()).toBe(0);
  });

  test('a non-error import failure still reports a message', async () => {
    const s = setup();
    s.loader.reject('plain text');
    await settle();
    expect(s.failures[0]?.message).toBe('plain text');
  });

  test('a long failure message is bounded', async () => {
    const s = setup();
    s.loader.reject(new Error('x'.repeat(5000)));
    await settle();
    expect(s.failures[0]?.message).toHaveLength(500);
  });

  test('an engine that cannot be constructed fails initialization and leaves nothing behind', async () => {
    const s = setup();
    s.factory.failNext(new Error('constructor threw'));
    s.loader.resolve(s.factory.factory);
    await settle();
    expect(s.failures).toEqual([{ phase: 'initialize', message: 'constructor threw' }]);
    expect(s.controller.subscriptions).toBe(0);
    expect(s.host.querySelector('span')).toBeNull();
    expect(s.attachment.ready).toBe(false);
  });

  test('an engine that cannot mount is disposed, and the controller is told', async () => {
    const s = setup();
    s.loader.resolve((options) => {
      const engine = s.factory.factory(options);
      (engine as FakeEngine).throwOn.mount = new Error('mount threw');
      return engine;
    });
    await settle();
    expect(s.failures).toEqual([{ phase: 'initialize', message: 'mount threw' }]);
    expect(s.engine().calls).toContain('dispose');
    expect(s.controller.failures).toHaveLength(1);
    expect(s.controller.subscriptions).toBe(0);
  });

  test('a write that throws disposes the engine, stops listening, and reports once', async () => {
    const s = setup();
    const engine = await s.load();
    engine.throwOn.write = new Error('parser blew up');
    const listener = s.controller.everRegistered[0]!;
    listener(bytes(1), () => {});
    expect(s.failures).toEqual([{ phase: 'parse', message: 'parser blew up' }]);
    expect(s.controller.failures).toEqual(s.failures);
    expect(engine.calls.filter((call) => call === 'dispose')).toHaveLength(1);
    expect(s.controller.unsubscriptions).toBe(1);
    // Later output is neither written nor replayed into a new engine, and no second failure appears.
    engine.throwOn = {};
    listener(bytes(2), () => {});
    expect(engine.writes).toHaveLength(0);
    expect(s.factory.created).toHaveLength(1);
    expect(s.failures).toHaveLength(1);
  });

  test('a controller that throws while being told still lets the view show the failure', async () => {
    const s = setup();
    const engine = await s.load();
    engine.throwOn.write = new Error('parser blew up');
    s.controller.throwOnFailure = new Error('controller broke');
    expect(() => s.controller.everRegistered[0]!(bytes(1), () => {})).toThrow('controller broke');
    expect(s.failures).toHaveLength(1);
  });

  test('a measurement that throws fails the render', async () => {
    const s = setup();
    const engine = await s.load();
    engine.throwOn.measure = new Error('measure threw');
    s.scheduler.flush();
    expect(s.failures).toEqual([{ phase: 'render', message: 'measure threw' }]);
    expect(s.geometries).toEqual([]);
  });

  test('an engine resize that throws fails the render and reports no geometry', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = { columns: 100, rows: 30 };
    engine.throwOn.resize = new Error('resize threw');
    s.scheduler.flush();
    expect(s.failures).toEqual([{ phase: 'render', message: 'resize threw' }]);
    expect(s.geometries).toEqual([]);
  });

  test('applying settings that throws fails the render', async () => {
    const s = setup();
    const engine = await s.load();
    engine.throwOn.update = new Error('theme rejected');
    s.attachment.refresh();
    expect(s.failures).toEqual([{ phase: 'render', message: 'theme rejected' }]);
  });

  test('a failure after the view recovered by replacement does not touch the new engine', async () => {
    const first = setup();
    const firstEngine = await first.load();
    first.attachment.dispose();
    firstEngine.throwOn.write = new Error('stale');
    first.controller.everRegistered[0]!(bytes(1), () => {});
    expect(first.failures).toEqual([]);
  });
});

describe('fitting', () => {
  test('reports the measured geometry once after the engine mounts, and resizes the engine to it', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = { columns: 100, rows: 30 };
    s.scheduler.flush();
    expect(engine.resizes).toEqual([{ columns: 100, rows: 30 }]);
    expect(s.geometries).toEqual([{ columns: 100, rows: 30 }]);
    s.scheduler.flush();
    expect(s.geometries).toHaveLength(1);
    s.attachment.dispose();
  });

  test('every signal that can change the fit collapses into one measurement per frame', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = { columns: 100, rows: 30 };
    s.scheduler.flush();
    engine.measureCount = 0;
    for (let storm = 0; storm < 200; storm += 1) {
      for (const observer of resizeObservers) observer.notify();
      window.dispatchEvent(new Event('resize'));
    }
    mediaLists.find((list) => list.media.startsWith('(resolution'))?.change(false);
    expect(s.scheduler.pending).toBe(1);
    engine.measurement = { columns: 90, rows: 30 };
    s.scheduler.flush();
    expect(engine.measureCount).toBe(1);
    expect(s.geometries).toEqual([
      { columns: 100, rows: 30 },
      { columns: 90, rows: 30 },
    ]);
    s.attachment.dispose();
  });

  test('a hidden or zero-size container reports nothing, then reports once it is visible', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = undefined;
    s.scheduler.flush();
    expect(s.geometries).toEqual([]);
    expect(engine.resizes).toEqual([]);
    engine.measurement = { columns: 0, rows: 0 };
    window.dispatchEvent(new Event('resize'));
    s.scheduler.flush();
    expect(s.geometries).toEqual([]);
    engine.measurement = { columns: 80, rows: 24 };
    window.dispatchEvent(new Event('resize'));
    s.scheduler.flush();
    expect(s.geometries).toEqual([{ columns: 80, rows: 24 }]);
    s.attachment.dispose();
  });

  test('font loading re-measures the engine and fits again', async () => {
    const fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(() => {}) });
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      const s = setup();
      const engine = await s.load();
      engine.measurement = { columns: 100, rows: 30 };
      s.scheduler.flush();
      engine.measurement = { columns: 96, rows: 30 };
      fonts.dispatchEvent(new Event('loadingdone'));
      expect(engine.calls).toContain('remeasure');
      s.scheduler.flush();
      expect(s.geometries).toEqual([
        { columns: 100, rows: 30 },
        { columns: 96, rows: 30 },
      ]);
      s.attachment.dispose();
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  test('a font re-measure that throws fails the render', async () => {
    const fonts = Object.assign(new EventTarget(), { ready: new Promise<void>(() => {}) });
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      const s = setup();
      const engine = await s.load();
      engine.throwOn.remeasure = new Error('remeasure threw');
      fonts.dispatchEvent(new Event('loadingdone'));
      expect(s.failures).toEqual([{ phase: 'render', message: 'remeasure threw' }]);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  test('a device-pixel-ratio change fits again', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = { columns: 100, rows: 30 };
    s.scheduler.flush();
    engine.measurement = { columns: 110, rows: 33 };
    mediaLists.find((list) => list.media.startsWith('(resolution'))!.change(false);
    s.scheduler.flush();
    expect(s.geometries.at(-1)).toEqual({ columns: 110, rows: 33 });
    s.attachment.dispose();
  });

  test('the initial grid is the engine default until a fit arrives', async () => {
    const s = setup();
    await s.load();
    expect(s.factory.created[0]!.options.geometry).toEqual(INITIAL_GEOMETRY);
    s.attachment.dispose();
  });
});

describe('read-only views', () => {
  test('start from the owner grid and never fit or report geometry', async () => {
    const s = setup({
      settings: { readOnly: true, ownsGrid: false, ownerGeometry: { columns: 132, rows: 43 } },
    });
    const engine = await s.load();
    expect(s.factory.created[0]!.options.geometry).toEqual({ columns: 132, rows: 43 });
    engine.measurement = { columns: 10, rows: 5 };
    s.scheduler.flush();
    window.dispatchEvent(new Event('resize'));
    s.scheduler.flush();
    expect(engine.measureCount).toBe(0);
    expect(s.geometries).toEqual([]);
    expect(engine.resizes).toEqual([]);
    s.attachment.dispose();
  });

  test('adopt a new owner grid without sending anything', async () => {
    const s = setup({
      settings: { readOnly: true, ownsGrid: false, ownerGeometry: { columns: 132, rows: 43 } },
    });
    const engine = await s.load();
    s.settings.ownerGeometry = { columns: 100, rows: 30 };
    s.attachment.refresh();
    expect(engine.resizes).toEqual([{ columns: 100, rows: 30 }]);
    s.attachment.refresh();
    expect(engine.resizes).toHaveLength(1);
    expect(s.geometries).toEqual([]);
    s.attachment.dispose();
  });

  test('keep the grid they have when the owner grid is unknown or invalid', async () => {
    const s = setup({ settings: { readOnly: true, ownsGrid: false } });
    const engine = await s.load();
    s.settings.ownerGeometry = { columns: 0, rows: 30 };
    s.attachment.refresh();
    expect(engine.resizes).toEqual([]);
    expect(s.factory.created[0]!.options.geometry).toEqual(INITIAL_GEOMETRY);
    s.attachment.dispose();
  });

  test('a view that gains authority fits itself and reports its own grid again', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = { columns: 100, rows: 30 };
    s.scheduler.flush();
    s.settings.readOnly = true;
    s.settings.ownsGrid = false;
    s.settings.ownerGeometry = { columns: 132, rows: 43 };
    s.attachment.refresh();
    expect(engine.resizes.at(-1)).toEqual({ columns: 132, rows: 43 });
    s.settings.readOnly = false;
    s.settings.ownsGrid = true;
    s.attachment.refresh();
    s.scheduler.flush();
    expect(engine.resizes.at(-1)).toEqual({ columns: 100, rows: 30 });
    expect(s.geometries).toEqual([
      { columns: 100, rows: 30 },
      { columns: 100, rows: 30 },
    ]);
    s.attachment.dispose();
  });

  test('a fit queued before the view went read-only measures nothing', async () => {
    const s = setup();
    const engine = await s.load();
    engine.measurement = { columns: 100, rows: 30 };
    s.settings.ownsGrid = false;
    s.scheduler.flush();
    expect(s.geometries).toEqual([]);
    expect(engine.measureCount).toBe(0);
    s.attachment.dispose();
  });
});

describe('settings and design tokens', () => {
  test('hands the engine its settings, the font, and the resolved theme at creation', async () => {
    const host = makeHost();
    host.style.setProperty('--cinder-terminal-ansi-red', '#aa0000');
    host.style.setProperty('--cinder-text-default', '#101010');
    host.style.fontFamily = 'Fira Code, monospace';
    host.style.fontSize = '13px';
    const factory = createFakeFactory();
    const attachment = createTerminalAttachment({
      host,
      controller: undefined,
      loadEngine: () => Promise.resolve(factory.factory),
      readSettings: () => ({ ...defaultSettings, ariaLabel: 'Shell', announceOutput: true }),
      onReady: () => {},
      onGeometry: () => {},
      onFailure: () => {},
      onTitle: () => {},
    });
    await settle();
    const { options } = factory.created[0]!;
    expect(options.ariaLabel).toBe('Shell');
    expect(options.announceOutput).toBe(true);
    expect(options.readOnly).toBe(false);
    expect(options.reducedMotion).toBe(false);
    expect(options.fontFamily).toContain('Fira Code');
    expect(options.fontFamily).toContain('monospace');
    expect(options.fontSize).toBe(13);
    expect(options.theme.red).toBe('#aa0000');
    expect(options.theme.foreground).toBe('#101010');
    expect('brightRed' in options.theme).toBe(false);
    attachment.dispose();
  });

  test('forwards program titles to the host', async () => {
    const s = setup();
    await s.load();
    s.factory.created[0]!.options.onTitle?.('build done');
    expect(s.titles).toEqual(['build done']);
    s.attachment.dispose();
  });

  test('reads reduced motion from the media query, and re-applies when it changes', async () => {
    const s = setup();
    const engine = await s.load();
    expect(s.factory.created[0]!.options.reducedMotion).toBe(false);
    const motion = mediaLists.find((list) => list.media === '(prefers-reduced-motion: reduce)')!;
    motion.change(true);
    expect(engine.updates.at(-1)?.reducedMotion).toBe(true);
    s.attachment.dispose();
  });

  test('re-resolves the theme when the color scheme or a data-theme attribute changes', async () => {
    const s = setup();
    const engine = await s.load();
    s.host.style.setProperty('--cinder-surface-inset', '#111111');
    mediaLists.find((list) => list.media === '(prefers-color-scheme: dark)')!.change(true);
    expect(engine.updates.at(-1)?.theme.background).toBe('#111111');
    s.host.style.setProperty('--cinder-surface-inset', '#222222');
    document.documentElement.setAttribute('data-theme', 'dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.documentElement.removeAttribute('data-theme');
    expect(engine.updates.at(-1)?.theme.background).toBe('#222222');
    s.attachment.dispose();
  });

  test('refresh pushes new settings and link activation to the live engine', async () => {
    const s = setup();
    const engine = await s.load();
    const activate = () => {};
    s.settings.ariaLabel = 'Renamed';
    s.settings.announceOutput = true;
    s.settings.activateLink = activate;
    s.attachment.refresh();
    expect(engine.updates.at(-1)).toMatchObject({ ariaLabel: 'Renamed', announceOutput: true });
    expect(engine.linkActivations.at(-1)).toBe(activate);
    s.attachment.dispose();
  });

  test('refresh before the engine exists does nothing', () => {
    const s = setup();
    s.attachment.refresh();
    expect(s.factory.created).toHaveLength(0);
    s.attachment.dispose();
  });
});

describe('reading state', () => {
  test('delegates following and the retained projection to the live engine only', async () => {
    const s = setup();
    expect(s.attachment.following).toBe(true);
    expect(s.attachment.readProjection()).toBeUndefined();
    const engine = await s.load();
    engine.following = false;
    expect(s.attachment.following).toBe(false);
    expect(s.attachment.readProjection(99)?.bytes).toBe(99);
    s.attachment.dispose();
    expect(s.attachment.readProjection()).toBeUndefined();
    expect(s.attachment.following).toBe(true);
  });
});
