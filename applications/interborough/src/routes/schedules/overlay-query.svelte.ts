/**
 * The schedule overlay (`overlay-query.ts`) as a page reads it, with the shell's connection folded
 * in. While the server does not answer, the shell says so once, in its own banner, and the page
 * keeps the schedules it already shows. The overlay is read again with everything else, and a read
 * that failed because the server is gone would replace what each schedule is with "failed", which
 * lists the schedules without their agents and, under a second error, says the same thing twice. So
 * the last overlay the Bureau answered stays in place while the server is unreachable, and its
 * failure is not drawn as a second error surface.
 */
import { createQuery } from '@tanstack/svelte-query';

import type { HttpClient } from '@lostgradient/weft';

import type { ConnectionMonitor } from '../../app/connection.svelte.ts';
import type { ScheduleOverlay } from '../../lib/schedule-kinds.ts';
import { scheduleOverlayOptions } from './overlay-query.ts';

/** What a page reads of the overlay. */
export type ScheduleOverlayReading = {
  /** The overlay the page draws from: the last good one while the server is unreachable. */
  readonly data: ScheduleOverlay | undefined;
  /** Whether the Bureau's failure is the page's to say: it is, unless the shell already says the server is gone. */
  readonly failed: boolean;
  /** Reads the overlay again. */
  readonly refetch: () => void;
};

/** Reads the overlay, and keeps the last one the Bureau answered while the server is unreachable. */
export function useScheduleOverlay(
  client: HttpClient,
  connection: Pick<ConnectionMonitor, 'unreachable'>,
): ScheduleOverlayReading {
  const query = createQuery(() => scheduleOverlayOptions(client));
  let lastGood = $state.raw<ScheduleOverlay | undefined>(undefined);
  $effect.pre(() => {
    const data = query.data;
    if (data !== undefined && !data.failed) lastGood = data;
  });
  const data = $derived(
    query.data?.failed === true && connection.unreachable && lastGood !== undefined
      ? lastGood
      : query.data,
  );
  return {
    get data() {
      return data;
    },
    get failed() {
      return data?.failed === true && !connection.unreachable;
    },
    refetch: () => void query.refetch(),
  };
}
