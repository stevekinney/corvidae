import type { AttachmentSettings } from './terminal-attachment.ts';
import type {
  EngineCreateOptions,
  EngineSettings,
  RendererEngine,
  RendererEngineFactory,
} from './terminal-engine-adapter.ts';
import type { FitScheduler } from './terminal-fit.ts';
import type {
  TerminalGeometry,
  TerminalOutputListener,
  TerminalRendererController,
  TerminalRendererFailure,
} from './terminal.types.ts';

export type Deferred<T> = PromiseWithResolvers<T>;

export function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

/** Everything the attachment asked of a fake engine, in order. */
export type FakeEngine = RendererEngine & {
  calls: string[];
  writes: Uint8Array[];
  acknowledge: Array<() => void>;
  resizes: TerminalGeometry[];
  updates: EngineSettings[];
  linkActivations: Array<((url: string) => void) | undefined>;
  measurement: { columns: number; rows: number } | undefined;
  measureCount: number;
  throwOn: Partial<
    Record<'write' | 'measure' | 'update' | 'remeasure' | 'resize' | 'mount', Error>
  >;
  following: boolean;
};

export function createFakeEngine(initial: EngineCreateOptions): FakeEngine {
  let geometry: TerminalGeometry = { ...initial.geometry };
  const engine: FakeEngine = {
    calls: [],
    writes: [],
    acknowledge: [],
    resizes: [],
    updates: [],
    linkActivations: [],
    measurement: undefined,
    measureCount: 0,
    throwOn: {},
    following: true,
    mount() {
      engine.calls.push('mount');
      if (engine.throwOn.mount) throw engine.throwOn.mount;
    },
    write(chunk, parsed) {
      engine.calls.push('write');
      if (engine.throwOn.write) throw engine.throwOn.write;
      engine.writes.push(chunk);
      engine.acknowledge.push(parsed);
    },
    finishOutput() {
      engine.calls.push('finishOutput');
    },
    resize(next) {
      engine.calls.push('resize');
      if (engine.throwOn.resize) throw engine.throwOn.resize;
      geometry = { ...next };
      engine.resizes.push(next);
    },
    measure() {
      engine.calls.push('measure');
      engine.measureCount += 1;
      if (engine.throwOn.measure) throw engine.throwOn.measure;
      return engine.measurement;
    },
    get geometry() {
      return geometry;
    },
    update(settings) {
      engine.calls.push('update');
      if (engine.throwOn.update) throw engine.throwOn.update;
      engine.updates.push(settings);
    },
    remeasure() {
      engine.calls.push('remeasure');
      if (engine.throwOn.remeasure) throw engine.throwOn.remeasure;
    },
    setLinkActivation(activate) {
      engine.calls.push('setLinkActivation');
      engine.linkActivations.push(activate);
    },
    readProjection(maximumBytes) {
      engine.calls.push('readProjection');
      return { text: 'projection', truncated: false, bytes: maximumBytes ?? 10 };
    },
    dispose() {
      engine.calls.push('dispose');
    },
  };
  return engine;
}

/** A factory that records what it was asked to build and hands back fake engines. */
export function createFakeFactory() {
  const created: Array<{ options: EngineCreateOptions; engine: FakeEngine }> = [];
  let failure: Error | undefined;
  const factory: RendererEngineFactory = (options) => {
    if (failure) throw failure;
    const engine = createFakeEngine(options);
    created.push({ options, engine });
    return engine;
  };
  return {
    factory,
    created,
    failNext(error: Error) {
      failure = error;
    },
  };
}

export type FakeController = TerminalRendererController & {
  subscriptions: number;
  unsubscriptions: number;
  failures: TerminalRendererFailure[];
  disposals: number;
  /** Deliver a chunk to every live listener, returning how many acknowledgements came back. */
  emit(chunk: Uint8Array): number;
  /** Listeners the renderer registered, including ones it has since unsubscribed. */
  everRegistered: TerminalOutputListener[];
  throwOnFailure?: Error;
  dispose(): void;
};

export function createFakeController(): FakeController {
  const live = new Set<TerminalOutputListener>();
  const controller: FakeController = {
    subscriptions: 0,
    unsubscriptions: 0,
    failures: [],
    disposals: 0,
    everRegistered: [],
    subscribeOutput(listener) {
      controller.subscriptions += 1;
      controller.everRegistered.push(listener);
      live.add(listener);
      return () => {
        controller.unsubscriptions += 1;
        live.delete(listener);
      };
    },
    rendererFailed(failure) {
      controller.failures.push(failure);
      if (controller.throwOnFailure) throw controller.throwOnFailure;
    },
    emit(chunk) {
      let acknowledged = 0;
      for (const listener of live) listener(chunk, () => (acknowledged += 1));
      return acknowledged;
    },
    dispose() {
      controller.disposals += 1;
    },
  };
  return controller;
}

/** A fit scheduler whose pending frame runs only when the test says so. */
export function createManualScheduler() {
  const pending: Array<() => void> = [];
  const schedule: FitScheduler = (callback) => {
    pending.push(callback);
    return () => {
      const index = pending.indexOf(callback);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  return {
    schedule,
    flush() {
      for (const callback of pending.splice(0)) callback();
    },
    get pending() {
      return pending.length;
    },
  };
}

export const defaultSettings: AttachmentSettings = {
  readOnly: false,
  ownsGrid: true,
  ownerGeometry: undefined,
  announceOutput: false,
  ariaLabel: 'Terminal',
  activateLink: undefined,
};
