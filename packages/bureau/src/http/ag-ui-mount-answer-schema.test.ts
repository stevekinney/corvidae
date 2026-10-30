/**
 * COR-1804 — over AG-UI, a question that carries its own answer schema is an interrupt whose
 * `responseSchema` embeds that schema as `properties.answer` (keeping `decision` and `reason`), and
 * a resume whose answer does not fit it is refused `INVALID_INPUT` before anything is applied.
 */
import { EventType, type ResumeEntry } from '@ag-ui/core';
import { stopWhen } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import {
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { responseSchemaFor } from './ag-ui-interrupts.ts';
import { bureauMetadata, readAgUiStream } from './ag-ui-stream.test-support.ts';

const answerSchema = {
  type: 'object',
  properties: { environment: { enum: ['staging', 'production'] }, replicas: { type: 'integer' } },
  required: ['environment'],
  additionalProperties: false,
} as const;

const askWith = (schema: Record<string, unknown>) => ({
  kind: 'respond' as const,
  response: {
    content: 'Asking.',
    toolCalls: [
      {
        id: 'call-1',
        name: 'requestHumanInput',
        arguments: { signalName: 'deploy', prompt: 'Where to?', answerSchema: schema },
      },
    ],
  },
});
const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

function resumeRequest(entries: ResumeEntry[]): Request {
  return startRequest(runAgentInput({ runId: 'client-run-2', messages: [], resume: entries }));
}

function resolved(interruptId: string, payload: unknown): ResumeEntry {
  return { interruptId, status: 'resolved', payload };
}

async function withHarness<T>(
  body: (harness: Harness) => Promise<T>,
  schema: Record<string, unknown> = answerSchema,
): Promise<T> {
  const harness = await openHarness({
    script: [askWith(schema), say('Deploying.')],
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

async function startUntilInterrupted(harness: Harness) {
  const frames = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
  const finished = frames.at(-1)!.event as {
    outcome: { type: string; interrupts: Array<{ id: string; responseSchema: unknown }> };
  };
  return {
    nativeRunId: String(bureauMetadata(frames[0]!.event)['runId']),
    interrupts: finished.outcome.interrupts,
  };
}

describe('a human wait with an answer schema, over AG-UI', () => {
  it('advertises decision, reason and the answer schema as the interrupt’s responseSchema', async () => {
    await withHarness(async (harness) => {
      const { interrupts } = await startUntilInterrupted(harness);

      expect(interrupts).toHaveLength(1);
      expect(interrupts[0]!.responseSchema).toEqual(responseSchemaFor(answerSchema));
      const advertised = interrupts[0]!.responseSchema as {
        properties: Record<string, unknown>;
      };
      expect(advertised.properties['answer']).toEqual(answerSchema);
      expect(Object.keys(advertised.properties)).toContain('decision');
      expect(Object.keys(advertised.properties)).toContain('reason');
    });
  });

  it('refuses a resume whose answer does not fit, names the field, and leaves the review pending', async () => {
    await withHarness(async (harness) => {
      const { handler, bureau } = harness;
      const { interrupts } = await startUntilInterrupted(harness);
      const id = interrupts[0]!.id;

      const frames = await readAgUiStream(
        await handler(
          resumeRequest([resolved(id, { decision: 'approve', answer: { environment: 'qa' } })]),
        ),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
      expect((frames[0]!.event as unknown as { message: string }).message).toContain(
        '"environment" must be one of "staging", "production"',
      );
      expect(bureau.reviews.list().map((review) => review.id)).toEqual([id]);
    });
  });

  it('refuses an approval that carries no answer', async () => {
    await withHarness(async (harness) => {
      const { interrupts } = await startUntilInterrupted(harness);

      const frames = await readAgUiStream(
        await harness.handler(
          resumeRequest([resolved(interrupts[0]!.id, { decision: 'approve' })]),
        ),
      );

      expect(frames[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
      expect(harness.bureau.reviews.list()).toHaveLength(1);
    });
  });

  it('delivers an answer that fits, and lets the question be denied with none', async () => {
    await withHarness(async (harness) => {
      const { interrupts } = await startUntilInterrupted(harness);

      const frames = await readAgUiStream(
        await harness.handler(
          resumeRequest([
            resolved(interrupts[0]!.id, {
              decision: 'approve',
              answer: { environment: 'staging', replicas: 2 },
            }),
          ]),
        ),
      );

      expect(frames.at(-1)!.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'success' },
      });
      expect(harness.bureau.reviews.list()).toHaveLength(0);
    });

    await withHarness(async (harness) => {
      const { interrupts } = await startUntilInterrupted(harness);

      const frames = await readAgUiStream(
        await harness.handler(resumeRequest([resolved(interrupts[0]!.id, { decision: 'deny' })])),
      );

      expect(frames.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
      expect(harness.bureau.reviews.list()).toHaveLength(0);
    });
  });
});

describe('a typed answer to a question with a schema, over AG-UI (COR-1804)', () => {
  // The chat can only type: it sends the answer as the text the person wrote.
  const succeeded = (frames: Awaited<ReturnType<typeof readAgUiStream>>) =>
    expect(frames.at(-1)!.event).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'success' },
    });

  it('answers a string question with the text as written', async () => {
    await withHarness(
      async (harness) => {
        const { interrupts } = await startUntilInterrupted(harness);
        const frames = await readAgUiStream(
          await harness.handler(
            resumeRequest([
              resolved(interrupts[0]!.id, { decision: 'approve', answer: '{"a": 1}' }),
            ]),
          ),
        );

        succeeded(frames);
        expect(harness.bureau.reviews.list()).toHaveLength(0);
      },
      { type: 'string' },
    );
  });

  it('reads the text as the integer a question asks for', async () => {
    await withHarness(
      async (harness) => {
        const { interrupts } = await startUntilInterrupted(harness);
        const frames = await readAgUiStream(
          await harness.handler(
            resumeRequest([resolved(interrupts[0]!.id, { decision: 'approve', answer: '3' })]),
          ),
        );

        succeeded(frames);
        expect(harness.bureau.reviews.list()).toHaveLength(0);
      },
      { type: 'integer', minimum: 1, maximum: 5 },
    );
  });

  it('reads the text as JSON for an object question', async () => {
    await withHarness(async (harness) => {
      const { interrupts } = await startUntilInterrupted(harness);
      const frames = await readAgUiStream(
        await harness.handler(
          resumeRequest([
            resolved(interrupts[0]!.id, {
              decision: 'approve',
              answer: '{"environment":"staging","replicas":2}',
            }),
          ]),
        ),
      );

      succeeded(frames);
      expect(harness.bureau.reviews.list()).toHaveLength(0);
    });
  });

  it('refuses text that is not the integer, leaves the review pending, and takes a later valid answer', async () => {
    await withHarness(
      async (harness) => {
        const { interrupts } = await startUntilInterrupted(harness);
        const id = interrupts[0]!.id;

        for (const text of ['three', '9']) {
          const refused = await readAgUiStream(
            await harness.handler(
              resumeRequest([resolved(id, { decision: 'approve', answer: text })]),
            ),
          );
          expect(refused).toHaveLength(1);
          expect(refused[0]!.event).toMatchObject({ code: 'INVALID_INPUT' });
          expect(harness.bureau.reviews.list().map((review) => review.id)).toEqual([id]);
        }

        succeeded(
          await readAgUiStream(
            await harness.handler(
              resumeRequest([resolved(id, { decision: 'approve', answer: '3' })]),
            ),
          ),
        );
        expect(harness.bureau.reviews.list()).toHaveLength(0);
      },
      { type: 'integer', minimum: 1, maximum: 5 },
    );
  });
});

describe('a retried typed answer over AG-UI (COR-1804)', () => {
  const kinds = (frames: Awaited<ReturnType<typeof readAgUiStream>>) =>
    frames.map((frame) => frame.event as unknown as { type: string; code?: string });

  it('answers an exact retry of a completed typed resume with its receipt, not a conflict', async () => {
    await withHarness(
      async (harness) => {
        const { interrupts } = await startUntilInterrupted(harness);
        const id = interrupts[0]!.id;
        // The retry sends the same entries again, as a client does after a lost response.
        const entries = [resolved(id, { decision: 'approve', answer: '3' })];

        const first = await readAgUiStream(await harness.handler(resumeRequest(entries)));
        const retry = await readAgUiStream(await harness.handler(resumeRequest(entries)));

        expect(kinds(first).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
        expect(kinds(retry).map((event) => event.code)).not.toContain('RESUME_CONFLICT');
        expect(kinds(retry).at(-1)).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'success' },
        });
      },
      { type: 'integer', minimum: 1, maximum: 5 },
    );
  });

  it('still refuses the same interrupt answered differently as a conflict', async () => {
    await withHarness(
      async (harness) => {
        const { interrupts } = await startUntilInterrupted(harness);
        const id = interrupts[0]!.id;

        await readAgUiStream(
          await harness.handler(
            resumeRequest([resolved(id, { decision: 'approve', answer: '3' })]),
          ),
        );
        const other = await readAgUiStream(
          await harness.handler(
            resumeRequest([resolved(id, { decision: 'approve', answer: '4' })]),
          ),
        );

        expect(kinds(other).at(-1)).not.toMatchObject({ outcome: { type: 'success' } });
      },
      { type: 'integer', minimum: 1, maximum: 5 },
    );
  });

  it('takes an enum-plus-other answer that looks like a number as the string it is', async () => {
    const ports = {
      anyOf: [{ enum: ['8080', '3000'] }, { type: 'string' }],
      'x-allowOther': true,
    };
    for (const answer of ['8080', 'other text', '42']) {
      await withHarness(async (harness) => {
        const { interrupts } = await startUntilInterrupted(harness);
        const frames = await readAgUiStream(
          await harness.handler(
            resumeRequest([resolved(interrupts[0]!.id, { decision: 'approve', answer })]),
          ),
        );

        expect(kinds(frames).at(-1)).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'success' },
        });
      }, ports);
    }
  });
});
