/**
 * `bureau.decisions.decide`: put a typed question to a model through `Bureau.decisions.decide`
 * (COR-1709).
 *
 * The operation spends a paid model's tokens, so it requires `bureau.decisions:write`; there is no
 * resource an owner reaches without it. The principal the caller authenticated as is recorded on
 * the `decision.made` audit record and is never a payload field. `commandId` names the call for
 * the caller's own bookkeeping, but the operation takes no ledger entry: a retry re-calls the
 * model, and no decision value is stored. `context` is bounded by the handler's request body limit
 * (`maxRequestBodyBytes`), which the transport enforces before this runs.
 *
 * `schema` of a `structured` request is JSON Schema 2020-12 of at most 16 KiB, with no `$id` and
 * no `pattern`; it is turned into a Standard Schema validator, and the model is asked for exactly
 * that shape.
 *
 * | Outcome                                         | Fault                    | `data`                        |
 * | ----------------------------------------------- | ------------------------ | ----------------------------- |
 * | a malformed request or schema                   | `InvalidParams`          | `issues`                      |
 * | no model can answer                             | `UnsupportedCapability`  | `capability: 'generate'`      |
 * | the model's answer failed validation twice      | `Unprocessable`          | `reason: 'decision-schema'`   |
 *
 * @module decisions-operations
 */

import { type DecisionRequest, DecisionSchemaError } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError } from '../../create-bureau.ts';
import {
  DecisionSchemaRefusedError,
  standardSchemaFromJsonSchema,
} from '../../decisions/json-schema-standard.ts';
import type { BureauDecisions } from '../../decisions/types.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** What `bureau.decisions.decide` reads from the handler's `host`. */
export type BureauDecisionsOperationHost = {
  readonly decisions: Pick<BureauDecisions, 'decide'>;
};

const write = {
  kind: 'scoped',
  scopes: { kind: 'allOf', scopes: ['bureau.decisions:write'] },
} as const;

const decideInput = z.object({
  commandId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The caller’s own identifier for the call. It is not an idempotency key: a retry re-calls the model.',
    ),
  kind: z
    .enum(['boolean', 'choice', 'scale', 'structured'])
    .describe('The kind of answer wanted: a boolean, one of the options, a level, or an object.'),
  question: z.string().describe('The question to ask the model.'),
  context: z
    .string()
    .optional()
    .describe('Text the model may use to answer, bounded by the handler’s request body limit.'),
  options: z
    .array(z.object({ key: z.string(), label: z.string() }).strict())
    .optional()
    .describe('For `choice`: at least two options with distinct keys.'),
  levels: z
    .array(z.string())
    .optional()
    .describe('For `scale`: at least two distinct level descriptions, lowest first.'),
  schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('For `structured`: JSON Schema 2020-12, at most 16 KiB, without `$id` or `pattern`.'),
});

const decideOutput = z.object({
  /** A `boolean`, an option `key`, a level index, or the validated object, by `kind`. */
  value: z.unknown(),
  probability: z.number().optional(),
  rationale: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

function invalidParams(path: string, message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [{ path: [path], message, code: 'custom' }] },
  };
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
      try {
        return {
          kind: 'structured',
          ...base,
          schema: standardSchemaFromJsonSchema(input.schema),
        };
      } catch (error) {
        if (error instanceof DecisionSchemaRefusedError) {
          throw invalidParams('schema', error.message);
        }
        throw error;
      }
  }
}

export const decisionsDecideOperation = defineOperation<
  typeof decideInput,
  typeof decideOutput,
  BureauDecisionsOperationHost
>({
  name: 'bureau.decisions.decide',
  mcpExposable: false,
  summary: 'Put a typed question to a model',
  description:
    'Asks a model one question and returns a typed `value`: a `boolean`, the `key` of the chosen option (`choice`, with `options`), the index of the chosen level (`scale`, with `levels`, lowest first), or an object that satisfies `schema` (`structured`, a JSON Schema 2020-12 of at most 16 KiB without `$id` or `pattern`). A model the deployment configured for the kind answers it; every other kind is answered by a language model from the deployment’s model catalog. The answer carries the `provider` and `model` that gave it, and `probability`, `rationale` and `usage` when it reports them. `commandId` is the caller’s own identifier; the call is not idempotent, so a retry asks the model again, and no decision value is stored. `context` is text bounded by the handler’s request body limit. A malformed request or schema is `InvalidParams`; a deployment that has no model able to answer is `UnsupportedCapability` with capability `generate`; an answer that still fails validation after one retry is `Unprocessable` with reason `decision-schema`. The call records a `decision.made` audit entry (kind, provider, model, and the schema’s SHA-256) and never the context or the value. Requires `bureau.decisions:write`.',
  destructive: false,
  tags: ['Decisions'],
  inputSchema: decideInput,
  outputSchema: decideOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability', 'Unprocessable', 'Forbidden'],
  access: write,
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const request = requestOf(input);
    const owner = ownerOfPrincipal(principal);
    try {
      const decision = await host.decisions.decide(
        request,
        owner === undefined ? {} : { principal: owner },
      );
      return {
        value: decision.value,
        ...(decision.probability === undefined ? {} : { probability: decision.probability }),
        ...(decision.rationale === undefined ? {} : { rationale: decision.rationale }),
        provider: decision.provider,
        model: decision.model,
        ...(decision.usage === undefined ? {} : { usage: { ...decision.usage } }),
      };
    } catch (error) {
      if (error instanceof DecisionSchemaError) {
        throw {
          code: 'Unprocessable',
          message: 'The model did not give an answer that satisfies the request',
          data: { reason: 'decision-schema' },
        } satisfies OperationFault;
      }
      if (error instanceof BureauError) {
        if (error.code === 'BAD_REQUEST') throw invalidParams('request', error.message);
        if (error.code === 'NOT_CONFIGURED') {
          throw {
            code: 'UnsupportedCapability',
            message: error.message,
            data: { capability: 'generate' },
          } satisfies OperationFault;
        }
      }
      throw error;
    }
  },
});

/** The operations of the `bureau.decisions` namespace. */
export const bureauDecisionsOperations = [decisionsDecideOperation] as const;
