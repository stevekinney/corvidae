import { z } from 'zod';

import { DurableCapabilityUnavailableError } from './durable/durable-capability-unavailable-error';
import type { PendingHumanWait, PendingWakeup } from './durable/types';
import { HumanWaitParkedEvent } from './events';
import {
  checkHumanInputSchema,
  checkHumanInputSchemas,
  HumanInputSchemaError,
  type HumanInputSchema,
  type HumanInputSchemaIssue,
} from './human-input-schema';
import { HUMAN_INPUT_DESCRIPTION_MAXIMUM_LENGTH } from './human-input-schema-extensions';
import { refuseIfStepIsParked, type RefusedParkRequest } from './park-refusal';

/** The most issues one `invalid-answer-schema` result lists; a schema near the size limit could hold thousands. */
const MAXIMUM_REPORTED_SCHEMA_ISSUES = 20;

type HumanInputEventDispatcher = {
  dispatchEvent(event: Event): boolean;
};

/**
 * Input shape for the `requestHumanInput` tool.
 *
 * @example
 * ```ts
 * // Agent: "I need human approval before proceeding"
 * requestHumanInput({ signalName: 'human-response', prompt: 'Please approve this action' });
 * ```
 */
export interface RequestHumanInputInput {
  /**
   * The signal name the run will park on. The human sends the same name when
   * releasing the run (e.g. `'human-response'`).
   */
  signalName: string;
  /**
   * Optional prompt to surface to the human reviewer. This is returned in the
   * tool result and in the `HumanWaitParkedEvent` so callers can display it.
   */
  prompt?: string | undefined;
  /**
   * Optional JSON Schema (draft 2020-12) for the answer this question expects. The agent chooses
   * the shape of each question as it asks, and the schema it gives replaces the one configured
   * for the signal at tool creation (`inputSchemas`), which applies only when a call gives none.
   * It is held to the same limits as a configured schema (see {@link checkHumanInputSchema}); one
   * that breaks them returns an {@link InvalidAnswerSchemaResult} and nothing parks.
   */
  answerSchema?: Readonly<Record<string, unknown>> | undefined;
}

/** Output returned to the LLM when `requestHumanInput` is called. */
export interface RequestHumanInputResult {
  parked: true;
  signalName: string;
  prompt?: string | undefined;
  /**
   * The JSON Schema of the answer, when there is one: the call's `answerSchema`, else the one the
   * author configured for this signal. It rides in the tool
   * result so the step record the checkpoint commits carries it, and a restarted run reads the
   * wait's schema back from there. The model never reads it: the conversation row appended for
   * the model leaves it out (see `modelFacingToolResult`).
   */
  inputSchema?: HumanInputSchema | undefined;
  /** Human-readable message the LLM can use in its response. */
  message: string;
}

/**
 * What `requestHumanInput` returns for a request made after the step already holds a park (COR-1578):
 * `parked: false`, the signal that was asked for, and the park the step holds. The request took no
 * slot, dispatched no event, and listed no review.
 */
export interface RefusedHumanInputResult extends RefusedParkRequest {
  parked: false;
  /** The signal name the refused request asked for. */
  signalName: string;
}

/**
 * What `requestHumanInput` returns when the call's `answerSchema` is not acceptable: it breaks a
 * limit (32 KiB, 8 levels, no `$id`, no `pattern`) or misuses an `x-` keyword. `parked: false`, no
 * event, no review, no slot taken; the model reads `issues` and may ask again with a corrected
 * schema. It is persisted in `StepRecord.results`, so its fields are a durable shape.
 */
export interface InvalidAnswerSchemaResult {
  /** Always `false`: the call parked nothing. */
  parked: false;
  /** Always `'invalid-answer-schema'`: how a model or client tells this refusal from the others. */
  error: 'invalid-answer-schema';
  /** The signal name the rejected call asked for. */
  signalName: string;
  /** Every reason the schema was refused, each with its location inside the schema. */
  issues: ReadonlyArray<HumanInputSchemaIssue>;
  /** Human-readable message the LLM can use in its response. */
  message: string;
}

/**
 * Every outcome of a `requestHumanInput` call: the run parked, the step's first park stands, or
 * the call's `answerSchema` was refused.
 */
export type RequestHumanInputOutcome =
  RequestHumanInputResult | RefusedHumanInputResult | InvalidAnswerSchemaResult;

/**
 * The interface the `requestHumanInput` tool needs from its context.
 *
 * Designed for testability: tests pass a plain object instead of a full
 * `DurableRunDeps`.
 */
export interface RequestHumanInputContext {
  /** Mutable slot — the tool writes the human-wait request here. */
  pendingHumanWait: PendingHumanWait | undefined;
  /**
   * The `scheduleWakeup` tool's slot, read-only here: a wakeup already requested in this step
   * refuses a human-input request, because a step parks on at most one request (COR-1578).
   */
  readonly pendingWakeup: PendingWakeup | undefined;
  /**
   * Optional run id, used in the emitted event so observers can correlate the
   * park event to a specific run. Falls back to `''` when omitted.
   */
  runId?: string | undefined;
  /**
   * Whether this run has a compatible durable execution context attached
   * (a bureau with a durable engine, regardless of whether its checkpoint
   * store is persistent or `MemoryStorage` — either way `ctx.waitForSignal`
   * can park the workflow for the lifetime of the process). `execute` throws
   * {@link DurableCapabilityUnavailableError} instead of writing the pending
   * slot (and never dispatches `HumanWaitParkedEvent`) when this is `false`,
   * per AB-41's decision record: an unavailable capability rejects with a
   * stable typed error rather than returning a success-shaped no-op.
   * Required (not optional/defaulted) so every construction site states its
   * durability explicitly.
   */
  durable: boolean;
}

/**
 * Options for {@link createRequestHumanInputTool}.
 */
export interface CreateRequestHumanInputToolOptions {
  /**
   * The mutable context the tool writes the human-wait request into. In
   * production this is the `DurableRunDeps` object (the tool and the workflow
   * share the same in-process reference). In tests, pass a plain
   * `{ pendingHumanWait: undefined, pendingWakeup: undefined, durable: true }` stub.
   */
  context: RequestHumanInputContext;
  /**
   * Optional event emitter. When provided, a `HumanWaitParkedEvent` is
   * dispatched each time the tool executes (C3 completeness rule — every state
   * transition emits an event).
   */
  emitter?: HumanInputEventDispatcher | undefined;
  /**
   * A JSON Schema (draft 2020-12) per signal name, describing the answer that signal expects. The
   * author configures these. A call that gives its own `answerSchema` replaces the signal's schema
   * for that call; this one applies only when a call gives none. A park on a configured signal
   * records its schema on the pending wait, the
   * `HumanWaitParkedEvent`, and the tool result the checkpoint persists. Each schema is checked
   * when the tool is created: it must be a valid 2020-12 schema of at most 32 KiB serialized and 8
   * levels of nesting, or creation throws {@link HumanInputSchemaError}. The tool keeps its own
   * copy, so changing the object afterwards changes nothing. A signal with no entry behaves as it
   * always has.
   */
  inputSchemas?: Readonly<Record<string, HumanInputSchema>> | undefined;
}

/**
 * Creates the `requestHumanInput` HITL tool (F3 — Human-in-the-loop).
 *
 * The agent calls this tool during a durable run to park the current workflow
 * until a human sends a named signal. Under the hood it sets a
 * `pendingHumanWait` flag on the run's `DurableRunDeps`; the `agentRun`
 * workflow checks this flag after the main step loop exits and performs
 * `yield* ctx.waitForSignal(signalName)` to actually park the Weft workflow.
 *
 * This is an **opt-in built-in tool** — the bureau or agent explicitly adds it
 * to the toolbox (no ambient grant). It only works in a durable run; calling it
 * when `context.durable` is `false` throws
 * {@link DurableCapabilityUnavailableError} instead of writing the pending
 * slot or dispatching a park event (AB-41 / AB-43). A bureau that already
 * knows durability is unavailable at composition time should prefer omitting
 * this tool from the effective toolbox entirely rather than relying on the
 * thrown error.
 *
 * A step parks on at most one request: the first human-input or wakeup request to reach `execute`
 * in a step is honored, and any later one returns a {@link RefusedHumanInputResult} instead of a
 * parked result. A refusal is a normal tool result, so the step completes and the model reads it in
 * its next request; it dispatches no event and takes no slot. The durable-capability check still
 * runs first.
 *
 * C3 completeness: when an `emitter` is provided, a `HumanWaitParkedEvent` is
 * dispatched BEFORE the tool result is returned so observers see the park event
 * synchronously with the tool call. No event is dispatched when the run is
 * rejected as unavailable — a rejection is not a park.
 *
 * @example
 * ```ts
 * // In bureau setup (Phase E): forward reads/writes onto the REAL
 * // `DurableRunDeps` object rather than spreading it — a spread detaches
 * // the tool's context from the object the durable workflow actually reads,
 * // so `pendingHumanWait` would be written to a copy the workflow never
 * // sees. `createHumanWaitContext` (packages/bureau/src/create-bureau.ts)
 * // is exactly this forwarding pattern, with `durable: true` because it is
 * // only ever constructed inside the `runtime.durable` guard.
 * const tools = {
 *   requestHumanInput: createRequestHumanInputTool({
 *     context: createHumanWaitContext(servicesRef, runId),
 *     emitter,
 *   }),
 * };
 * ```
 *
 * @example
 * ```ts
 * // Standalone (test):
 * const ctx = { pendingHumanWait: undefined, pendingWakeup: undefined, durable: true };
 * const tool = createRequestHumanInputTool({ context: ctx });
 * await tool.execute({ signalName: 'human-response', prompt: 'Approve this?' });
 * expect(ctx.pendingHumanWait?.signalName).toBe('human-response');
 * ```
 */
export function createRequestHumanInputTool(options: CreateRequestHumanInputToolOptions) {
  const { context, emitter } = options;
  const schemas = checkHumanInputSchemas(options.inputSchemas ?? {});

  return {
    name: 'requestHumanInput',
    description:
      'Request human input: park this run until a human sends the named signal. ' +
      'Use when the agent needs explicit human approval or a human decision before continuing. ' +
      'Only the first human-input or wakeup request in a step is honored. ' +
      'Give answerSchema (a JSON Schema) to choose the shape of the answer; the person is shown the matching control. ' +
      'Kinds: pick one {type:"string",enum:[...],"x-labels":{value:label},"x-descriptions":{value:sentence}}, ' +
      `where the optional x-descriptions puts a sentence of at most ${HUMAN_INPUT_DESCRIPTION_MAXIMUM_LENGTH} characters under that choice's label to say what choosing it means, keyed by enum value, and works the same on pick several and on pick one or something else; ` +
      'pick one or something else {anyOf:[{enum:[...]},{type:"string",maxLength:500}],"x-allowOther":true}; ' +
      'pick several {type:"array",uniqueItems:true,items:{enum:[...]},minItems,maxItems}; ' +
      'free text {type:"string",maxLength}; yes or no {type:"boolean"}; ' +
      'number {type:"number",minimum,maximum}; ' +
      'date or time {type:"string",format:"date"|"time"|"date-time"} in RFC 3339 form; ' +
      'rating {type:"integer",minimum:1,maximum:N,"x-kind":"rating","x-labels":{"1":label}}; ' +
      'a few fields {type:"object",properties,required,additionalProperties:false}; ' +
      'secret {type:"string",writeOnly:true,"x-secret":true}, for a password or token the person must not see echoed back; ' +
      'file {type:"string",contentMediaType,"x-asset":true}, answered with an asset id. ' +
      'No pattern or $id, at most 32 KiB and 8 levels deep. Without answerSchema the person answers in free text. ' +
      'A refused schema returns {parked:false,error:"invalid-answer-schema",issues} and nothing parks: fix the issues and ask again.',

    /**
     * Zod schema for the tool's input arguments. Armorer's `createToolbox`
     * calls `normalizeSchema` on this field; without it the schema defaults to
     * `z.object({})` which strips `signalName` and `prompt` before `execute`
     * receives them, causing `pendingHumanWait.signalName` to be `undefined`
     * and the durable run to park on an unreachable signal.
     */
    input: z.object({
      signalName: z
        .string()
        // The longest name Bureau carries in a surface continuation and admits to a signal.
        .max(256)
        .describe(
          'The signal name the run will park on. The human sends the same name when ' +
            'releasing the run (e.g. "human-response").',
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          'Optional prompt to surface to the human reviewer. Returned in the tool ' +
            'result and in the HumanWaitParkedEvent so callers can display it.',
        ),
      answerSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Optional JSON Schema (draft 2020-12) for the answer: it picks the control the person ' +
            'sees (choices, a number, a date, a rating, a few fields, a secret, a file) and the ' +
            'answer is checked against it. Replaces any schema configured for the signal. See the ' +
            'tool description for the shape of each kind.',
        ),
    }),

    execute(input: RequestHumanInputInput): RequestHumanInputOutcome {
      if (!context.durable) {
        throw new DurableCapabilityUnavailableError('requestHumanInput');
      }

      // COR-1578 — first request wins: a step that already holds a park refuses this one.
      const refusal = refuseIfStepIsParked({
        pendingHumanWait: context.pendingHumanWait,
        pendingWakeup: context.pendingWakeup,
      });
      if (refusal !== undefined) {
        return { parked: false, signalName: input.signalName, ...refusal };
      }

      // The call's schema replaces the signal's configured one; the configured one applies only
      // when the call gives none. A schema the call gives is checked here, per call, with the
      // limits a configured one meets at creation, and a refusal parks nothing.
      let inputSchema: HumanInputSchema | undefined;
      if (input.answerSchema === undefined) {
        inputSchema = schemas.get(input.signalName);
      } else {
        try {
          inputSchema = checkHumanInputSchema(input.signalName, input.answerSchema);
        } catch (error) {
          if (!(error instanceof HumanInputSchemaError)) throw error;
          return {
            parked: false,
            error: 'invalid-answer-schema',
            signalName: input.signalName,
            issues: error.issues.slice(0, MAXIMUM_REPORTED_SCHEMA_ISSUES),
            message: `The answerSchema was not accepted, so nothing is parked: ${error.issues
              .slice(0, MAXIMUM_REPORTED_SCHEMA_ISSUES)
              .map((issue) =>
                issue.path.length === 0
                  ? issue.message
                  : `${issue.path.join('.')}: ${issue.message}`,
              )
              .join(' ')} Ask again with a corrected answerSchema.`,
          };
        }
      }
      context.pendingHumanWait = {
        signalName: input.signalName,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
      };

      // F3 / C3 — emit HumanWaitParkedEvent so observers see the transition.
      // Thread the prompt through so UI/event-stream consumers can display what
      // approval or input is being requested (as the schema doc promises).
      if (emitter) {
        emitter.dispatchEvent(
          new HumanWaitParkedEvent(
            input.signalName,
            context.runId ?? '',
            input.prompt,
            inputSchema,
          ),
        );
      }

      const message = input.prompt
        ? `Parked waiting for human signal "${input.signalName}". Prompt: ${input.prompt}`
        : `Parked waiting for human signal "${input.signalName}".`;

      return {
        parked: true,
        signalName: input.signalName,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        message,
      };
    },
  } as const;
}

/** The type of the tool object created by {@link createRequestHumanInputTool}. */
export type RequestHumanInputTool = ReturnType<typeof createRequestHumanInputTool>;
