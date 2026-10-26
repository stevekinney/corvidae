import { describe, expect, it } from 'bun:test';
import type { Conversation } from 'conversationalist';
import { z } from 'zod';

import { createScriptedGenerate } from '../test/scripted-generate';
import type { GenerateResponse, TokenUsage } from '../types';
import { DecisionSchemaError } from './errors';
import { llmDecisionModel } from './llm-decision-model';

const descriptor = { provider: 'anthropic', model: 'claude-haiku-5-5' } as const;

function reply(content: string, usage?: TokenUsage): GenerateResponse {
  return { content, toolCalls: [], ...(usage ? { usage } : {}) };
}

function usage(prompt: number, completion: number): TokenUsage {
  return { prompt, completion, total: prompt + completion };
}

function transcript(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    );
}

const booleanRequest = { kind: 'boolean', question: 'Is the sky blue?' } as const;

describe('llmDecisionModel outcome matrix', () => {
  it('resolves once on a valid first answer', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"answer":true}', usage(10, 2)) },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide(booleanRequest);

    expect(decision).toEqual({
      value: true,
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      usage: usage(10, 2),
    });
    expect(generate.callCount).toBe(1);
  });

  it('resolves after one retry with the validation error appended and usage summed', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"answer":"yes"}', usage(10, 2)) },
      { kind: 'respond', response: reply('{"answer":false}', usage(30, 4)) },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide(booleanRequest);

    expect(decision.value).toBe(false);
    expect(decision.usage).toEqual(usage(40, 6));
    expect(generate.callCount).toBe(2);
    const retried = transcript(generate.calls[1]!.context.conversation);
    expect(retried.at(-2)).toBe('{"answer":"yes"}');
    expect(retried.at(-1)).toContain('did not satisfy');
    expect(retried.at(-1)).toContain('answer');
  });

  it('throws DecisionSchemaError with usage summed after two invalid answers', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"answer":"yes"}', usage(10, 2)) },
      { kind: 'respond', response: reply('not json at all', usage(30, 4)) },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const failure = await model.decide(booleanRequest).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DecisionSchemaError);
    const schemaError = failure as DecisionSchemaError;
    expect(schemaError.attempts).toBe(2);
    expect(schemaError.usage).toEqual(usage(40, 6));
    expect(generate.callCount).toBe(2);
  });

  it('rejects with the provider error and does not retry on a first-attempt provider error', async () => {
    const providerError = new Error('529 overloaded');
    const generate = createScriptedGenerate([{ kind: 'fail', error: providerError }]);
    const model = llmDecisionModel({ generate, descriptor });

    const failure = await model.decide(booleanRequest).catch((error: unknown) => error);

    expect(failure).toBe(providerError);
    expect(generate.callCount).toBe(1);
  });

  it('rejects with the provider error when the retry attempt fails', async () => {
    const providerError = new Error('500 internal');
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"answer":"maybe"}', usage(10, 2)) },
      { kind: 'fail', error: providerError },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const failure = await model.decide(booleanRequest).catch((error: unknown) => error);

    expect(failure).toBe(providerError);
    expect(generate.callCount).toBe(2);
  });
});

describe('llmDecisionModel kinds', () => {
  it('serves all four kinds', () => {
    const model = llmDecisionModel({ generate: createScriptedGenerate([]), descriptor });
    expect([...model.kinds].toSorted()).toEqual(['boolean', 'choice', 'scale', 'structured']);
    expect(model.name).toBe('anthropic/claude-haiku-5-5');
  });

  it('answers a choice with the option key and sends an enum of the keys', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"key":"billing"}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide({
      kind: 'choice',
      question: 'Which team?',
      context: 'Customer was double charged.',
      options: [
        { key: 'billing', label: 'Payments and invoices' },
        { key: 'tech', label: 'Bugs and outages' },
      ],
    });

    expect(decision.value).toBe('billing');
    expect(decision.usage).toBeUndefined();
    const format = generate.calls[0]!.context.responseFormat;
    expect(format?.type).toBe('json_schema');
    expect(JSON.stringify(format)).toContain('"enum":["billing","tech"]');
    const prompt = transcript(generate.calls[0]!.context.conversation).join('\n');
    expect(prompt).toContain('Which team?');
    expect(prompt).toContain('Customer was double charged.');
    expect(prompt).toContain('Payments and invoices');
  });

  it('rejects a choice answer that names no offered key', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"key":"sales"}') },
      { kind: 'respond', response: reply('{"key":"tech"}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide({
      kind: 'choice',
      question: 'Which team?',
      options: [
        { key: 'billing', label: 'Payments' },
        { key: 'tech', label: 'Bugs' },
      ],
    });

    expect(decision.value).toBe('tech');
    expect(generate.callCount).toBe(2);
  });

  it('answers a scale with the level index and rejects an out-of-range index', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"level":3}') },
      { kind: 'respond', response: reply('{"level":2}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide({
      kind: 'scale',
      question: 'How urgent?',
      levels: ['low', 'medium', 'high'],
    });

    expect(decision.value).toBe(2);
    expect(generate.callCount).toBe(2);
  });

  it('answers a structured request with the validated object', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"team":"billing","urgent":true}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });
    const schema = z.object({ team: z.string(), urgent: z.boolean() });

    const decision = await model.decide({ kind: 'structured', question: 'Triage this.', schema });

    expect(decision.value).toEqual({ team: 'billing', urgent: true });
    const format = generate.calls[0]!.context.responseFormat;
    expect(format?.type).toBe('json_schema');
    expect(JSON.stringify(format)).toContain('urgent');
  });

  it('retries a structured answer that fails the Zod schema', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"team":1}') },
      { kind: 'respond', response: reply('{"team":"tech"}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide({
      kind: 'structured',
      question: 'Triage this.',
      schema: z.object({ team: z.string() }),
    });

    expect(decision.value).toEqual({ team: 'tech' });
  });

  it('validates with a bare Standard Schema and asks only for JSON', async () => {
    const generate = createScriptedGenerate([{ kind: 'respond', response: reply('{"n":4}') }]);
    const model = llmDecisionModel({ generate, descriptor });
    const schema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (input: unknown) => {
          const n = (input as { n?: unknown }).n;
          return typeof n === 'number' ? { value: { n: n * 2 } } : { issues: [{ message: 'n' }] };
        },
      },
    } as const;

    const decision = await model.decide({ kind: 'structured', question: 'Double it.', schema });

    expect(decision.value).toEqual({ n: 8 });
    expect(generate.calls[0]!.context.responseFormat).toEqual({ type: 'json' });
  });

  it('uses the JSON Schema a Standard JSON Schema exposes', async () => {
    const generate = createScriptedGenerate([{ kind: 'respond', response: reply('{"n":4}') }]);
    const model = llmDecisionModel({ generate, descriptor });
    const jsonSchema = { type: 'object', properties: { n: { type: 'number' } } };
    const schema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (input: unknown) => ({ value: input }),
        jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
      },
    } as const;

    await model.decide({ kind: 'structured', question: 'Double it.', schema });

    expect(generate.calls[0]!.context.responseFormat).toEqual({
      type: 'json_schema',
      schema: jsonSchema,
      name: 'decision',
    });
  });

  it('tolerates a fenced JSON answer', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('```json\n{"answer":true}\n```') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    const decision = await model.decide(booleanRequest);

    expect(decision.value).toBe(true);
    expect(generate.callCount).toBe(1);
  });

  it('forwards the abort signal and never retries once aborted', async () => {
    const controller = new AbortController();
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"answer":"maybe"}') },
    ]);
    const base = generate;
    const model = llmDecisionModel({
      generate: async (context) => {
        const response = await base(context);
        controller.abort(new Error('stop'));
        return response;
      },
      descriptor,
    });

    const failure = await model
      .decide(booleanRequest, { signal: controller.signal })
      .catch((error: unknown) => error);

    expect((failure as Error).message).toBe('stop');
    expect(base.callCount).toBe(1);
    expect(base.calls[0]!.context.signal).toBe(controller.signal);
  });
});

describe('llmDecisionModel prompt', () => {
  function firstPrompt(generate: ReturnType<typeof createScriptedGenerate>): string {
    return transcript(generate.calls[0]!.context.conversation).join('\n');
  }

  it('states the structured schema, with its descriptions, in the prompt', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"team":"billing"}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    await model.decide({
      kind: 'structured',
      question: 'Triage this.',
      schema: z.object({ team: z.enum(['billing', 'tech']).describe('The owning team') }),
    });

    const prompt = firstPrompt(generate);
    expect(prompt).toContain('"enum":["billing","tech"]');
    expect(prompt).toContain('The owning team');
  });

  it('states the choice enum and the scale range in the prompt', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"key":"a"}') },
      { kind: 'respond', response: reply('{"level":1}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor });

    await model.decide({
      kind: 'choice',
      question: 'Which?',
      options: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
    });
    await model.decide({ kind: 'scale', question: 'How?', levels: ['low', 'high'] });

    expect(transcript(generate.calls[0]!.context.conversation).join('\n')).toContain(
      '"enum":["a","b"]',
    );
    const scalePrompt = transcript(generate.calls[1]!.context.conversation).join('\n');
    expect(scalePrompt).toContain('"minimum":0');
    expect(scalePrompt).toContain('"maximum":1');
  });
});

describe('llmDecisionModel construction', () => {
  it('reports the identity it was built with even if the caller edits the descriptor later', async () => {
    const mutable = { provider: 'anthropic', model: 'claude-haiku-5-5' };
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply('{"answer":true}') },
    ]);
    const model = llmDecisionModel({ generate, descriptor: mutable });
    mutable.provider = 'changed';
    mutable.model = 'changed';

    const decision = await model.decide(booleanRequest);

    expect(decision.provider).toBe('anthropic');
    expect(decision.model).toBe('claude-haiku-5-5');
    expect(model.name).toBe('anthropic/claude-haiku-5-5');
  });

  it.each([
    ['no generate', { descriptor }],
    ['no descriptor', { generate: createScriptedGenerate([]) }],
    [
      'an empty model',
      { generate: createScriptedGenerate([]), descriptor: { provider: 'a', model: '' } },
    ],
  ] as const)('rejects %s', (_name, options) => {
    expect(() => llmDecisionModel(options as never)).toThrow(TypeError);
  });

  it('rejects a request that is not an object before calling the model', async () => {
    const generate = createScriptedGenerate([]);
    const model = llmDecisionModel({ generate, descriptor });

    const failure = await model.decide(null as never).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect(generate.callCount).toBe(0);
  });
});

describe('llmDecisionModel request validation', () => {
  const model = llmDecisionModel({ generate: createScriptedGenerate([]), descriptor });

  it.each([
    ['empty question', { kind: 'boolean', question: ' ' }],
    [
      'duplicate keys',
      {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'a', label: 'A' },
          { key: 'a', label: 'B' },
        ],
      },
    ],
    [
      'empty label',
      {
        kind: 'choice',
        question: 'q',
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: '' },
        ],
      },
    ],
    ['one option', { kind: 'choice', question: 'q', options: [{ key: 'a', label: 'A' }] }],
    ['one level', { kind: 'scale', question: 'q', levels: ['only'] }],
    ['repeated level', { kind: 'scale', question: 'q', levels: ['a', 'a'] }],
    ['empty level', { kind: 'scale', question: 'q', levels: ['a', ''] }],
    ['not a schema', { kind: 'structured', question: 'q', schema: {} }],
  ] as const)('rejects %s before calling the model', async (_name, request) => {
    const generate = createScriptedGenerate([]);
    const guarded = llmDecisionModel({ generate, descriptor });

    const failure = await guarded.decide(request as never).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect(generate.callCount).toBe(0);
    expect(model.name).toBe('anthropic/claude-haiku-5-5');
  });
});
