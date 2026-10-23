/**
 * The input forms an `INPUT_REQUIRED` task asks for (COR-1487).
 *
 * A task's view names its open waits by identifier only, so the prompt and the input schema of a
 * human wait are read from its review, the one place that holds them.
 *
 * @module a2a-input-forms
 */

import type { HumanInputSchema } from '@lostgradient/operative';

import type { TaskView } from '../task-registry.ts';
import type { Bureau } from '../types.ts';

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

/** The part of a Bureau the forms read: a review, and the audit trail that holds the closed ones. */
type FormsBureau = Pick<Bureau, 'getReview'> & Partial<Pick<Bureau, 'auditTrail'>>;

/** The ordinal a human-wait review id ends in; ordinals count the parks of a whole run. */
function parkOrdinalOf(reviewId: string): number {
  return Number(reviewId.slice(reviewId.lastIndexOf(':') + 1));
}

/** The run's human-wait reviews the audit trail recorded, oldest first; none without a trail. */
async function recordedHumanWaitIds(bureau: FormsBureau, runId: string): Promise<string[]> {
  const records = await bureau.auditTrail?.query({ runId, limit: 10_000 }).catch(() => undefined);
  const found = new Set<string>();
  for (const record of records ?? []) {
    if (!record.type.startsWith('review.')) continue;
    const review = (record.detail as { review?: Record<string, unknown> } | null)?.review;
    const id = review?.['id'];
    if (review?.['kind'] === 'human-wait' && typeof id === 'string') {
      if (Number.isInteger(parkOrdinalOf(id))) found.add(id);
    }
  }
  return [...found].toSorted((left, right) => parkOrdinalOf(left) - parkOrdinalOf(right));
}

/** The latest of the run's recorded human waits before `ordinal` that asked for a form. */
async function formReviewBefore(
  bureau: FormsBureau,
  runId: string,
  ordinal: number,
): Promise<string | undefined> {
  const recorded = await recordedHumanWaitIds(bureau, runId);
  const earlier = recorded.filter((id) => parkOrdinalOf(id) < ordinal);
  for (const id of earlier.toReversed()) {
    const review = await bureau.getReview(id).catch(() => undefined);
    if (review?.kind === 'human-wait' && review.inputSchema !== undefined) return id;
  }
  return undefined;
}

/**
 * Adds to each form the review of the run's previous form wait, whose surface the form replaces.
 * Only a client that renders forms needs it, so a read that activated A2UI calls it and no other
 * caller pays for it. The audit trail has no newest-first order or review-kind filter, so this
 * reads the run's records (bounded by the query's limit) and then one review per earlier wait,
 * newest first, until a form is found.
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
      const review = await bureau.getReview(wait.reviewId).catch(() => undefined);
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
