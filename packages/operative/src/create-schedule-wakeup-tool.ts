import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { parseDuration } from '@lostgradient/weft';
import { z } from 'zod';

import { renderDurationLabel } from './durable/continuation-input';
import { DurableCapabilityUnavailableError } from './durable/durable-capability-unavailable-error';
import type { PendingHumanWait, PendingWakeup } from './durable/types';
import { WakeupScheduledEvent } from './events';
import { refuseIfStepIsParked, type RefusedParkRequest } from './park-refusal';

/** Where `scheduleWakeup` announces a wakeup it accepted: a `CompletableEventTarget`, or anything shaped like one. */
type WakeupEventDispatcher = {
  dispatchEvent(event: Event): boolean;
};

/**
 * Input shape for the `scheduleWakeup` tool. The agent calls this tool to
 * park the current durable run for `in` (a human-readable duration or
 * milliseconds) and resume later.
 *
 * @example
 * ```ts
 * // Agent: "I'll check the deploy status in 6 hours"
 * scheduleWakeup({ in: '6h', note: 'Check deploy status' });
 * ```
 */
export interface ScheduleWakeupInput {
  /**
   * How long to sleep before resuming. Accepts a Weft `Duration`:
   * - milliseconds as a number (e.g. `21_600_000`)
   * - human-readable string (e.g. `'6h'`, `'30m'`, `'500ms'`)
   * - ISO-8601 duration (e.g. `'PT6H'`)
   */
  in: number | string;
  /**
   * Optional note the agent attaches to the wakeup. Rendered into the SAME
   * run's continuation message once the wakeup fires (AB-45 — a fired
   * wakeup continues the same run with one more generation step, never a
   * new run), and carried on the final `AgentRunWorkflowResult.wakeupNote`.
   *
   * @example 'Wake me up to check if the deploy succeeded.'
   */
  note?: string | undefined;
}

/** Output returned to the LLM when `scheduleWakeup` is called. */
export interface ScheduleWakeupResult {
  scheduled: true;
  duration: number | string;
  note?: string | undefined;
  /** Human-readable message the LLM can use in its response. */
  message: string;
}

/**
 * What `scheduleWakeup` returns for a request made after the step already holds a park (COR-1578):
 * `scheduled: false` and the park the step holds. The request took no slot.
 */
export interface RefusedWakeupResult extends RefusedParkRequest {
  scheduled: false;
}

/** Either outcome of a `scheduleWakeup` call: the wakeup was scheduled, or the step's first park stands. */
export type ScheduleWakeupOutcome = ScheduleWakeupResult | RefusedWakeupResult;

/**
 * The interface the `scheduleWakeup` tool needs from its context. The
 * `pendingWakeup` mutable slot lives on `DurableRunDeps.pendingWakeup` and is
 * injected here via the tool factory.
 *
 * Designed for testability: tests pass a plain object with a `pendingWakeup`
 * property instead of a full `DurableRunDeps`.
 */
export interface ScheduleWakeupContext {
  /** Mutable slot — the tool writes the wakeup request here. */
  pendingWakeup: PendingWakeup | undefined;
  /**
   * The `requestHumanInput` tool's slot, read-only here: a human-input request already made in this
   * step refuses a wakeup, because a step parks on at most one request (COR-1578).
   */
  readonly pendingHumanWait: PendingHumanWait | undefined;
  /**
   * Whether this run has a compatible durable execution context attached
   * (a bureau with a durable engine, regardless of whether its checkpoint
   * store is persistent or `MemoryStorage` — either way `ctx.sleep` can park
   * the workflow for the lifetime of the process). `execute` throws
   * {@link DurableCapabilityUnavailableError} instead of writing the pending
   * slot when this is `false`, per AB-41's decision record: an unavailable
   * capability rejects with a stable typed error rather than returning a
   * success-shaped no-op. Required (not optional/defaulted) so every
   * construction site states its durability explicitly.
   */
  durable: boolean;
}

/**
 * Options for {@link createScheduleWakeupTool}.
 */
export interface CreateScheduleWakeupToolOptions {
  /**
   * The mutable context the tool writes the wakeup request into. In production
   * this is the `DurableRunDeps` object (the tool and the workflow share the
   * same in-process reference). In tests, pass a plain `{ pendingWakeup:
   * undefined, pendingHumanWait: undefined, durable: true }` stub.
   */
  context: ScheduleWakeupContext;
  /**
   * Optional event emitter. When provided, a `WakeupScheduledEvent` is dispatched each time the
   * tool accepts a request (C3 completeness rule: every state transition emits an event). A
   * refused request, and one whose duration cannot be turned into a wake time, dispatch none.
   */
  emitter?: WakeupEventDispatcher | undefined;
  /**
   * The run's clock, in milliseconds since the Unix epoch, which dates the event's `wakeAt`.
   * Defaults to the default runtime services' clock.
   */
  now?: (() => number) | undefined;
}

/**
 * When a wakeup asked for in `duration` is due, or `undefined` when the duration is not one the
 * scheduler parses (the park would reject it too, so there is no wake time to announce).
 */
function wakeTimeOf(duration: number | string, now: () => number): number | undefined {
  try {
    return now() + parseDuration(duration);
  } catch {
    return undefined;
  }
}

/**
 * Creates the `scheduleWakeup` self-scheduling tool (D6 — Tier-1 scheduling).
 *
 * The agent calls this tool during a durable run to park the current workflow
 * for a specified duration and resume later. Under the hood it sets a
 * `pendingWakeup` flag on the run's `DurableRunDeps`; the `agentRun` workflow
 * checks this flag after the main step loop exits and performs
 * `yield* ctx.sleep(duration)` to actually park the Weft workflow. Per AB-41's
 * ratified decision record, once the timer fires the workflow CONTINUES the
 * same run with one more agent generation step, seeded by a deterministic
 * `[wakeup] Resumed after sleeping ...` conversation message carrying the
 * requested duration and this tool's `note` (AB-45) — it never merely delays
 * terminal completion.
 *
 * A step parks on at most one request: the first human-input or wakeup request to reach `execute`
 * in a step is honored, and any later one returns a {@link RefusedWakeupResult} instead of a
 * scheduled result. A refusal is a normal tool result, so the step completes and the model reads it
 * in its next request. The durable-capability check still runs first.
 *
 * This is an **opt-in built-in tool** — the bureau or agent explicitly adds it
 * to the toolbox (no ambient grant). It only works in a durable run; calling it
 * when `context.durable` is `false` throws
 * {@link DurableCapabilityUnavailableError} instead of writing the pending
 * slot (AB-41 / AB-43). A bureau that already knows durability is unavailable
 * at composition time should prefer omitting this tool from the effective
 * toolbox entirely rather than relying on the thrown error.
 *
 * @example
 * ```ts
 * // In bureau setup (Phase E): forward reads/writes onto the REAL
 * // `DurableRunDeps` object rather than spreading it — a spread detaches
 * // the tool's context from the object the durable workflow actually reads,
 * // so `pendingWakeup` would be written to a copy the workflow never sees
 * // (mirror Bureau's own `createHumanWaitContext` forwarding pattern).
 * const tools = {
 *   scheduleWakeup: createScheduleWakeupTool({
 *     context: {
 *       get pendingWakeup() {
 *         return durableRunDeps.pendingWakeup;
 *       },
 *       set pendingWakeup(value) {
 *         durableRunDeps.pendingWakeup = value;
 *       },
 *       get pendingHumanWait() {
 *         return durableRunDeps.pendingHumanWait;
 *       },
 *       durable: true,
 *     },
 *   }),
 * };
 * ```
 *
 * @example
 * ```ts
 * // Standalone (test):
 * const ctx = { pendingWakeup: undefined, pendingHumanWait: undefined, durable: true };
 * const tool = createScheduleWakeupTool({ context: ctx });
 * await tool.execute({ in: '6h', note: 'Check deploy' });
 * expect(ctx.pendingWakeup?.duration).toBe('6h');
 * ```
 */
export function createScheduleWakeupTool(options: CreateScheduleWakeupToolOptions) {
  const { context, emitter, now = () => createDefaultRuntimeServices().clock.now() } = options;

  return {
    name: 'scheduleWakeup',
    description:
      'Schedule a wakeup: park this run for the given duration and resume automatically. ' +
      'Use to sleep until a future event (e.g. "wake me in 6h to check the deploy"). ' +
      'Only the first human-input or wakeup request in a step is honored.',

    /**
     * Zod schema for the tool's input arguments. Armorer's `createToolbox`
     * calls `normalizeSchema` on this field; without it the schema defaults to
     * `z.object({})` which strips `in` and `note` before `execute` receives them.
     */
    input: z.object({
      in: z
        .union([z.number(), z.string()])
        .describe(
          'How long to sleep before resuming. Accepts milliseconds as a number ' +
            'or a human-readable string (e.g. "6h", "30m", "500ms") ' +
            'or an ISO-8601 duration (e.g. "PT6H").',
        ),
      note: z
        .string()
        .optional()
        .describe(
          'Optional note the agent attaches to the wakeup, surfaced to the next ' +
            'run so it knows why it resumed.',
        ),
    }),

    /**
     * Execute the `scheduleWakeup` tool. Writes the wakeup request into the
     * shared context so the durable workflow can park after the step loop exits.
     *
     * @param input - The wakeup request: `in` (duration) + optional `note`.
     * @returns A confirmation result surfaced to the LLM, or a refusal when the step already holds a park.
     */
    execute(input: ScheduleWakeupInput): ScheduleWakeupOutcome {
      if (!context.durable) {
        throw new DurableCapabilityUnavailableError('scheduleWakeup');
      }

      // COR-1578 — first request wins: a step that already holds a park refuses this one.
      const refusal = refuseIfStepIsParked({
        pendingHumanWait: context.pendingHumanWait,
        pendingWakeup: context.pendingWakeup,
      });
      if (refusal !== undefined) return { scheduled: false, ...refusal };

      context.pendingWakeup = {
        duration: input.in,
        ...(input.note !== undefined ? { note: input.note } : {}),
      };

      if (emitter) {
        const wakeAt = wakeTimeOf(input.in, now);
        if (wakeAt !== undefined) {
          emitter.dispatchEvent(new WakeupScheduledEvent(input.in, wakeAt, input.note));
        }
      }

      const durationLabel = renderDurationLabel(input.in);

      const message = input.note
        ? `Wakeup scheduled in ${durationLabel}. Note: ${input.note}`
        : `Wakeup scheduled in ${durationLabel}.`;

      return {
        scheduled: true,
        duration: input.in,
        ...(input.note !== undefined ? { note: input.note } : {}),
        message,
      };
    },
  } as const;
}

/** The type of the tool object created by {@link createScheduleWakeupTool}. */
export type ScheduleWakeupTool = ReturnType<typeof createScheduleWakeupTool>;
