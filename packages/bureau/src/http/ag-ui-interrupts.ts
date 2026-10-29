/**
 * Pending reviews as AG-UI interrupts, and the payload that answers them.
 *
 * An interrupt carries the review's own id, verbatim, so the interrupt a client
 * shows and the item `bureau.reviews.*` lists are one identifier and a resume
 * entry's `interruptId` is what `reviews.resolve` takes. It carries no tool
 * arguments, no approval token, and no binding: the arguments were streamed as
 * `TOOL_CALL_ARGS`, and resolving goes through the id.
 *
 * @module ag-ui-interrupts
 */

import type { HumanInputSchema } from '@lostgradient/operative';
import type { Interrupt, ResumeEntry } from '@ag-ui/core';

import type { PendingReview } from '../types.ts';
import { projectReview } from './bureau-reviews-operations.ts';
import { BUREAU_METADATA_KEY } from './ag-ui-vocabulary.ts';

/**
 * The JSON Schema of the payload that answers an interrupt, the same for both
 * review kinds. `arguments` applies to a tool approval that is approved and
 * overrides the call's arguments; `answer` applies to a human wait that is
 * approved and is delivered as the signal's payload; `reason` is required, and
 * must hold a character other than whitespace, to `reject`, which is the rule the
 * resume boundary enforces.
 */
export const RESUME_PAYLOAD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { enum: ['approve', 'deny', 'reject'] },
    reason: { type: 'string' },
    arguments: {},
    answer: {},
  },
  required: ['decision'],
  additionalProperties: false,
  anyOf: [
    { properties: { decision: { enum: ['approve', 'deny'] } } },
    {
      properties: { decision: { const: 'reject' }, reason: { type: 'string', pattern: '\\S' } },
      required: ['reason'],
    },
  ],
};

/** Keys whose value is data a schema holds, not a subschema, so a `$ref` inside is not a reference. */
const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(['enum', 'const', 'default', 'examples']);

/**
 * `schema` with every local reference (`#`, `#/...`) moved to where the schema now sits, so it
 * resolves from the resume payload's root. A reference is relative to the document it is in; the
 * answer schema is a document of its own until it is embedded as `properties.answer`.
 */
function withReferencesRebasedUnder(value: unknown, base: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => withReferencesRebasedUnder(entry, base));
  if (typeof value !== 'object' || value === null) return value;
  const rebased: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SCHEMA_DATA_KEYWORDS.has(key)) {
      rebased[key] = entry;
    } else if (
      key === '$ref' &&
      typeof entry === 'string' &&
      (entry === '#' || entry.startsWith('#/'))
    ) {
      rebased[key] = `${base}${entry.slice(1)}`;
    } else {
      rebased[key] = withReferencesRebasedUnder(entry, base);
    }
  }
  return rebased;
}

/**
 * The `responseSchema` of an interrupt (COR-1804). Without an `answerSchema` it is
 * {@link RESUME_PAYLOAD_SCHEMA}. With one (a human wait that was parked with a schema, whether the
 * model's per-call `answerSchema` or the author's per-signal one) it keeps `decision` and `reason`,
 * which every answer needs, embeds the schema as `properties.answer`, and requires an `answer` to
 * approve: replacing the payload schema with the answer schema would leave no way to deny or
 * reject. The schema's own local `$ref`s are rebased to `#/properties/answer/...`. A client that
 * renders a control from it reads `properties.answer`, with its `x-` keywords, as the question.
 */
export function responseSchemaFor(
  answerSchema: HumanInputSchema | undefined,
): Record<string, unknown> {
  if (answerSchema === undefined) return RESUME_PAYLOAD_SCHEMA;
  return {
    type: 'object',
    properties: {
      decision: { enum: ['approve', 'deny', 'reject'] },
      reason: { type: 'string' },
      arguments: {},
      answer: withReferencesRebasedUnder(answerSchema, '#/properties/answer'),
    },
    required: ['decision'],
    additionalProperties: false,
    anyOf: [
      { properties: { decision: { const: 'approve' } }, required: ['answer'] },
      { properties: { decision: { const: 'deny' } } },
      {
        properties: { decision: { const: 'reject' }, reason: { type: 'string', pattern: '\\S' } },
        required: ['reason'],
      },
    ],
  };
}

/** The answer to one interrupt, as the `payload` of a `resolved` resume entry. */
export type AgUiResumePayload = {
  decision: 'approve' | 'deny' | 'reject';
  reason?: string;
  arguments?: unknown;
  answer?: unknown;
};

/**
 * The round of the tool approval a resume entry answers: the `round` the client read from the
 * interrupt's metadata, sent back under the same key in the entry's own `metadata` (COR-1714). A
 * re-gated approval keeps its id and advances its round, so the round is what says which request
 * the answer was made on. `undefined` when the entry names none, and its answer is not fenced;
 * `null` when what it names is not a round.
 */
export function roundOfEntry(entry: ResumeEntry): number | null | undefined {
  const fields: unknown = entry.metadata?.[BUREAU_METADATA_KEY];
  if (fields === undefined) return undefined;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return null;
  const round: unknown = (fields as Record<string, unknown>)['round'];
  if (round === undefined) return undefined;
  return typeof round === 'number' && Number.isSafeInteger(round) && round >= 0 ? round : null;
}

/** One pending review as the interrupt that asks for its answer. */
export function toInterrupt(review: PendingReview): Interrupt {
  const projected = projectReview({ ...review, status: 'pending' });
  if (review.kind === 'human-wait') {
    return {
      id: review.id,
      reason: 'human-wait',
      ...(review.prompt === undefined ? {} : { message: review.prompt }),
      responseSchema: responseSchemaFor(review.inputSchema),
      metadata: {
        [BUREAU_METADATA_KEY]: {
          kind: 'human-wait',
          runId: review.runId,
          sessionId: review.sessionId,
          signalName: review.signalName,
        },
      },
    };
  }
  const action = review.approval.action;
  const message = action.message ?? review.approval.reason;
  const approvalAction = action.type === 'approval' ? action : undefined;
  const wire = projected.kind === 'tool-approval' ? projected.approval : undefined;
  return {
    id: review.id,
    reason: 'tool-approval',
    toolCallId: review.approval.callId,
    ...(message === undefined ? {} : { message }),
    ...(approvalAction?.expiresAt === undefined ? {} : { expiresAt: approvalAction.expiresAt }),
    responseSchema: RESUME_PAYLOAD_SCHEMA,
    metadata: {
      [BUREAU_METADATA_KEY]: {
        kind: 'tool-approval',
        runId: review.runId,
        sessionId: review.sessionId,
        round: review.round,
        toolName: review.approval.toolName,
        ...(wire?.action.type === 'approval'
          ? { risk: wire.action.risk, operation: wire.action.operation }
          : {}),
      },
    },
  };
}

/**
 * The key that identifies a set of interrupts in the command ledger: the sorted
 * `[id, round]` pairs, serialized as JSON. A join with delimiters would not be
 * injective (an id may contain the delimiter), and the key is persisted, so its
 * encoding is part of the stored contract. A human wait has no rounds, so its
 * round is 0.
 */
export function interruptKey(reviews: ReadonlyArray<PendingReview>): string {
  const pairs = reviews
    .map((review): [string, number] => [
      review.id,
      review.kind === 'tool-approval' ? review.round : 0,
    ])
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(pairs);
}
