/**
 * The storage sizes the engine has reported in the last 24 hours, for the Storage use card. The
 * engine reports its size when it tidies up (`storage:size-reported` on the fleet feed), and the
 * feed replays what it still holds when the page connects, so the samples are what this page has
 * seen, never a history the server keeps. A card with fewer than two of them draws no chart.
 */
import { getFleetEventSource, hasFleetEventSource } from '../../app/engine-status.svelte.ts';
import type { FleetEventFrame } from '../../lib/live-source/fleet-event-source.svelte.ts';
import { OVERVIEW_WINDOW_MS } from './health-overview-data.ts';

/** One reported size. */
export interface StorageSample {
  /** When it was reported, in epoch milliseconds. */
  readonly at: number;
  readonly bytes: number;
}

/** The sample a frame carries, or `undefined` for a frame that is not a size report. */
export function sampleOf(
  frame: Pick<FleetEventFrame, 'kind' | 'emittedAtMs' | 'payload'>,
): StorageSample | undefined {
  if (frame.kind !== 'storage:size-reported') return undefined;
  const payload = frame.payload;
  if (typeof payload !== 'object' || payload === null || !('sizeBytes' in payload))
    return undefined;
  const bytes = payload.sizeBytes;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
    ? { at: frame.emittedAtMs, bytes }
    : undefined;
}

/** The samples inside the window ending at `now`, oldest first and one per moment. */
export function withinWindow(
  samples: readonly StorageSample[],
  now: number,
): readonly StorageSample[] {
  const seen = new Set<number>();
  return samples
    .filter(
      (sample) =>
        now - sample.at <= OVERVIEW_WINDOW_MS && !seen.has(sample.at) && seen.add(sample.at),
    )
    .toSorted((left, right) => left.at - right.at);
}

/** The storage sizes this page has seen, oldest first. Call it while a component initializes. */
export function useStorageSizes(): { readonly samples: () => readonly StorageSample[] } {
  let samples = $state<readonly StorageSample[]>([]);
  const source = hasFleetEventSource() ? getFleetEventSource() : undefined;
  $effect(() => {
    if (source === undefined) return undefined;
    // One write for what the feed already holds: reading `samples` while writing it here would
    // make this effect its own dependency.
    samples = source.recent().flatMap((frame) => sampleOf(frame) ?? []);
    const collect = (frame: FleetEventFrame): void => {
      const sample = sampleOf(frame);
      if (sample !== undefined) samples = [...samples, sample];
    };
    return source.subscribe(collect, { kind: 'storage:size-reported' });
  });
  return { samples: () => withinWindow(samples, Date.now()) };
}
