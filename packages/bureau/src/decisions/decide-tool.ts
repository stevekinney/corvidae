import { type DecisionRequest, DecisionSchemaError } from '@lostgradient/operative';
import { type AnyToolbox, createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import { ModelPolicyDeniedError } from '../file-agent-generate.ts';
import {
  DECISION_SCHEMA_MAXIMUM_BYTES,
  DecisionSchemaRefusedError,
  standardSchemaFromJsonSchema,
} from './json-schema-standard.ts';
import type { DecisionSource } from './types.ts';

/** The name of the tool Bureau offers a task. */
export const DECIDE_TOOL_NAME = 'decide';

const decideInput = z.object({
  kind: z
    .enum(['boolean', 'choice', 'scale', 'structured'])
    .describe(
      'boolean: a yes/no answer. choice: pick one of `options`. scale: rate on the ordered `levels`. structured: answer with an object that satisfies `schema`.',
    ),
  question: z.string().describe('The question to answer.'),
  context: z.string().optional().describe('Text the answer may depend on.'),
  options: z
    .array(z.object({ key: z.string(), label: z.string() }))
    .optional()
    .describe('For kind "choice": at least two options with distinct keys. Answers with a key.'),
  levels: z
    .array(z.string())
    .optional()
    .describe(
      'For kind "scale": at least two distinct level descriptions, lowest first. Answers with the level index.',
    ),
  schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      `For kind "structured": a JSON Schema (2020-12) of at most ${DECISION_SCHEMA_MAXIMUM_BYTES} bytes, without "pattern" or "$id".`,
    ),
});

/** Why the `decide` tool answered without a decision. */
export type DecideRefusalReason =
  | 'maximum-per-task'
  | 'invalid-request'
  | 'invalid-schema'
  | 'not-configured'
  | 'model-policy-denied'
  | 'model-answer-invalid';

/** What the `decide` tool returns. A refusal is a result, not a throw, so the agent can react. */
export type DecideToolResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly probability?: number;
      readonly rationale?: string;
      readonly provider: string;
      readonly model: string;
    }
  | {
      readonly ok: false;
      readonly refusal: DecideRefusalReason;
      readonly message: string;
      /** For `maximum-per-task`: the most calls one task may make. */
      readonly maximum?: number;
    };

/** What {@link createDecideToolbox} needs. */
export type DecideToolOptions = {
  readonly decisions: DecisionSource;
  /** The task's principal: the actor on the audit record. */
  readonly principal: string | undefined;
  /** The task the calls are made in: the audit record is filed under it, and the cap counts per it. */
  readonly taskId: string;
  /** The most calls one task may make. */
  readonly maximumPerTask: number;
};

/** What a run needs to be offered the `decide` tool: everything but the task it runs as. */
export type DecideToolWiring = Omit<DecideToolOptions, 'taskId'>;

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { code?: string }).code
    : undefined;
}

/** The tool context's signal as an `AbortSignal`: an `AbortSignalLike` that is not one is dropped. */
function abortSignalOf(signal: unknown): AbortSignal | undefined {
  return signal instanceof AbortSignal ? signal : undefined;
}

function requestOf(input: z.infer<typeof decideInput>): DecisionRequest {
  const base = {
    question: input.question,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
  switch (input.kind) {
    case 'boolean':
      return { kind: 'boolean', ...base };
    case 'choice':
      return { kind: 'choice', ...base, options: input.options ?? [] };
    case 'scale':
      return { kind: 'scale', ...base, levels: input.levels ?? [] };
    case 'structured':
      return {
        kind: 'structured',
        ...base,
        schema: standardSchemaFromJsonSchema(input.schema) as never,
      };
  }
}

/**
 * A toolbox holding the `decide` tool for one task. The tool acts as the task's principal, files
 * its audit record under the task, and refuses with `maximum-per-task` from the call after the
 * `maximumPerTask`th. The count lives in this toolbox, so a task recovered after a restart starts
 * counting again.
 */
export function createDecideToolbox(options: DecideToolOptions): AnyToolbox {
  let calls = 0;
  const tool = createTool({
    name: DECIDE_TOOL_NAME,
    // COR-1947: a read to a chat's permission mode: it asks a model a question and changes nothing
    // but its own audit record and call count. A version, because Armorer can only raise an
    // approval for a versioned tool, and `always` asks about it.
    version: '1.0.0',
    metadata: { readOnly: true, summary: 'Decide: {question}' },
    description:
      'Ask a model for a typed answer to one question: a yes/no, a choice among options, a rating on a scale, or an object that satisfies a JSON Schema. Returns { ok: true, value, ... } or { ok: false, refusal, message }.',
    input: decideInput,
    execute: async (input, context): Promise<DecideToolResult> => {
      // The caller owns `context`: read the signal once, before the first await.
      const signal = abortSignalOf(context.signal);
      calls += 1;
      if (calls > options.maximumPerTask) {
        return {
          ok: false,
          refusal: 'maximum-per-task',
          message: `This task has already made ${options.maximumPerTask} decisions, the most one task may make.`,
          maximum: options.maximumPerTask,
        };
      }
      let request: DecisionRequest;
      try {
        request = requestOf(input);
      } catch (error) {
        if (error instanceof DecisionSchemaRefusedError) {
          return { ok: false, refusal: 'invalid-schema', message: error.message };
        }
        throw error;
      }
      try {
        const decision = await options.decisions.decide(request, {
          taskId: options.taskId,
          ...(options.principal === undefined ? {} : { principal: options.principal }),
          ...(signal === undefined ? {} : { signal }),
        });
        return {
          ok: true,
          value: decision.value,
          ...(decision.probability === undefined ? {} : { probability: decision.probability }),
          ...(decision.rationale === undefined ? {} : { rationale: decision.rationale }),
          provider: decision.provider,
          model: decision.model,
        };
      } catch (error) {
        if (error instanceof DecisionSchemaError) {
          return {
            ok: false,
            refusal: 'model-answer-invalid',
            message: 'The model did not give an answer that satisfies the request.',
          };
        }
        const code = codeOf(error);
        if (code === 'NOT_CONFIGURED') {
          return {
            ok: false,
            refusal: 'not-configured',
            message: 'No model is configured to answer decisions.',
          };
        }
        if (error instanceof ModelPolicyDeniedError) {
          // The policy leaves no model that may answer; the agent can read why and carry on.
          return { ok: false, refusal: 'model-policy-denied', message: error.message };
        }
        if (code === 'BAD_REQUEST') {
          return {
            ok: false,
            refusal: 'invalid-request',
            message: error instanceof Error ? error.message : 'The request is not valid.',
          };
        }
        throw error;
      }
    },
  });
  return createToolbox([tool]);
}
