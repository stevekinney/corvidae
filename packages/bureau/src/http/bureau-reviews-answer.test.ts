/**
 * COR-1804 — a question carries its own answer schema. A `requestHumanInput` call parks a review
 * whose projection and AG-UI interrupt carry the schema; `bureau.reviews.resolve` takes an
 * `answer`, checks it against that schema before anything is decided, and answers `InvalidParams`
 * with field-level `data.issues` while leaving the review pending. A per-call schema replaces the
 * per-signal one; a schema over the limits parks nothing.
 */
import {
  createAgent,
  type GenerateFunction,
  type HumanInputSchema,
  stopWhen,
} from '@lostgradient/operative';
import {
  createOperationHandler,
  createOperationHandlerAuthenticator,
  principalFromApiKey,
} from '@lostgradient/weft';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { AgentDefinitions } from '../agent-catalog';
import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau, ReviewAnswerInvalidError } from '../create-bureau.ts';
import { waitForCondition } from '../test';
import type { PendingReview, ResolveReviewInput } from '../types.ts';
import { responseSchemaFor, toInterrupt } from './ag-ui-interrupts.ts';
import {
  type BureauReviewsOperationHost,
  bureauReviewsOperations,
  reviewFault,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { mayAccessOwnedResource } from './owner-predicate.ts';

const API_KEY = 'answer-test-key';
const authentication = {
  resolveApiKeyPrincipal: async (key: string) =>
    key === API_KEY ? principalFromApiKey({ subject: 'tester', scopes: [] }) : null,
  auditSink: () => undefined,
};

type Reply = {
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message?: string;
    data?: {
      httpStatus?: number;
      weftCode?: string;
      issues?: Array<{ path: Array<string | number>; message: string; code: string }>;
    };
  };
};

async function call(
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: unknown,
): Promise<Reply> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as Reply;
}

/** One kind of question, a schema for it, an answer that fits and one that does not. */
const kinds: Array<[kind: string, schema: HumanInputSchema, good: unknown, bad: unknown]> = [
  [
    'pick one',
    { type: 'string', enum: ['staging', 'production'], 'x-labels': { staging: 'Staging' } },
    'staging',
    'qa',
  ],
  [
    'pick one or something else',
    {
      anyOf: [{ enum: ['small', 'large'] }, { type: 'string', maxLength: 5 }],
      'x-allowOther': true,
    },
    'tiny',
    'far too long',
  ],
  [
    'pick several',
    { type: 'array', uniqueItems: true, items: { enum: ['a', 'b'] }, minItems: 1, maxItems: 2 },
    ['a', 'b'],
    ['a', 'a'],
  ],
  ['free text', { type: 'string', maxLength: 5 }, 'hello', 'too long'],
  ['yes or no', { type: 'boolean' }, true, 'yes'],
  ['number', { type: 'number', minimum: 0, maximum: 10 }, 7, 11],
  ['date', { type: 'string', format: 'date' }, '2026-10-29', '2026-02-30'],
  ['time', { type: 'string', format: 'time' }, '14:30:00Z', '14:30'],
  ['date and time', { type: 'string', format: 'date-time' }, '2026-10-29T14:30:00Z', 'tomorrow'],
  [
    'rating',
    { type: 'integer', minimum: 1, maximum: 5, 'x-kind': 'rating', 'x-labels': { '1': 'Poor' } },
    4,
    6,
  ],
  [
    'a few fields',
    {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    { name: 'Ada' },
    { nickname: 'Ada' },
  ],
  ['secret', { type: 'string', writeOnly: true, 'x-secret': true }, 'hunter2', 42],
  [
    'file',
    { type: 'string', contentMediaType: 'application/pdf', 'x-asset': true },
    'asset-1',
    { id: 1 },
  ],
];

type ToolResultSeen = { callId: string; content: unknown };

/** A Bureau whose one agent asks what `ask.arguments` says on its first step, then answers in text. */
async function askingBureau(
  inputSchemas?: Record<string, HumanInputSchema>,
  stop: 'at-the-question' | 'when-done' = 'at-the-question',
) {
  const ask: {
    arguments: Record<string, unknown>;
    seen: ToolResultSeen[];
    transcripts: string[];
  } = { arguments: {}, seen: [], transcripts: [] };
  const generate: GenerateFunction = async ({ step, conversation }) => {
    if (step === 0) {
      return {
        content: '',
        toolCalls: [
          { id: `call-${Date.now()}`, name: 'requestHumanInput', arguments: ask.arguments },
        ],
      };
    }
    ask.transcripts.push(JSON.stringify(conversation.getMessages()));
    for (const message of conversation.getMessages()) {
      if (message.toolResult !== undefined) {
        ask.seen.push({ callId: message.toolResult.callId, content: message.toolResult.content });
      }
    }
    return { content: 'thanks', toolCalls: [] };
  };
  const bureau = await createBureau<AgentDefinitions>({
    assets: { storage: createMemoryAssetStorage() },
    id: 'answer-bureau',
    agents: {
      default: createAgent({
        generate,
        toolbox: createToolbox([]) as unknown as Toolbox,
        stopWhen:
          stop === 'when-done'
            ? stopWhen.noToolCalls()
            : stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    storage: new MemoryStorage(),
    durable: true,
    ...(inputSchemas === undefined ? {} : { humanInput: { inputSchemas } }),
  });
  const handler = createBureauHandler(bureau, { authentication });
  /** Starts a run that asks `args`, and waits for the review it parks. */
  async function park(args: Record<string, unknown>): Promise<PendingReview> {
    ask.arguments = args;
    const run = await bureau.tasks.start('default', 'ask', { principal: 'api-key:tester' });
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === run.id),
      'expected requestHumanInput to park and surface a pending review',
    );
    return bureau.reviews.list().find((review) => review.runId === run.id)!;
  }
  return { bureau, handler, ask, park };
}

describe('a question that carries its own answer schema, through a real Bureau', () => {
  it('parks a review for each kind whose projection and interrupt carry the schema, takes a fitting answer, and refuses a mismatched one', async () => {
    const { bureau, handler, park } = await askingBureau();
    try {
      for (const [kind, schema, good, bad] of kinds) {
        const review = await park({ signalName: 'ask', prompt: kind, answerSchema: schema });

        // The review, on the wire and in process.
        const fetched = await call(handler, 'bureau.reviews.get', { id: review.id });
        expect(fetched.result?.['inputSchema'], kind).toEqual(schema);
        const listed = await call(handler, 'bureau.reviews.list', {});
        const reviews = (listed.result?.['reviews'] ?? []) as Array<Record<string, unknown>>;
        const wire = reviews.find((candidate) => candidate['id'] === review.id);
        expect(wire?.['inputSchema'], kind).toEqual(schema);
        // The AG-UI interrupt: decision and reason stay, the schema is the answer.
        const interrupt = toInterrupt(review);
        expect(interrupt.responseSchema, kind).toEqual(responseSchemaFor(schema));
        expect(
          (interrupt.responseSchema as { properties: { answer: unknown } }).properties.answer,
          kind,
        ).toEqual(schema);

        // A mismatched answer is refused with field-level issues and the review stays pending.
        const refused = await call(handler, 'bureau.reviews.resolve', {
          id: review.id,
          decision: 'approve',
          answer: bad,
        });
        expect(refused.error?.data?.httpStatus, kind).toBe(400);
        const issues = refused.error?.data?.issues ?? [];
        expect(issues.length, kind).toBeGreaterThan(0);
        for (const issue of issues) {
          expect(issue.path[0], kind).toBe('answer');
          expect(typeof issue.message).toBe('string');
          expect(typeof issue.code).toBe('string');
        }
        expect(
          bureau.reviews.list().some((candidate) => candidate.id === review.id),
          kind,
        ).toBe(true);
        const stillPending = await call(handler, 'bureau.reviews.get', { id: review.id });
        expect(stillPending.result?.['status']).toBe('pending');

        // A fitting answer lands.
        const applied = await call(handler, 'bureau.reviews.resolve', {
          id: review.id,
          decision: 'approve',
          answer: good,
        });
        expect(applied.result, kind).toMatchObject({ kind: 'human-wait', receipt: 'applied' });
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('names the field a structured answer got wrong, rooted at `answer`', async () => {
    const { bureau, handler, park } = await askingBureau();
    try {
      const review = await park({
        signalName: 'ask',
        answerSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, count: { type: 'integer' } },
          required: ['name'],
          additionalProperties: false,
        },
      });

      const refused = await call(handler, 'bureau.reviews.resolve', {
        id: review.id,
        decision: 'approve',
        answer: { count: 'two', extra: 1 },
      });

      expect(refused.error?.data?.issues).toEqual(
        expect.arrayContaining([
          { path: ['answer', 'name'], message: '"name" is required', code: 'required' },
          { path: ['answer', 'count'], message: '"count" must be integer', code: 'type' },
          {
            path: ['answer', 'extra'],
            message: '"extra" is not an allowed field',
            code: 'additionalProperties',
          },
        ]),
      );
    } finally {
      await bureau.dispose();
    }
  });

  it('requires an answer to approve a question that has a schema, and still lets it be denied', async () => {
    const { bureau, handler, park } = await askingBureau();
    try {
      const review = await park({ signalName: 'ask', answerSchema: { type: 'boolean' } });

      const missing = await call(handler, 'bureau.reviews.resolve', {
        id: review.id,
        decision: 'approve',
      });

      expect(missing.error?.data?.issues).toEqual([
        {
          path: ['answer'],
          message: 'An answer matching the question’s schema is required to approve it',
          code: 'required',
        },
      ]);
      const denied = await call(handler, 'bureau.reviews.resolve', {
        id: review.id,
        decision: 'deny',
      });
      expect(denied.result).toMatchObject({ decision: 'deny', receipt: 'applied' });
    } finally {
      await bureau.dispose();
    }
  });

  it('takes any answer to a question with no schema, as before', async () => {
    const { bureau, handler, park } = await askingBureau();
    try {
      const review = await park({ signalName: 'ask' });
      const read = await call(handler, 'bureau.reviews.get', { id: review.id });
      expect(read.result).not.toHaveProperty('inputSchema');

      const applied = await call(handler, 'bureau.reviews.resolve', {
        id: review.id,
        decision: 'approve',
        answer: { anything: ['goes'] },
      });

      expect(applied.result).toMatchObject({ receipt: 'applied' });
    } finally {
      await bureau.dispose();
    }
  });

  it('lets a per-call schema replace the per-signal one, which applies only when a call gives none', async () => {
    const perSignal: HumanInputSchema = { type: 'string', enum: ['configured'] };
    const perCall: HumanInputSchema = { type: 'boolean' };
    const { bureau, handler, park } = await askingBureau({ ask: perSignal });
    try {
      const replaced = await park({ signalName: 'ask', answerSchema: perCall });
      const fallback = await park({ signalName: 'ask' });

      const replacedRead = await call(handler, 'bureau.reviews.get', { id: replaced.id });
      const fallbackRead = await call(handler, 'bureau.reviews.get', { id: fallback.id });
      expect(replacedRead.result?.['inputSchema']).toEqual(perCall);
      expect(fallbackRead.result?.['inputSchema']).toEqual(perSignal);
      // The per-signal answer no longer fits the question that replaced its schema, and the reverse.
      const old = await call(handler, 'bureau.reviews.resolve', {
        id: replaced.id,
        decision: 'approve',
        answer: 'configured',
      });
      expect(old.error?.data?.issues?.length).toBeGreaterThan(0);
      const wrong = await call(handler, 'bureau.reviews.resolve', {
        id: fallback.id,
        decision: 'approve',
        answer: true,
      });
      expect(wrong.error?.data?.issues?.length).toBeGreaterThan(0);
    } finally {
      await bureau.dispose();
    }
  });

  it('parks nothing for a schema over the limits, and tells the model why', async () => {
    const { bureau, ask } = await askingBureau(undefined, 'when-done');
    try {
      ask.arguments = {
        signalName: 'ask',
        answerSchema: { type: 'string', description: 'x'.repeat(40 * 1024) },
      };
      const run = await bureau.tasks.start('default', 'ask', { principal: 'api-key:tester' });
      await run.result();

      expect(bureau.reviews.list().some((review) => review.runId === run.id)).toBe(false);
      // The model reads the refusal as the tool's result.
      expect(ask.seen[0]?.content).toMatchObject({
        parked: false,
        error: 'invalid-answer-schema',
        signalName: 'ask',
        issues: [{ path: [], message: expect.stringContaining('bytes') }],
      });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('bureau.reviews.resolve `answer`, against a stubbed host', () => {
  function humanWait(overrides: Partial<PendingReview> = {}): PendingReview {
    return {
      kind: 'human-wait',
      id: 'human-wait:run-1:ask:0',
      runId: 'run-1',
      sessionId: 'session-1',
      signalName: 'ask',
      requestedAt: 0,
      ageMilliseconds: 0,
      status: 'pending',
      ...overrides,
    } as PendingReview;
  }

  function serve(review: PendingReview, record: ResolveReviewInput[], fail?: Error) {
    const host: BureauReviewsOperationHost = {
      reviews: {
        list: () => [review],
        get: async () => ({ ...review, status: 'pending' as const }),
        resolve: async (input) => {
          record.push(input);
          if (fail !== undefined) throw fail;
          return { id: input.id, kind: review.kind, decision: input.decision };
        },
      },
      ownership: { runOwner: async () => 'api-key:tester', mayAccess: mayAccessOwnedResource },
    };
    return createOperationHandler({
      operations: bureauReviewsOperations,
      host,
      authenticate: createOperationHandlerAuthenticator(authentication, {
        additionalScopes: BUREAU_SCOPES,
      }),
    });
  }

  it('hands the answer to the Bureau as the payload, falsy values included, and omits it when none was sent', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(humanWait(), record);
    const id = 'human-wait:run-1:ask:0';

    await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve', answer: false });
    await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve', answer: null });
    await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve' });

    expect(record.map((input) => Object.hasOwn(input, 'payload'))).toEqual([true, true, false]);
    expect(record[0]?.payload).toBe(false);
    expect(record[1]?.payload).toBeNull();
  });

  it('refuses an answer to a tool approval before the Bureau is reached', async () => {
    const record: ResolveReviewInput[] = [];
    const approval = {
      kind: 'tool-approval',
      id: 'approval:run-1:call-1',
      runId: 'run-1',
      sessionId: 'session-1',
      round: 0,
      approval: { callId: 'call-1', toolName: 't', arguments: {}, action: { type: 'input' } },
      requestedAt: 0,
      ageMilliseconds: 0,
      status: 'pending',
    } as unknown as PendingReview;
    const handler = serve(approval, record);

    const reply = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
      answer: 'yes',
    });

    expect(reply.error?.data?.httpStatus).toBe(422);
    expect(record).toEqual([]);
  });

  it('maps a ReviewAnswerInvalidError onto InvalidParams with its issues rooted at `answer`', async () => {
    const error = new ReviewAnswerInvalidError([
      { path: ['name'], message: '"name" is required', code: 'required' },
      { path: [], message: 'The answer must be of type object', code: 'type' },
    ]);
    const handler = serve(humanWait(), [], error);

    const reply = await call(handler, 'bureau.reviews.resolve', {
      id: 'human-wait:run-1:ask:0',
      decision: 'approve',
      answer: 1,
    });

    expect(reply.error?.data?.httpStatus).toBe(400);
    expect(reply.error?.data?.issues).toEqual([
      { path: ['answer', 'name'], message: '"name" is required', code: 'required' },
      { path: ['answer'], message: 'The answer must be of type object', code: 'type' },
    ]);
    expect(reviewFault(error, 'x')).toMatchObject({ code: 'InvalidParams' });
  });
});

describe('the answer check as a Bureau API', () => {
  it('is a BureauError with BAD_REQUEST that carries the issues', () => {
    const error = new ReviewAnswerInvalidError([{ path: [], message: 'm', code: 'type' }]);

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.name).toBe('ReviewAnswerInvalidError');
    expect(error.issues).toEqual([{ path: [], message: 'm', code: 'type' }]);
  });

  it('is the error `bureau.reviews.resolve` throws for a bad answer, and leaves the review pending', async () => {
    const { bureau, park } = await askingBureau();
    try {
      const review = await park({ signalName: 'ask', answerSchema: { type: 'boolean' } });

      const refusal = await rejectionOf(
        bureau.reviews.resolve({
          id: review.id,
          decision: 'approve',
          principal: 'api-key:tester',
          payload: 'yes',
        }),
      );
      expect(refusal).toBeInstanceOf(ReviewAnswerInvalidError);
      expect(bureau.reviews.list().some((candidate) => candidate.id === review.id)).toBe(true);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the answer that is checked is the answer that is delivered', () => {
  it('delivers a copy taken as the call starts, so changing the caller’s object afterwards changes nothing', async () => {
    const { bureau, park, ask } = await askingBureau();
    try {
      const review = await park({
        signalName: 'ask',
        answerSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      });
      const payload = { name: 'Ada' };

      const resolving = bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'api-key:tester',
        payload,
      });
      // The caller changes its object while the call is in flight.
      payload.name = 'changed';
      await resolving;

      await waitForCondition(() => ask.transcripts.length > 0, 'the run never continued');
      expect(ask.transcripts[0]).toContain('Ada');
      expect(ask.transcripts[0]).not.toContain('changed');
    } finally {
      await bureau.dispose();
    }
  });
});
