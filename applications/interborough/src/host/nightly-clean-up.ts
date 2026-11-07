/**
 * The host's nightly clean-up (COR-2009): every night at 3:00 AM in the host's time zone it removes
 * the records past their retention window (`bureau.removeExpiredRecords`), which the Bureau then
 * leaves to it (`expiredRecords: 'on-request'`). Settings › Data and retention reads
 * `GET /host/clean-up` for the time, the zone, the last clean-up and a night the host was off for,
 * and "Clean up now" is `POST /host/clean-up`, which answers what it removed.
 *
 * The last clean-up is kept in storage, so it survives a restart. A night the host was off for is
 * skipped, not made up at the next start: the next clean-up is the next 3:00 AM, or a person's
 * "Clean up now".
 *
 * @module nightly-clean-up
 */

import type { ExpiredRecordKind, ExpiredRecordRemoval } from '@lostgradient/bureau';
import type { Storage } from '@lostgradient/storage';
import { z } from 'zod';

/** The route of the clean-up: `GET` reports {@link HostCleanUpStanding}, `POST` cleans up now. */
export const HOST_CLEAN_UP_ROUTE = '/host/clean-up';

/** The hour of the night the host cleans up, on a 24-hour clock in its time zone. */
export const CLEAN_UP_HOUR = 3;

/** The minute past {@link CLEAN_UP_HOUR} the host cleans up. */
export const CLEAN_UP_MINUTE = 0;

/** The storage key the last clean-up is kept under. */
export const CLEAN_UP_RECORD_KEY = 'interborough-clean-up:last';

/** What started a clean-up: the nightly timer, or a person's "Clean up now". */
export type HostCleanUpTrigger = 'nightly' | 'manual';

/** One clean-up the host ran. */
export type HostCleanUpRun = {
  /** When it ran (ISO 8601). */
  readonly at: string;
  /** What started it. */
  readonly trigger: HostCleanUpTrigger;
  /** How many records it removed, every kind together. */
  readonly removed: number;
  /** How many records of each kind it removed. */
  readonly byKind: Readonly<Record<ExpiredRecordKind, number>>;
  /** The kinds whose removal failed; empty when every kind ran. */
  readonly failed: readonly ExpiredRecordKind[];
};

/** What `GET /host/clean-up` answers. */
export type HostCleanUpStanding = {
  /** When the host cleans up: the hour and minute of every night, in `timeZone`. */
  readonly schedule: {
    /** The hour, on a 24-hour clock. */
    readonly hour: number;
    /** The minute past the hour. */
    readonly minute: number;
    /** The IANA time zone the hour is in, such as `America/Chicago`. */
    readonly timeZone: string;
  };
  /** The last clean-up, nightly or by hand, or `null` before the first. */
  readonly last: HostCleanUpRun | null;
  /**
   * The latest nightly time the host was off for, when no clean-up has run since it (ISO 8601), or
   * `null`. It is `null` before the first clean-up, because a host that never cleaned up skipped
   * nothing.
   */
  readonly skipped: { readonly at: string } | null;
  /** When the next nightly clean-up runs (ISO 8601). */
  readonly nextAt: string;
};

/** What the host's clean-up needs from the host. */
export type NightlyCleanUpOptions = {
  /** Where the last clean-up is kept. */
  readonly storage: Storage;
  /** Removes the expired records: `bureau.removeExpiredRecords`. */
  readonly removeExpiredRecords: () => Promise<ExpiredRecordRemoval>;
  /** The IANA time zone the nightly time is in. Defaults to the process's. */
  readonly timeZone?: string;
  /** The clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Where a clean-up that failed is reported. */
  readonly warn: (message: string) => void;
};

/** The running clean-up: its standing, a clean-up by hand, and how to stop the timer. */
export type NightlyCleanUp = {
  /** The schedule, the last clean-up, a skipped night and the next time. */
  standing(): Promise<HostCleanUpStanding>;
  /** Cleans up now, or joins the clean-up already running, and answers what it removed. */
  cleanUpNow(): Promise<HostCleanUpRun>;
  /** Stops the timer and waits for a clean-up in flight. */
  close(): Promise<void>;
};

const EXPIRED_RECORD_KINDS = [
  'audit',
  'reviews',
  'memories',
  'logs',
  'notifications',
  'hookDeliveries',
  'chats',
] as const satisfies readonly ExpiredRecordKind[];

const kindSchema = z.enum(EXPIRED_RECORD_KINDS);

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  last: z.object({
    at: z.iso.datetime(),
    trigger: z.enum(['nightly', 'manual']),
    removed: z.number().int().nonnegative(),
    byKind: z.partialRecord(kindSchema, z.number().int().nonnegative()),
    failed: z.array(kindSchema),
  }),
});

/** The process's IANA time zone, which the nightly time follows unless the host is given one. */
export function processTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

type WallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClockAt(instant: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    second: part('second'),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant the clean-up time falls on the given calendar day in `timeZone`. */
function cleanUpTimeOn(year: number, month: number, day: number, timeZone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, CLEAN_UP_HOUR, CLEAN_UP_MINUTE);
  // The offset is read at the guess and again at the instant it gives, so a day on which the
  // zone's offset changes before the clean-up time still lands on the right side of the change.
  const first = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(first, timeZone);
}

/** The latest nightly clean-up time at or before `instant`, in `timeZone`. */
export function cleanUpTimeAtOrBefore(instant: number, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  const today = cleanUpTimeOn(wall.year, wall.month, wall.day, timeZone);
  if (today <= instant) return today;
  const yesterday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day - 1));
  return cleanUpTimeOn(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth() + 1,
    yesterday.getUTCDate(),
    timeZone,
  );
}

/** The first nightly clean-up time after `instant`, in `timeZone`. */
export function cleanUpTimeAfter(instant: number, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  const today = cleanUpTimeOn(wall.year, wall.month, wall.day, timeZone);
  if (today > instant) return today;
  const tomorrow = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  return cleanUpTimeOn(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    timeZone,
  );
}

/**
 * The latest nightly time the host missed: the one at or before `now`, when the host started after
 * it and no clean-up has run since it. `null` before the first clean-up.
 */
export function skippedCleanUpTime(
  last: HostCleanUpRun | null,
  startedAt: number,
  now: number,
  timeZone: string,
): number | null {
  if (last === null) return null;
  const latest = cleanUpTimeAtOrBefore(now, timeZone);
  return Date.parse(last.at) < latest && startedAt > latest ? latest : null;
}

async function readLast(
  storage: Storage,
  warn: (message: string) => void,
): Promise<HostCleanUpRun | null> {
  const bytes = await storage.get(CLEAN_UP_RECORD_KEY);
  if (bytes === null) return null;
  try {
    const parsed = recordSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const counted = parsed.last.byKind;
    // A kind the record predates counts zero.
    const byKind: Record<ExpiredRecordKind, number> = {
      audit: counted.audit ?? 0,
      reviews: counted.reviews ?? 0,
      memories: counted.memories ?? 0,
      logs: counted.logs ?? 0,
      notifications: counted.notifications ?? 0,
      hookDeliveries: counted.hookDeliveries ?? 0,
      chats: counted.chats ?? 0,
    };
    return { ...parsed.last, byKind };
  } catch {
    warn(`The last clean-up record (${CLEAN_UP_RECORD_KEY}) is unreadable, so none is reported.`);
    return null;
  }
}

/**
 * Starts the nightly clean-up: arms a timer for the next 3:00 AM in the host's zone, and after each
 * clean-up the one after it. A clean-up that fails is reported through `warn`, kept out of the
 * record, and the next night's still runs.
 */
export function startNightlyCleanUp(options: NightlyCleanUpOptions): NightlyCleanUp {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? processTimeZone();
  const startedAt = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<HostCleanUpRun> | undefined;
  let closed = false;

  const run = (trigger: HostCleanUpTrigger): Promise<HostCleanUpRun> => {
    inFlight ??= (async () => {
      try {
        const removal = await options.removeExpiredRecords();
        const cleanUp: HostCleanUpRun = {
          at: new Date(now()).toISOString(),
          trigger,
          removed: removal.removed,
          byKind: removal.byKind,
          failed: removal.failed,
        };
        await options.storage.put(
          CLEAN_UP_RECORD_KEY,
          new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, last: cleanUp })),
        );
        return cleanUp;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const nightly = async (): Promise<void> => {
    try {
      await run('nightly');
    } catch (error: unknown) {
      options.warn(
        `The nightly clean-up failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    arm();
  };

  function arm(): void {
    if (closed) return;
    const delay = Math.max(0, cleanUpTimeAfter(now(), timeZone) - now());
    // poll-reason: time-derived
    timer = setTimeout(() => void nightly(), delay);
    // The timer keeps no process alive on its own: the host's listener does.
    timer.unref?.();
  }
  arm();

  return {
    async standing() {
      const last = await readLast(options.storage, options.warn);
      const instant = now();
      const skipped = skippedCleanUpTime(last, startedAt, instant, timeZone);
      return {
        schedule: { hour: CLEAN_UP_HOUR, minute: CLEAN_UP_MINUTE, timeZone },
        last,
        skipped: skipped === null ? null : { at: new Date(skipped).toISOString() },
        nextAt: new Date(cleanUpTimeAfter(instant, timeZone)).toISOString(),
      };
    },
    cleanUpNow: () => run('manual'),
    async close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight?.catch(() => undefined);
    },
  };
}

/** The routes to merge into the host's `routes`. Each runs the guard first. */
export function cleanUpRoutes(
  cleanUp: NightlyCleanUp,
  refuse: (request: Request) => Response | undefined,
) {
  return {
    [HOST_CLEAN_UP_ROUTE]: {
      GET: async (request: Request) => refuse(request) ?? Response.json(await cleanUp.standing()),
      POST: async (request: Request) => {
        const refusal = refuse(request);
        if (refusal !== undefined) return refusal;
        try {
          return Response.json(await cleanUp.cleanUpNow());
        } catch {
          // Nothing from the failure is repeated: it may hold a path or a value.
          return Response.json(
            {
              error: 'failed',
              message: 'The clean-up could not run. Nothing was reported removed.',
            },
            { status: 500 },
          );
        }
      },
    },
  };
}
