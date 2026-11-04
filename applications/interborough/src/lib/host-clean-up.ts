/**
 * The host's nightly clean-up of expired records, as Settings › Data and retention reads and runs it
 * (`GET /host/clean-up`, `POST /host/clean-up`; `src/host/nightly-clean-up.ts`): when it runs each
 * night and in which time zone, the last clean-up and what it removed, a night the host was off
 * for, and "Clean up now".
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';

/** The route of the clean-up: `GET` reports its standing, `POST` cleans up now. */
export const HOST_CLEAN_UP_ROUTE = '/host/clean-up';

const kindSchema = z.enum([
  'audit',
  'reviews',
  'memories',
  'logs',
  'notifications',
  'hookDeliveries',
]);

const runSchema = z.object({
  at: z.string(),
  trigger: z.enum(['nightly', 'manual']),
  removed: z.number(),
  byKind: z.record(kindSchema, z.number()),
  failed: z.array(kindSchema),
});

const standingSchema = z.object({
  schedule: z.object({ hour: z.number(), minute: z.number(), timeZone: z.string() }),
  last: runSchema.nullable(),
  skipped: z.object({ at: z.string() }).nullable(),
  nextAt: z.string(),
});

/**
 * One clean-up the host ran: when (`at`, ISO 8601), whether the nightly timer or a person started
 * it, how many records it removed (`removed`, and `byKind` per kind of record), and the kinds whose
 * removal failed.
 */
export type HostCleanUpRun = z.infer<typeof runSchema>;

/**
 * When the host cleans up (`schedule`: the hour and minute of every night, in its IANA
 * `timeZone`), the last clean-up or `null`, the latest nightly time the host was off for when no
 * clean-up has run since (`skipped`), and when the next one runs (`nextAt`).
 */
export type HostCleanUpStanding = z.infer<typeof standingSchema>;

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

function send(init: RequestInit, options: Options): Promise<Response> {
  const request = options.fetch ?? fetch;
  return request(
    HOST_CLEAN_UP_ROUTE,
    options.signal === undefined ? init : { ...init, signal: options.signal },
  );
}

/** Asks the host when it cleans up, and how the last clean-up went. */
export async function getCleanUpStanding(options: Options = {}): Promise<HostCleanUpStanding> {
  const response = await send({}, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return standingSchema.parse(await response.json());
}

/** Asks the host to clean up now, and answers what it removed. */
export async function cleanUpNow(options: Options = {}): Promise<HostCleanUpRun> {
  const response = await send({ method: 'POST' }, options);
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return runSchema.parse(await response.json());
}
