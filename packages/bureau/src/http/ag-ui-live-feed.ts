import type { ServerFrame } from '../types.ts';

type LiveFrame = {
  readonly frame: ServerFrame;
  readonly sequence: number;
  readonly cursor: string;
};

export type AgUiLiveSubscription = {
  readonly opening: ReadonlyArray<LiveFrame>;
  readonly resumed: boolean;
  readonly unsubscribe: () => void;
};

export type AgUiLiveFeed = {
  readonly subscribe: (
    listener: (frame: LiveFrame) => void,
    resumeCursor?: string,
  ) => AgUiLiveSubscription;
  readonly dispose: () => void;
};

export type AgUiLiveFeedRegistry = {
  readonly forRun: (nativeRunId: string) => AgUiLiveFeed;
  readonly dispose: () => void;
};

function encode(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function cursorOf(nativeRunId: string, epoch: string, sequence: number): string {
  return `agui-live-v1.${encode(nativeRunId)}.${encode(epoch)}.${sequence}`;
}

function decode(value: string): string | undefined {
  try {
    return atob(
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4),
    );
  } catch {
    return undefined;
  }
}

function createFeed(
  nativeRunId: string,
  epoch: string,
  retain: number,
  subscribeFrames: (listener: (frame: ServerFrame) => void) => () => void,
  onDispose: () => void,
): AgUiLiveFeed {
  let sequence = 0;
  let disposed = false;
  const retained: LiveFrame[] = [];
  const listeners = new Set<(frame: LiveFrame) => void>();
  const unsubscribeFrames = subscribeFrames((frame) => {
    if (disposed || !('runId' in frame) || frame.runId !== nativeRunId) return;
    if (frame.type !== 'event' && frame.type !== 'stream:text-delta') return;
    const live = { frame, sequence: ++sequence, cursor: cursorOf(nativeRunId, epoch, sequence) };
    retained.push(live);
    while (retained.length > retain) retained.shift();
    for (const listener of listeners) listener(live);
  });

  return {
    subscribe(listener, resumeCursor?: string) {
      if (disposed) return { opening: [], resumed: false, unsubscribe: () => undefined };
      listeners.add(listener);
      const parts = resumeCursor?.split('.') ?? [];
      const native =
        parts.length === 4 && parts[0] === 'agui-live-v1' ? decode(parts[1]!) : undefined;
      const cursorEpoch =
        parts.length === 4 && parts[0] === 'agui-live-v1' ? decode(parts[2]!) : undefined;
      const requested =
        parts.length === 4 && /^\d+$/.test(parts[3] ?? '') ? Number(parts[3]) : undefined;
      const floor = retained[0]?.sequence ?? sequence + 1;
      const resumed =
        native === nativeRunId &&
        cursorEpoch === epoch &&
        requested !== undefined &&
        requested >= floor - 1 &&
        requested <= sequence;
      return {
        opening: resumed ? retained.filter((item) => item.sequence > requested) : retained.slice(),
        resumed,
        unsubscribe: () => listeners.delete(listener),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeFrames();
      listeners.clear();
      retained.length = 0;
      onDispose();
    },
  };
}

export function createAgUiLiveFeedRegistry(
  frames: (listener: (frame: ServerFrame) => void) => () => void,
  retain: number,
): AgUiLiveFeedRegistry {
  const epoch = crypto.randomUUID();
  const feeds = new Map<string, AgUiLiveFeed>();
  return {
    forRun(nativeRunId) {
      const existing = feeds.get(nativeRunId);
      if (existing !== undefined) return existing;
      const feed = createFeed(nativeRunId, epoch, retain, frames, () => {
        feeds.delete(nativeRunId);
      });
      feeds.set(nativeRunId, feed);
      return feed;
    },
    dispose() {
      for (const feed of feeds.values()) feed.dispose();
      feeds.clear();
    },
  };
}
