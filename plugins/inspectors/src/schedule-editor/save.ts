/**
 * The calls of one save, made in order (COR-2545): what `scheduleSavePlan` plans, run against the
 * host. It is plain code over an injected `call`, so every way a save can stop half-way has a test:
 * the first call refused, the second refused after the first was written, a schedule that changed
 * in between, an answer the page cannot read, and a host that did not answer at all.
 *
 * Each call after the first is fenced by the revision the call before it answered, so a write
 * another person made in between is refused instead of overwritten, and it names the schedule the
 * first call made when the save is a create.
 */
import type { ScheduleSaveCall } from '@lostgradient/interborough-plugin/schedule-form';

import { faultOfResult, isReceipt, isScheduleView, type CallFault } from './model.ts';

/** What one tool call answers, as the bridge hands it to the page. */
type ToolAnswer = {
  readonly isError?: boolean | undefined;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
};

/** Makes one tool call. A rejection means the host did not answer. */
export type ToolCall = (tool: string, args: Record<string, unknown>) => Promise<ToolAnswer>;

/** How a save ended; `done` names the calls that were written before it stopped. */
export type SaveOutcome =
  | { readonly kind: 'saved'; readonly id: string; readonly done: readonly string[] }
  | {
      readonly kind: 'refused';
      readonly id: string | undefined;
      readonly done: readonly string[];
      readonly fault: CallFault;
    }
  | {
      /** The Bureau answered something the page does not read, so what it did is not known. */
      readonly kind: 'unreadable';
      readonly id: string | undefined;
      readonly done: readonly string[];
      readonly tool: string;
    }
  | {
      /** The host did not answer, so the call may or may not have been written. */
      readonly kind: 'unanswered';
      readonly id: string | undefined;
      readonly done: readonly string[];
      readonly tool: string;
    };

/** Makes `plan` against `source`, the schedule it changes, or against nothing for a new schedule. */
export async function runSavePlan(
  plan: readonly ScheduleSaveCall[],
  source: { readonly id: string; readonly revision: number } | undefined,
  call: ToolCall,
): Promise<SaveOutcome> {
  let id = source?.id;
  let revision = source?.revision;
  const done: string[] = [];
  for (const step of plan) {
    const creates = step.tool === 'bureau.schedules.create';
    const args = creates
      ? step.arguments
      : {
          ...step.arguments,
          scheduleId: id,
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        };
    let answer: ToolAnswer;
    try {
      answer = await call(step.tool, args);
    } catch {
      return { kind: 'unanswered', id, done, tool: step.tool };
    }
    if (answer.isError === true) {
      return { kind: 'refused', id, done, fault: faultOfResult(answer) };
    }
    const value = answer.structuredContent;
    if (creates && isScheduleView(value)) {
      id = value.id;
      revision = value.revision;
    } else if (!creates && isReceipt(value)) {
      revision = value.revision;
    } else {
      return { kind: 'unreadable', id, done, tool: step.tool };
    }
    done.push(step.tool);
  }
  return id === undefined
    ? { kind: 'unreadable', id, done, tool: 'none' }
    : { kind: 'saved', id, done };
}
