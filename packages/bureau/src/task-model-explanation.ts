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

/**
 * What identifies the failure a model was asked to explain, captured when the request reads it and
 * checked when the text is stored. A model call takes a while, and the record can change under it:
 * a chat's purge empties the settlement's message and drops the text, and the real end of a run
 * inferred `owner-lost` replaces the failure. The write is fenced on all of it, so an explanation
 * of content that is gone, or of a failure that was replaced, is never stored.
 */
export interface ModelExplanationFence {
  /** How many times the record had changed (`TaskRecord.revision`, `0` when absent). */
  readonly revision: number;
  /** The settlement's time. */
  readonly settledAt: string;
  /** The settlement's finish reason. */
  readonly finishReason: string | null;
  /** The settlement's message, which a purge empties. */
  readonly message: string | null;
}

/** What {@link ModelExplanationFence} reads of a task record. */
interface FencedRecord {
  readonly revision?: number | undefined;
  readonly settled?:
    | {
        readonly at: string;
        readonly status: string;
        readonly finishReason: string | null;
        readonly message: string | null;
      }
    | undefined;
}

/** The fence of a task's failed settlement as the record holds it now, or `undefined` for a task that has not failed. */
export function modelExplanationFenceOf(
  record: FencedRecord | undefined,
): ModelExplanationFence | undefined {
  const settled = record?.settled;
  if (record === undefined || settled === undefined || settled.status !== 'failed')
    return undefined;
  return {
    revision: record.revision ?? 0,
    settledAt: settled.at,
    finishReason: settled.finishReason,
    message: settled.message,
  };
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
