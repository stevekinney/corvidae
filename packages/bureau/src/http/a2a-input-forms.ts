/**
 * The input forms an `INPUT_REQUIRED` task asks for (COR-1487).
 *
 * A task's view names its open waits by identifier only, so the prompt and the input schema of a
 * human wait are read from its review, the one place that holds them.
 *
 * @module a2a-input-forms
 */

import type { HumanInputSchema } from '@lostgradient/operative';

import type { AuditRecord, AuditTrail } from '../audit-trail.ts';
import type { TaskView } from '../task-registry.ts';
import type { BureauReviews } from '../types.ts';

/** A human wait that asks for structured input: what to ask, and the shape of the answer. */
export type WaitForm = {
  /** The review the wait is parked on: one wait, one form surface. */
  readonly reviewId: string;
  readonly signalName: string;
  readonly prompt: string | undefined;
  readonly inputSchema: HumanInputSchema;
  /**
   * The review of the run's previous form wait, whose surface this one replaces: a repeated park
   * closes the surface before it, whatever signal it waited on. `undefined` for the first form.
   */
  readonly previousReviewId?: string | undefined;
};

/** The audit trail the forms read the closed waits from; a Bureau without one has none. */
export type FormsAuditInternals = { readonly auditTrail?: AuditTrail | undefined };

/** The part of a Bureau the forms read: a review, and the audit trail that holds the closed ones. */
type FormsBureau = {
  readonly reviews: Pick<BureauReviews, 'get'>;
  readonly internals?: FormsAuditInternals;
};

/** The ordinal a human-wait review id ends in; ordinals count the parks of a whole run. */
function parkOrdinalOf(reviewId: string): number {
  return Number(reviewId.slice(reviewId.lastIndexOf(':') + 1));
}

/** How many of a run's newest closed form waits the previous-form lookup reads. */
const FORM_LOOKUP_LIMIT = 10;

/** The review id of the form wait a trail record closed, or `undefined` for any other record. */
function closedFormWaitId(record: AuditRecord): string | undefined {
  if (!record.type.startsWith('review.human-wait.')) return undefined;
  const detail = record.detail as { review?: { id?: unknown }; inputForm?: unknown } | null;
  const id = detail?.review?.id;
  if (detail?.inputForm !== true || typeof id !== 'string') return undefined;
  return Number.isInteger(parkOrdinalOf(id)) ? id : undefined;
}

/**
 * The run's newest closed human-wait reviews that showed a form, oldest first, as the audit trail
 * recorded them when they closed (the record carries an `inputForm` marker, not the schema). The
 * form filter runs in the query before its limit counts, so plain waits never crowd a form out.
 * Empty without a trail.
 */
async function recordedFormWaitIds(bureau: FormsBureau, runId: string): Promise<string[]> {
  const records = await bureau.internals?.auditTrail
    ?.query({
      runId,
      filter: (record) => closedFormWaitId(record) !== undefined,
      select: 'newest',
      limit: FORM_LOOKUP_LIMIT,
    })
    .catch(() => undefined);
  const found = new Set<string>();
  for (const record of records ?? []) {
    const id = closedFormWaitId(record);
    if (id !== undefined) found.add(id);
  }
  return [...found].toSorted((left, right) => parkOrdinalOf(left) - parkOrdinalOf(right));
}

/** The latest of the run's closed form waits before `ordinal`. */
async function formReviewBefore(
  bureau: FormsBureau,
  runId: string,
  ordinal: number,
): Promise<string | undefined> {
  const recorded = await recordedFormWaitIds(bureau, runId);
  return recorded.filter((id) => parkOrdinalOf(id) < ordinal).at(-1);
}

/**
 * Adds to each form the review of the run's previous form wait, whose surface the form replaces.
 * Only a client that renders forms needs it, so a read that activated A2UI calls it and no other
 * caller pays for it. It reads only the run's newest closed form waits, a bounded number,
 * and no review.
 */
export async function withPreviousForms(
  bureau: FormsBureau,
  view: TaskView,
  forms: readonly WaitForm[],
): Promise<WaitForm[]> {
  return Promise.all(
    forms.map(async (form) => ({
      ...form,
      previousReviewId: await formReviewBefore(bureau, view.id, parkOrdinalOf(form.reviewId)),
    })),
  );
}

/**
 * The forms a task's open human waits ask for, in wait order. A task that is not waiting, or whose
 * waits carry no schema, has none. A review that cannot be read leaves its wait without a form: the
 * task is still projected, with the text that names the wait.
 */
export async function formsOf(bureau: FormsBureau, view: TaskView): Promise<WaitForm[]> {
  if (view.status !== 'input-required') return [];
  const forms = await Promise.all(
    view.openWaits.map(async (wait): Promise<WaitForm | undefined> => {
      if (wait.kind !== 'human-wait') return undefined;
      const review = await bureau.reviews.get(wait.reviewId).catch(() => undefined);
      if (review?.kind !== 'human-wait' || review.inputSchema === undefined) return undefined;
      return {
        reviewId: wait.reviewId,
        signalName: wait.signalName,
        prompt: review.prompt,
        inputSchema: review.inputSchema,
      };
    }),
  );
  return forms.filter((form): form is WaitForm => form !== undefined);
}

/** The surface id of a wait's form: one per review, so a repeated wait on a signal is a new surface. */
export function formSurfaceId(reviewId: string): string {
  return `input-form:${reviewId}`;
}
