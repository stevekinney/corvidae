import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createToolbox, isStandardSchema, isZodSchema, wrapStandardSchema } from 'armorer';
import { Conversation, type TokenUsage } from 'conversationalist';
import { z, type ZodType } from 'zod';

import { toOutputJsonSchema, validateOutput } from '../structured-output/response-schema';
import type { ResponseFormat } from '../structured-output/types';
import type { GenerateFunction } from '../types';
import { DecisionSchemaError } from './errors';
import { assertValidDecisionRequest } from './request-validation';
import type {
  DecideOptions,
  Decision,
  DecisionKind,
  DecisionModel,
  DecisionRequest,
} from './types';
import { addTokenUsage } from './usage';

/** The identity a language model reports on every {@link Decision} it makes. */
export interface DecisionModelDescriptor {
  /** The provider that serves the model, such as `anthropic`. */
  readonly provider: string;
  /** The provider-native model identifier. A `BackendDescriptor` satisfies this structurally. */
  readonly model: string;
}

/** Options for {@link llmDecisionModel}. */
export interface LlmDecisionModelOptions {
  /** The language model call. It receives a tool-free conversation and a JSON `responseFormat`. */
  readonly generate: GenerateFunction;
  /** Names the provider and model on every decision and in {@link DecisionModel.name}. */
  readonly descriptor: DecisionModelDescriptor;
}

const MAXIMUM_ATTEMPTS = 2;
const MAXIMUM_VALIDATION_DETAIL = 1_000;
const RESPONSE_NAME = 'decision';
const ALL_KINDS: ReadonlySet<DecisionKind> = new Set(['boolean', 'choice', 'scale', 'structured']);

const SYSTEM_PROMPT =
  'You answer one decision question. Reply with only a JSON object in the requested shape: ' +
  'no prose, no code fence.';

interface AnswerShape {
  readonly responseFormat: ResponseFormat;
  readonly schema: ZodType;
  readonly extract: (validated: unknown) => unknown;
}

function structuredShape(schema: StandardSchemaV1 | ZodType): AnswerShape {
  if (isZodSchema(schema)) {
    return {
      responseFormat: {
        type: 'json_schema',
        schema: toOutputJsonSchema(schema),
        name: RESPONSE_NAME,
      },
      schema,
      extract: (validated) => validated,
    };
  }
  const standard: unknown = schema;
  if (!isStandardSchema(standard)) {
    throw new TypeError('A structured request needs a Zod schema or a Standard Schema.');
  }
  const converter = (standard['~standard'] as { jsonSchema?: StandardJsonSchemaConverter })
    .jsonSchema;
  const responseFormat: ResponseFormat =
    converter === undefined
      ? { type: 'json' }
      : {
          type: 'json_schema',
          schema: converter.input({ target: 'draft-2020-12' }),
          name: RESPONSE_NAME,
        };
  return {
    responseFormat,
    schema: wrapStandardSchema(standard),
    extract: (validated) => validated,
  };
}

interface StandardJsonSchemaConverter {
  readonly input: (options: { target: string }) => Record<string, unknown>;
}

function shapeFor(request: DecisionRequest): AnswerShape {
  switch (request.kind) {
    case 'boolean': {
      const schema = z.object({ answer: z.boolean() });
      return {
        responseFormat: {
          type: 'json_schema',
          schema: toOutputJsonSchema(schema),
          name: RESPONSE_NAME,
        },
        schema,
        extract: (validated) => (validated as { answer: boolean }).answer,
      };
    }
    case 'choice': {
      const keys = request.options.map((option) => option.key) as [string, ...string[]];
      const schema = z.object({ key: z.enum(keys) });
      return {
        responseFormat: {
          type: 'json_schema',
          schema: toOutputJsonSchema(schema),
          name: RESPONSE_NAME,
        },
        schema,
        extract: (validated) => (validated as { key: string }).key,
      };
    }
    case 'scale': {
      const schema = z.object({
        level: z
          .number()
          .int()
          .min(0)
          .max(request.levels.length - 1),
      });
      return {
        responseFormat: {
          type: 'json_schema',
          schema: toOutputJsonSchema(schema),
          name: RESPONSE_NAME,
        },
        schema,
        extract: (validated) => (validated as { level: number }).level,
      };
    }
    case 'structured':
      return structuredShape(request.schema);
  }
}

function describeRequest(request: DecisionRequest): string {
  const lines = [`Question: ${request.question}`];
  if (request.context !== undefined && request.context.trim() !== '') {
    lines.push('', 'Context:', request.context);
  }
  switch (request.kind) {
    case 'boolean':
      lines.push('', 'Answer with {"answer": true} or {"answer": false}.');
      break;
    case 'choice':
      lines.push('', 'Options:');
      for (const option of request.options) lines.push(`- ${option.key}: ${option.label}`);
      lines.push('', 'Answer with {"key": "<one option key>"}.');
      break;
    case 'scale':
      lines.push('', 'Levels, lowest first (answer with the zero-based index):');
      request.levels.forEach((level, index) => lines.push(`${index}: ${level}`));
      lines.push('', 'Answer with {"level": <index>}.');
      break;
    case 'structured':
      lines.push('', 'Answer with a JSON object that satisfies the requested schema.');
      break;
  }
  return lines.join('\n');
}

function stripCodeFence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(text);
  return match?.[1] ?? text;
}

function validationDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAXIMUM_VALIDATION_DETAIL
    ? `${text.slice(0, MAXIMUM_VALIDATION_DETAIL)}...`
    : text;
}

/**
 * A {@link DecisionModel} backed by any language model, serving every kind by
 * asking for structured output (`boolean` as `{ answer }`, `choice` as
 * `{ key }`, `scale` as `{ level }`, `structured` as the caller's schema).
 *
 * The answer is validated. A first answer that fails validation is retried
 * once, with the bad answer and the validation error appended to the
 * conversation; a second failure throws {@link DecisionSchemaError}. Usage is
 * summed across attempts. An error thrown by `generate` is a provider error
 * and is neither retried nor wrapped, whichever attempt it comes from. A
 * request that is malformed throws a `TypeError` before `generate` is called.
 */
export function llmDecisionModel(options: LlmDecisionModelOptions): DecisionModel {
  // Snapshot what `decide` reads after its first `await`: the caller owns `options`.
  const { generate } = options;
  const provider = options.descriptor?.provider;
  const model = options.descriptor?.model;
  if (typeof generate !== 'function') {
    throw new TypeError('llmDecisionModel needs a generate function.');
  }
  if (
    typeof provider !== 'string' ||
    provider === '' ||
    typeof model !== 'string' ||
    model === ''
  ) {
    throw new TypeError('llmDecisionModel needs a descriptor with a provider and a model.');
  }
  return {
    name: `${provider}/${model}`,
    kinds: new Set(ALL_KINDS),
    async decide(
      request: DecisionRequest,
      decideOptions?: DecideOptions,
    ): Promise<Decision<unknown>> {
      assertValidDecisionRequest(request);
      const shape = shapeFor(request);
      const signal = decideOptions?.signal;
      const conversation = new Conversation();
      conversation.appendSystemMessage(SYSTEM_PROMPT);
      conversation.appendUserMessage(describeRequest(request));

      let usage: TokenUsage | undefined;
      let lastFailure: unknown;
      for (let attempt = 1; attempt <= MAXIMUM_ATTEMPTS; attempt += 1) {
        signal?.throwIfAborted();
        const response = await generate({
          conversation,
          step: attempt - 1,
          signal,
          toolbox: createToolbox(),
          responseFormat: shape.responseFormat,
        });
        usage = addTokenUsage(usage, response.usage);

        const outcome = await validateOutput(shape.schema, stripCodeFence(response.content));
        if (outcome.success) {
          return {
            value: shape.extract(outcome.value),
            provider,
            model,
            ...(usage === undefined ? {} : { usage }),
          };
        }
        lastFailure = outcome.error;
        if (attempt < MAXIMUM_ATTEMPTS) {
          if (response.messageAppended !== true)
            conversation.appendAssistantMessage(response.content);
          conversation.appendUserMessage(
            `Your previous answer did not satisfy the required format: ${validationDetail(outcome.error)}\n` +
              'Answer the question again with only a JSON object that fixes this.',
          );
        }
      }
      throw new DecisionSchemaError(
        { attempts: MAXIMUM_ATTEMPTS, usage, validation: validationDetail(lastFailure) },
        { cause: lastFailure },
      );
    },
  };
}
