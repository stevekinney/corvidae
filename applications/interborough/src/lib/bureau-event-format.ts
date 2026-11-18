/**
 * `bureau.events.format` (COR-1893, COR-2227): the Bureau's events as a person reads them, each in
 * the words a plugin's formatter writes for its kind (a title, a body, a tier, a Lucide icon name and
 * a router-relative link), or its raw kind as the title when no formatter claims it. The answer is
 * parsed at the boundary.
 *
 * Envelopes are sent in batches of at most {@link MAXIMUM_EVENTS_PER_FORMAT}, one call per batch,
 * and the answer is matched to them by position. A batch whose call fails, or whose answer does not
 * hold one entry per envelope, is `null` for each of its envelopes, so the caller shows them in its
 * own words and the batches that answered stay worded.
 */
import { z } from 'zod';

import { callBureau, getBureauId, type Fetcher } from './bureau-client.ts';
import type { BureauEventFrame } from './live-source/bureau-event-frame.ts';

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** The most events one `bureau.events.format` call formats. */
export const MAXIMUM_EVENTS_PER_FORMAT = 200;

const formattedEventSchema = z.object({
  kind: z.string(),
  title: z.string(),
  body: z.string().optional(),
  tier: z.enum(['critical', 'warning', 'info']),
  icon: z.string().optional(),
  link: z.string().optional(),
  runId: z.string().optional(),
  source: z.string().optional(),
  formattedBy: z.string().optional(),
});

const formatAnswerSchema = z.object({ events: z.array(formattedEventSchema) });

/** One event as the Bureau words it. `formattedBy` is absent when no formatter claimed its kind. */
export type FormattedBureauEvent = z.infer<typeof formattedEventSchema>;

/** The tier a formatted event has: how much it matters. */
export type FormattedEventTier = FormattedBureauEvent['tier'];

async function formatBatch(
  batch: readonly BureauEventFrame[],
  bureauId: string,
  options: Options,
): Promise<(FormattedBureauEvent | null)[]> {
  try {
    const answer = formatAnswerSchema.parse(
      await callBureau(
        'bureau.events.format',
        {
          events: batch.map((envelope) => ({
            kind: envelope.kind,
            bureauId,
            emittedAtMs: envelope.emittedAtMs,
            // The operation refuses an event without its payload; a frame that carried none sends null.
            payload: envelope.payload ?? null,
            ...(envelope.source === undefined ? {} : { source: envelope.source }),
          })),
        },
        options,
      ),
    );
    if (answer.events.length !== batch.length) return batch.map(() => null);
    return answer.events;
  } catch {
    return batch.map(() => null);
  }
}

/**
 * Words `envelopes` through `bureau.events.format`, at most {@link MAXIMUM_EVENTS_PER_FORMAT} per
 * call, and returns one entry per envelope in the same order: the Bureau's words, or `null` for an
 * envelope whose batch could not be formatted. It never throws.
 */
export async function formatBureauEvents(
  envelopes: readonly BureauEventFrame[],
  options: Options = {},
): Promise<(FormattedBureauEvent | null)[]> {
  // The caller's array is read once, before the first await.
  const snapshot = [...envelopes];
  if (snapshot.length === 0) return [];
  let bureauId: string;
  try {
    bureauId = await getBureauId(options);
  } catch {
    return snapshot.map(() => null);
  }
  const batches: BureauEventFrame[][] = [];
  for (let start = 0; start < snapshot.length; start += MAXIMUM_EVENTS_PER_FORMAT) {
    batches.push(snapshot.slice(start, start + MAXIMUM_EVENTS_PER_FORMAT));
  }
  const answers = await Promise.all(batches.map((batch) => formatBatch(batch, bureauId, options)));
  return answers.flat();
}
