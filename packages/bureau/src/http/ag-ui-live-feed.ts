import { type Event, EventType } from '@ag-ui/core';

import type { RunEventRecord, ServerFrame } from '../types.ts';
import { RunProjector, type NativeTerminal, type Projection } from './ag-ui-projection.ts';
import type { EventStamp } from './ag-ui-vocabulary.ts';

export type AgUiLiveEnvelope = {
  readonly event: Event;
  readonly sequence: number;
  readonly cursor: string;
};

export type AgUiLiveUpdate =
  | { readonly envelope: AgUiLiveEnvelope }
  | { readonly terminal: NativeTerminal }
  | { readonly parked: true }
  | { readonly removed: true };

export type AgUiLiveSubscription = {
  readonly opening: ReadonlyArray<{ readonly event: Event; readonly cursor?: string }>;
  readonly cursor: string;
  readonly snapshotRequired: boolean;
  readonly resumed: boolean;
  readonly removed: boolean;
  readonly terminal: NativeTerminal | undefined;
  readonly unsubscribe: () => void;
};

export type AgUiLiveFeed = {
  readonly subscribe: (
    listener: (update: AgUiLiveUpdate) => void,
    resumeCursor: string | undefined,
    held?: ReadonlySet<string>,
    beginning?: boolean,
  ) => AgUiLiveSubscription;
  readonly closeOpen: () => Event[];
  readonly reserve: () => () => void;
  readonly dispose: () => void;
};

export type AgUiLiveFeedRegistry = {
  readonly forRun: (
    nativeRunId: string,
    context: EventStamp,
    recorded: () => ReadonlyArray<RunEventRecord>,
  ) => AgUiLiveFeed;
  readonly remove: (nativeRunId: string) => void;
  readonly dispose: () => void;
};

function encode(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function createFeed(
  nativeRunId: string,
  epoch: string,
  retain: number,
  subscribeFrames: (listener: (frame: ServerFrame) => void) => () => void,
  context: EventStamp,
  recorded: () => ReadonlyArray<RunEventRecord>,
  onDispose: () => void,
  committedRows: () => Promise<ReadonlySet<string> | undefined>,
): AgUiLiveFeed {
  const prefix = `agui-live-v1.${encode(nativeRunId)}.${encode(epoch)}.`;
  const projector = new RunProjector(nativeRunId, context);
  const retained: AgUiLiveEnvelope[] = [];
  const listeners = new Set<(update: AgUiLiveUpdate) => void>();
  let sequence = 0;
  let highestRecorded = -1;
  let bootstrapping = true;
  const buffered: ServerFrame[] = [];
  let terminal: NativeTerminal | undefined;
  let disposed = false;
  let settlementStarted = false;
  let terminalRecorded = false;
  let reservations = 0;
  const emit = (update: AgUiLiveUpdate): void => {
    // A listener may synchronously attach another reader. That reader's cut
    // already includes this update, so it must not also receive it as tail.
    const currentListeners = Array.from(listeners);
    for (const listener of currentListeners) listener(update);
  };
  const append = (event: Event): AgUiLiveEnvelope => {
    const envelope = Object.freeze({
      event: structuredClone(event),
      sequence: ++sequence,
      cursor: `${prefix}${sequence}`,
    });
    retained.push(envelope);
    if (retained.length > retain) retained.shift();
    return envelope;
  };
  const project = (projection: Projection): void => {
    const envelopes = projection.events.map(append);
    if (projection.terminal !== undefined) {
      envelopes.push(...projector.closeOpen().map(append));
      terminal = projection.terminal;
    }
    // Publish only after the whole source transition has committed its checkpoint
    // and output suffix, including when a listener attaches reentrantly.
    for (const envelope of envelopes) emit({ envelope });
    if (terminal !== undefined) {
      emit({ terminal });
      if (!bootstrapping) startSettlement();
    } else if (projection.parked) emit({ parked: true });
  };
  const process = (frame: ServerFrame): void => {
    if (disposed || terminal !== undefined || !('runId' in frame) || frame.runId !== nativeRunId)
      return;
    if (frame.type === 'event') {
      if (frame.sequence <= highestRecorded) return;
      highestRecorded = frame.sequence;
      project(projector.handleRecorded(frame.event, frame.detail));
    } else if (frame.type === 'stream:text-delta') {
      project(projector.handleTextDelta(frame.content, frame.accumulated));
    }
  };
  const unsubscribeFrames = subscribeFrames((frame) => {
    if (bootstrapping) buffered.push(frame);
    else process(frame);
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeFrames();
    emit({ removed: true });
    listeners.clear();
    retained.length = 0;
    onDispose();
  };
  const releaseTerminal = (): void => {
    if (terminalRecorded && listeners.size === 0 && reservations === 0) dispose();
  };
  const startSettlement = (): void => {
    if (settlementStarted) return;
    settlementStarted = true;
    // Native terminal notifications precede the asynchronous session save. Keep
    // recovery state until the actual save barrier and authoritative rows agree.
    void committedRows().then(
      (held) => {
        if (disposed || held === undefined) return;
        terminalRecorded = projector
          .snapshot(held)
          .every(
            (event) =>
              event.type === EventType.STEP_STARTED || event.type === EventType.STEP_FINISHED,
          );
        releaseTerminal();
        return undefined;
      },
      () => {
        // Abandoned ownership or a failed read cannot acknowledge persistence.
        // The checkpoint remains recoverable until removal or mount disposal.
      },
    );
  };
  // Reading the local detail and projecting it are synchronous. Source callbacks
  // caused by that read are held until its history has established the fence.
  for (const event of recorded()) {
    if (event.sequence <= highestRecorded) continue;
    highestRecorded = event.sequence;
    project(projector.handleRecorded(event.event, event.detail));
  }
  for (const frame of buffered) process(frame);
  buffered.length = 0;
  bootstrapping = false;

  if (terminal !== undefined) startSettlement();
  return {
    subscribe(listener, resumeCursor, held = new Set(), beginning = false) {
      const cut = sequence;
      const terminalAtCut = terminal;
      const tail = (update: AgUiLiveUpdate): void => {
        if ('envelope' in update && update.envelope.sequence <= cut) return;
        if ('terminal' in update && terminalAtCut !== undefined) return;
        listener(update);
      };
      listeners.add(tail);
      const suffix = resumeCursor?.startsWith(prefix) ? resumeCursor.slice(prefix.length) : '';
      const requested = /^(0|[1-9]\d*)$/.test(suffix) ? Number(suffix) : NaN;
      const floor = retained[0]?.sequence ?? sequence + 1;
      const resumed =
        !disposed &&
        Number.isSafeInteger(requested) &&
        requested >= floor - 1 &&
        requested <= sequence;
      const cursor = `${prefix}${sequence}`;
      const checkpoint = projector.snapshot(held);
      return {
        resumed,
        removed: disposed,
        cursor,
        snapshotRequired: !resumed && (!beginning || floor > 1),
        terminal,
        opening: resumed
          ? retained.filter((item) => item.sequence > requested)
          : beginning && floor === 1
            ? retained.slice()
            : checkpoint.map((event, index) => ({
                event,
                ...(index === checkpoint.length - 1 ? { cursor } : {}),
              })),
        unsubscribe() {
          listeners.delete(tail);
          releaseTerminal();
        },
      };
    },
    reserve() {
      reservations += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reservations -= 1;
        releaseTerminal();
      };
    },
    closeOpen: () => projector.closeOpen(true),
    dispose,
  };
}

/** A mount owns one projection and one source subscription per active native run. */
export function createAgUiLiveFeedRegistry(
  frames: (listener: (frame: ServerFrame) => void) => () => void,
  retain: number,
  committedRows: (
    nativeRunId: string,
    sessionId: string | undefined,
  ) => Promise<ReadonlySet<string> | undefined>,
): AgUiLiveFeedRegistry {
  const epoch = crypto.randomUUID();
  const feeds = new Map<string, AgUiLiveFeed>();
  return {
    forRun(nativeRunId, context, recorded) {
      const existing = feeds.get(nativeRunId);
      if (existing !== undefined) return existing;
      const feed = createFeed(
        nativeRunId,
        epoch,
        retain,
        frames,
        context,
        recorded,
        () => {
          feeds.delete(nativeRunId);
        },
        () => committedRows(nativeRunId, context.sessionId),
      );
      feeds.set(nativeRunId, feed);
      return feed;
    },
    remove(nativeRunId) {
      feeds.get(nativeRunId)?.dispose();
    },
    dispose() {
      for (const feed of feeds.values()) feed.dispose();
      feeds.clear();
    },
  };
}
