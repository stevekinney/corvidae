import {
  INITIAL_GEOMETRY,
  type EngineSettings,
  type RendererEngine,
  type RendererEngineFactory,
} from './terminal-engine-adapter.ts';
import {
  createFitCoordinator,
  sameGeometry,
  validateGeometry,
  type FitCoordinator,
  type FitScheduler,
} from './terminal-fit.ts';
import {
  watchDevicePixelRatio,
  watchElementSize,
  watchFontLoading,
  watchMediaQuery,
  watchThemeAttribute,
  watchWindowResize,
  type MediaQueryWatch,
  type Unwatch,
} from './terminal-observers.ts';
import type { TerminalProjection } from './terminal-projection.ts';
import { createElementColorResolver, resolveEngineTheme } from './terminal-theme.ts';
import type {
  TerminalGeometry,
  TerminalRendererController,
  TerminalRendererFailure,
  TerminalRendererFailurePhase,
} from './terminal.types.ts';

/** What the component feeds the attachment, read again whenever it changes. */
export type AttachmentSettings = {
  /** A view that takes no input also sends no automatic terminal query replies. */
  readOnly: boolean;
  /**
   * Whether this view fits itself to its viewport and reports the grid it measured. A view that
   * does not own the grid keeps the owner's, scrolling locally, and never reports geometry.
   */
  ownsGrid: boolean;
  ownerGeometry: TerminalGeometry | undefined;
  announceOutput: boolean;
  ariaLabel: string;
  /** Present only when the host opted in to links. */
  activateLink: ((url: string) => void) | undefined;
};

export type AttachmentOptions = {
  /** The element the engine renders into. */
  host: HTMLElement;
  /** The controller whose output is rendered. Borrowed: never disposed here. */
  controller: TerminalRendererController | undefined;
  /** Imports the engine. It may resolve after the attachment was disposed; that result is dropped. */
  loadEngine: () => Promise<RendererEngineFactory>;
  readSettings: () => AttachmentSettings;
  /** The engine is mounted and subscribed. Called at most once. */
  onReady: () => void;
  /** The engine's measured geometry changed. Never called for a read-only view. */
  onGeometry: (geometry: TerminalGeometry) => void;
  /** The renderer failed closed. Called at most once, after the engine was disposed. */
  onFailure: (failure: TerminalRendererFailure) => void;
  onTitle: (title: string) => void;
  scheduleFit?: FitScheduler;
};

export type TerminalAttachment = {
  /** Re-read the settings and the design tokens and apply them to the live engine. */
  refresh(): void;
  /** No more output will arrive: the engine parses any unicode prefix it was holding. */
  finishOutput(): void;
  /** Whether the engine is mounted and neither failed nor disposed. */
  readonly ready: boolean;
  /** Whether the viewport follows new output, because it shows the live bottom. */
  readonly following: boolean;
  /** A bounded projection of the active retained buffer, or `undefined` with no live engine. */
  readProjection(maximumBytes?: number): TerminalProjection | undefined;
  /** Release the engine, listeners, observers, scheduled work, and the output subscription. */
  dispose(): void;
};

const MAXIMUM_FAILURE_MESSAGE_LENGTH = 500;

function describeCause(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, MAXIMUM_FAILURE_MESSAGE_LENGTH);
}

function readFont(host: HTMLElement): { fontFamily?: string; fontSize?: number } {
  const style = host.ownerDocument.defaultView?.getComputedStyle(host);
  const fontFamily = style?.fontFamily ? style.fontFamily : undefined;
  const size = Number.parseFloat(style?.fontSize ?? '');
  return {
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(Number.isFinite(size) && size > 0 ? { fontSize: size } : {}),
  };
}

/**
 * Owns everything one mounted terminal needs and releases all of it exactly once: the dynamically
 * imported engine, its listeners and observers, scheduled fits, and the subscription to the
 * controller's output. Failing closed is part of that ownership: a load, initialization, parse, or
 * render failure disposes the engine and reports once. It never switches engines, resets silently,
 * drops bytes and carries on, or replays anything.
 */
export function createTerminalAttachment(options: AttachmentOptions): TerminalAttachment {
  let disposed = false;
  let failed = false;
  let ready = false;
  let engine: RendererEngine | undefined;
  let fit: FitCoordinator | undefined;
  let unsubscribe: (() => void) | undefined;
  let unwatchers: Unwatch[] = [];
  let reducedMotion: MediaQueryWatch | undefined;
  let resolver: ReturnType<typeof createElementColorResolver> | undefined;

  function release(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    for (const unwatch of unwatchers) unwatch();
    unwatchers = [];
    reducedMotion?.dispose();
    reducedMotion = undefined;
    fit?.dispose();
    fit = undefined;
    resolver?.dispose();
    resolver = undefined;
    engine?.dispose();
    engine = undefined;
    ready = false;
  }

  function fail(phase: TerminalRendererFailurePhase, cause: unknown): void {
    if (disposed || failed) return;
    failed = true;
    release();
    const failure: TerminalRendererFailure = { phase, message: describeCause(cause) };
    try {
      options.onFailure(failure);
    } finally {
      options.controller?.rendererFailed(failure);
    }
  }

  function guarded(phase: TerminalRendererFailurePhase, action: () => void): void {
    try {
      action();
    } catch (cause) {
      fail(phase, cause);
    }
  }

  function engineSettings(): EngineSettings {
    const settings = options.readSettings();
    return {
      readOnly: settings.readOnly,
      announceOutput: settings.announceOutput,
      ariaLabel: settings.ariaLabel,
      reducedMotion: reducedMotion?.matches() ?? false,
      theme: resolver === undefined ? {} : resolveEngineTheme(resolver.resolve),
    };
  }

  /** A view that does not own the grid adopts the owner's; it never measures itself or reports. */
  function adoptOwnerGeometry(): void {
    const owner = validateGeometry(options.readSettings().ownerGeometry);
    if (engine === undefined || owner === undefined || sameGeometry(owner, engine.geometry)) return;
    engine.resize(owner);
    fit?.invalidate();
  }

  function requestFit(): void {
    if (engine === undefined) return;
    if (options.readSettings().ownsGrid) fit?.request();
    else guarded('render', adoptOwnerGeometry);
  }

  function refresh(): void {
    guarded('render', () => {
      if (engine === undefined) return;
      engine.update(engineSettings());
      engine.setLinkActivation(options.readSettings().activateLink);
      requestFit();
    });
  }

  function subscribe(controller: TerminalRendererController): void {
    // A controller may replay buffered output synchronously, before it returns the handle. That
    // replay can fail or dispose this attachment, and `release` would then find no handle to call,
    // so the handle is kept locally and released here when the attachment is already over.
    const handle = controller.subscribeOutput((chunk, parsed) => {
      // Output that arrives after the engine was released is not written and not acknowledged.
      const live = engine;
      if (live === undefined) return;
      let acknowledged = false;
      guarded('parse', () =>
        live.write(chunk, () => {
          if (acknowledged) return;
          acknowledged = true;
          parsed();
        }),
      );
    });
    if (disposed || failed) handle();
    else unsubscribe = handle;
  }

  function initialize(createEngine: RendererEngineFactory): void {
    const settings = options.readSettings();
    reducedMotion = watchMediaQuery('(prefers-reduced-motion: reduce)', refresh);
    resolver = createElementColorResolver(options.host);
    const created = createEngine({
      ...engineSettings(),
      ...readFont(options.host),
      geometry: validateGeometry(settings.ownerGeometry) ?? INITIAL_GEOMETRY,
      // The engine calls this from inside its parser, so a throwing host handler fails closed.
      onTitle: (title) => guarded('parse', () => options.onTitle(title)),
    });
    engine = created;
    created.mount(options.host);
    created.setLinkActivation(settings.activateLink);
    fit = createFitCoordinator({
      ...(options.scheduleFit === undefined ? {} : { schedule: options.scheduleFit }),
      measure: () => {
        if (engine === undefined || !options.readSettings().ownsGrid) return undefined;
        try {
          return engine.measure();
        } catch (cause) {
          fail('render', cause);
          return undefined;
        }
      },
      apply: (geometry) => guarded('render', () => engine?.resize(geometry)),
      accept: (geometry) => {
        if (engine !== undefined) guarded('render', () => options.onGeometry(geometry));
      },
    });
    const colorScheme = watchMediaQuery('(prefers-color-scheme: dark)', refresh);
    unwatchers.push(colorScheme.dispose);
    unwatchers.push(watchElementSize(options.host, requestFit));
    unwatchers.push(watchWindowResize(requestFit));
    unwatchers.push(watchDevicePixelRatio(requestFit));
    unwatchers.push(
      watchFontLoading(() => {
        guarded('render', () => engine?.remeasure());
        requestFit();
      }),
    );
    unwatchers.push(watchThemeAttribute(refresh));
    if (options.controller !== undefined) subscribe(options.controller);
    // Replay can fail or dispose the attachment; neither is a ready engine.
    if (disposed || failed) return;
    ready = true;
    requestFit();
    options.onReady();
  }

  async function start(): Promise<void> {
    let createEngine: RendererEngineFactory;
    try {
      createEngine = await options.loadEngine();
    } catch (cause) {
      fail('load', cause);
      return;
    }
    if (disposed) return;
    guarded('initialize', () => initialize(createEngine));
  }

  // A failure is reported through `onFailure` and the controller, never as a rejection. A
  // controller that throws while being told does reject, and that stays loud.
  void start();

  return {
    refresh,
    finishOutput() {
      guarded('parse', () => engine?.finishOutput());
    },
    get ready() {
      return ready;
    },
    get following() {
      return engine?.following ?? true;
    },
    readProjection: (maximumBytes) => engine?.readProjection(maximumBytes),
    dispose() {
      disposed = true;
      release();
    },
  };
}
