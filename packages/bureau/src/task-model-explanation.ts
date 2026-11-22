/**
 * The longer explanation of a failed run that a model wrote when the owner asked (COR-2534): the
 * shape a task record stores, and the check that reads it back from storage.
 *
 * It is kept beside the facts `bureau.tasks.explain` serves, never inside them, and it names the
 * model that wrote it, when, and what that cost, so the page can say who wrote the words. Its cost
 * is the explanation's alone: the run's own `usage` is never touched by writing it.
 *
 * @module task-model-explanation
 */

/** The longest text a stored explanation keeps, in characters. */
export const MODEL_EXPLANATION_TEXT_LIMIT = 6000;

/** What a model wrote about one failed run, as its task record stores it. */
export interface TaskModelExplanation {
  /** The model's text, as plain text. */
  readonly text: string;
  /** The model that wrote it, `<provider>/<model>`. */
  readonly model: string;
  /** When it was written, as an ISO 8601 date-time. */
  readonly generatedAt: string;
  /**
   * What writing it cost, in US dollars, from the model catalog's price for the model that wrote it;
   * `null` when the model has no price or the provider reported no usage, never `0`.
   */
  readonly costUsd: number | null;
}

/** Whether a stored value is a {@link TaskModelExplanation}. */
export function isTaskModelExplanation(value: unknown): value is TaskModelExplanation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['text'] === 'string' &&
    typeof record['model'] === 'string' &&
    typeof record['generatedAt'] === 'string' &&
    !Number.isNaN(Date.parse(record['generatedAt'])) &&
    (record['costUsd'] === null ||
      (typeof record['costUsd'] === 'number' && Number.isFinite(record['costUsd'])))
  );
}
