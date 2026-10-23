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
};

/**
 * The forms a task's open human waits ask for, in wait order. A task that is not waiting, or whose
 * waits carry no schema, has none. A review that cannot be read leaves its wait without a form: the
 * task is still projected, with the text that names the wait.
 */
export async function formsOf(
  bureau: Pick<Bureau, 'getReview'>,
  view: TaskView,
): Promise<WaitForm[]> {
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

/**
 * The review id of the wait that parked on the same signal just before this one, or `undefined`
 * for the first park. Review ids end in the park ordinal (`human-wait:<run>:<signal>:<n>`), and a
 * wait on a signal opens only once the previous park on it has closed.
 */
export function previousParkReviewId(reviewId: string): string | undefined {
  const split = reviewId.lastIndexOf(':');
  const ordinal = Number(reviewId.slice(split + 1));
  if (split < 0 || !Number.isInteger(ordinal) || ordinal < 1) return undefined;
  return `${reviewId.slice(0, split)}:${ordinal - 1}`;
}
