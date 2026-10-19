/**
 * Projects one native run's events onto AG-UI events.
 *
 * The projector is a small state machine for ONE stream. It reads two kinds of
 * input, the run's recorded events (`step.started`, `generate.completed`,
 * `tools.executing`, `tools.executed`, `step.completed`, and the terminal ones)
 * and the live text-delta frames, and returns the AG-UI events each one yields.
 * Nothing in it is shared between streams, so one stream's position never moves
 * another's, and nothing in it holds a handle on the native run.
 *
 * Why the recorded events and not the replay-live feed `operative.runs.events`
 * serves: that feed is projected for observers and leaves out tool arguments,
 * tool results, and text, all of which a chat client has to show. The recorded
 * events carry them, are ordered by the store's own sequence, and are the same
 * records on a replay as live.
 *
 * The one `CUSTOM` event it emits is `bureau.asset-part`, once for each managed asset a step's
 * response carries, in ascending part index, inside the step's text message (after its start,
 * before its end). A step with assets and no text gets a message of its own to hold them.
 *
 * What it does not emit: `STATE_DELTA`, `ACTIVITY_*`, `REASONING_*`, any other `CUSTOM`,
 * `RAW`, `SUBAGENT_*`, and the `*_CHUNK` forms. Reasoning in particular never
 * reaches the wire.
 *
 * @module ag-ui-projection
 */

import { type Event, EventType, type TokenUsage } from '@ag-ui/core';
import { materializeToolResult, toAGUIToolMessage } from 'conversationalist';
import { assistantMessageIdentifier, toolResultMessageIdentifier } from '@lostgradient/operative';

import { assetPartsOf } from './ag-ui-asset-parts.ts';
import {
  ASSET_PART_EVENT_NAME,
  type AssetPartAnnouncement,
  type AssetPartReference,
  type EventStamp,
  stamp,
} from './ag-ui-vocabulary.ts';

/** The terminal fact of a native run, before it is turned into the event that ends the AG-UI run. */
export type NativeTerminal = {
  readonly outcome: 'completed' | 'error' | 'aborted';
  readonly detail: unknown;
  readonly tripwire: boolean;
};

/** What feeding the projector one input yields: events to send, in order, then possibly an ending. */
export type Projection = {
  readonly events: Event[];
  /** The run ended; `terminal` carries what ended it. */
  readonly terminal?: NativeTerminal | undefined;
  /** The run reached a human wait; the driver decides whether it is still pending. */
  readonly parked?: true | undefined;
};

/** The recorded event names the projector reads. */
export const RECORDED = {
  runCompleted: 'run.completed',
  runError: 'run.error',
  runAborted: 'run.aborted',
  runTripwire: 'run.tripwire',
  stepStarted: 'step.started',
  stepCompleted: 'step.completed',
  generateCompleted: 'generate.completed',
  toolsExecuting: 'tools.executing',
  toolsExecuted: 'tools.executed',
  humanWaitParked: 'multiagent.human-wait.parked',
} as const;

type ToolCallDetail = { id: string; name: string; arguments?: unknown };
type ToolResultDetail = Record<string, unknown> & { callId?: string; toolCallId?: string };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stepOf(detail: Record<string, unknown>): number | undefined {
  const step = detail['step'];
  return typeof step === 'number' && Number.isInteger(step) && step >= 0 ? step : undefined;
}

function toolCallsOf(value: unknown): ToolCallDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const call = record(entry);
    return typeof call['id'] === 'string' && typeof call['name'] === 'string'
      ? [{ id: call['id'], name: call['name'], arguments: call['arguments'] }]
      : [];
  });
}

function toolNameOf(result: ToolResultDetail): string {
  const name = result['toolName'];
  return typeof name === 'string' ? name : 'unknown';
}

function resultsOf(value: unknown): ToolResultDetail[] {
  return Array.isArray(value) ? value.map((entry) => record(entry) as ToolResultDetail) : [];
}

/** The text of a tool result as a `TOOL_CALL_RESULT` carries it. */
function resultContent(
  messageId: string,
  result: ToolResultDetail,
): Extract<Event, { type: EventType.TOOL_CALL_RESULT }>['content'] {
  try {
    return toAGUIToolMessage(messageId, materializeToolResult(result as never), {}).content;
  } catch {
    // A streaming result has no content to read yet; the client is told it ran.
    return `Tool "${toolNameOf(result)}" returned a stream.`;
  }
}

export class RunProjector {
  private openStep: number | undefined;
  private text:
    { readonly step: number; started: boolean; ended: boolean; accumulated: string } | undefined;
  private readonly announced = new Set<string>();
  private readonly resulted = new Set<string>();
  private readonly held = new Set<string>();
  private tripwire = false;

  constructor(
    private readonly runId: string,
    private readonly context: EventStamp,
  ) {}

  private live<TEvent extends Event>(event: TEvent): TEvent {
    return stamp(event, this.context, { durable: false });
  }

  /**
   * Rows the client already holds, from a snapshot it was sent: a message with one of
   * these ids is not announced again.
   */
  holds(ids: Iterable<string>): void {
    for (const id of ids) this.held.add(id);
  }

  /** The step in flight, if one has started and not finished. */
  get currentStep(): number | undefined {
    return this.openStep;
  }

  /** One of the run's recorded events. */
  handleRecorded(name: string, detail: unknown): Projection {
    const data = record(detail);
    switch (name) {
      case RECORDED.stepStarted:
        return { events: this.startStep(stepOf(data)) };
      case RECORDED.generateCompleted: {
        const response = record(data['response']);
        return {
          events: this.completeText(
            stepOf(data),
            response['content'],
            assetPartsOf(response['parts']),
          ),
        };
      }
      case RECORDED.toolsExecuting:
        return { events: this.announceCalls(stepOf(data), toolCallsOf(data['toolCalls'])) };
      case RECORDED.toolsExecuted:
        return {
          events: [
            ...this.announceCalls(stepOf(data), toolCallsOf(data['toolCalls'])),
            ...this.emitResults(stepOf(data), resultsOf(data['results'])),
          ],
        };
      case RECORDED.stepCompleted:
        return { events: this.finishStep(stepOf(data), data) };
      case RECORDED.humanWaitParked:
        return { events: [], parked: true };
      case RECORDED.runTripwire:
        this.tripwire = true;
        return { events: [] };
      case RECORDED.runCompleted:
        return { events: this.maximumStepsTail(data), terminal: this.ending('completed', detail) };
      case RECORDED.runError:
        return { events: [], terminal: this.ending('error', detail) };
      case RECORDED.runAborted:
        return { events: [], terminal: this.ending('aborted', detail) };
      default:
        return { events: [] };
    }
  }

  /** A live text delta, with the text accumulated so far (which is all a late attach has). */
  handleTextDelta(content: string, accumulated: string): Projection {
    const text = this.text;
    if (this.openStep === undefined || text === undefined || text.ended) return { events: [] };
    const events: Event[] = [];
    const messageId = this.messageId(text.step);
    let delta = content;
    if (!text.started) {
      text.started = true;
      events.push(this.live({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }));
      delta = accumulated;
    }
    text.accumulated = accumulated;
    if (delta.length > 0) {
      events.push(this.live({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta }));
    }
    return { events };
  }

  /**
   * Closes what an ended or interrupted AG-UI run leaves open: a text message
   * still streaming, and the step in flight. The native step stays open when the
   * run is merely parked; this is the AG-UI run's close, not the run's.
   */
  closeOpen(): Event[] {
    const events: Event[] = [];
    if (this.text !== undefined && this.text.started && !this.text.ended) {
      this.text.ended = true;
      events.push(
        this.live({
          type: EventType.TEXT_MESSAGE_END,
          messageId: this.messageId(this.text.step),
        }),
      );
    }
    if (this.openStep !== undefined) {
      events.push(this.live({ type: EventType.STEP_FINISHED, stepName: stepName(this.openStep) }));
      this.openStep = undefined;
    }
    return events;
  }

  /**
   * The answer an `onMaximumSteps` handler leaves. The run appends it to the
   * conversation after its last step, under the id the next step would have had, and
   * dispatches neither a generate nor a step event for it: the run's completion is the
   * only event that carries it. A run that ended on its step limit without a handler
   * ends with its last step's text, which a step event already carried.
   */
  private maximumStepsTail(data: Record<string, unknown>): Event[] {
    const content = data['content'];
    if (data['finishReason'] !== 'maximum-steps' || typeof content !== 'string') return [];
    if (content.length === 0) return [];
    const steps = Array.isArray(data['steps']) ? data['steps'].map(record) : [];
    // With no steps to read (a checkpoint read that failed leaves none), nothing says
    // which id the row holds: announcing it under step 0 would duplicate the last step's.
    if (steps.length === 0) return [];
    if (steps.at(-1)?.['content'] === content) return [];
    const indexes = steps.flatMap((step) => {
      const index = step['step'];
      return typeof index === 'number' && Number.isInteger(index) ? [index] : [];
    });
    const next = indexes.length === 0 ? steps.length : Math.max(...indexes) + 1;
    const messageId = this.messageId(next);
    if (this.held.has(messageId)) return [];
    this.held.add(messageId);
    return [
      this.live({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }),
      this.live({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: content }),
      this.live({ type: EventType.TEXT_MESSAGE_END, messageId }),
    ];
  }

  private ending(outcome: NativeTerminal['outcome'], detail: unknown): NativeTerminal {
    return { outcome, detail, tripwire: this.tripwire };
  }

  private messageId(step: number): string {
    return assistantMessageIdentifier(this.runId, step)!;
  }

  private startStep(step: number | undefined): Event[] {
    if (step === undefined) return [];
    const events = this.openStep !== undefined && this.openStep !== step ? this.closeOpen() : [];
    this.openStep = step;
    this.text = { step, started: false, ended: false, accumulated: '' };
    events.push(this.live({ type: EventType.STEP_STARTED, stepName: stepName(step) }));
    return events;
  }

  /**
   * Ends the step's text message, with the whole of it when no delta announced any. The step's
   * assets are announced inside it, so a step with assets and no text still gets a message.
   */
  private completeText(
    step: number | undefined,
    final: unknown,
    assets: readonly AssetPartReference[] = [],
  ): Event[] {
    const text = this.text;
    if (step === undefined || text === undefined || text.step !== step || text.ended) return [];
    const content = typeof final === 'string' ? final : '';
    const messageId = this.messageId(step);
    const events: Event[] = [];
    if (!text.started) {
      text.ended = true;
      if (content.length === 0 && assets.length === 0) return [];
      text.started = true;
      events.push(this.live({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' }));
      if (content.length > 0) {
        events.push(this.live({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: content }));
      }
      events.push(...this.announceAssets(messageId, assets));
      events.push(this.live({ type: EventType.TEXT_MESSAGE_END, messageId }));
      return events;
    }
    // The deltas streamed so far may stop short of the text the guardrails left.
    if (content.length > text.accumulated.length && content.startsWith(text.accumulated)) {
      events.push(
        this.live({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: content.slice(text.accumulated.length),
        }),
      );
    }
    text.ended = true;
    events.push(...this.announceAssets(messageId, assets));
    events.push(this.live({ type: EventType.TEXT_MESSAGE_END, messageId }));
    return events;
  }

  /** One `bureau.asset-part` event for each asset, in the order given (ascending part index). */
  private announceAssets(messageId: string, assets: readonly AssetPartReference[]): Event[] {
    return assets.map((asset) => {
      const value: AssetPartAnnouncement = { messageId, ...asset };
      return this.live({ type: EventType.CUSTOM, name: ASSET_PART_EVENT_NAME, value });
    });
  }

  private announceCalls(step: number | undefined, calls: ToolCallDetail[]): Event[] {
    if (step === undefined) return [];
    const parentMessageId = this.messageId(step);
    const events: Event[] = [];
    for (const call of calls) {
      if (this.announced.has(call.id)) continue;
      this.announced.add(call.id);
      const args =
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
      events.push(
        this.live({
          type: EventType.TOOL_CALL_START,
          toolCallId: call.id,
          toolCallName: call.name,
          parentMessageId,
        }),
        this.live({ type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: args }),
        this.live({ type: EventType.TOOL_CALL_END, toolCallId: call.id }),
      );
    }
    return events;
  }

  private emitResults(step: number | undefined, results: ToolResultDetail[]): Event[] {
    if (step === undefined) return [];
    const events: Event[] = [];
    for (const result of results) {
      const callId = result.toolCallId ?? result.callId;
      if (typeof callId !== 'string' || this.resulted.has(callId)) continue;
      this.resulted.add(callId);
      const messageId = toolResultMessageIdentifier(this.runId, step, callId)!;
      events.push(
        this.live({
          type: EventType.TOOL_CALL_RESULT,
          messageId,
          toolCallId: callId,
          content: resultContent(messageId, result),
          role: 'tool',
        }),
      );
    }
    return events;
  }

  /** A step's last word: any call or result an earlier event did not carry, then its close. */
  private finishStep(step: number | undefined, data: Record<string, unknown>): Event[] {
    if (step === undefined) return [];
    const results = resultsOf(data['results']);
    const announcedByResult: ToolCallDetail[] = results.flatMap((result) => {
      const callId = result.toolCallId ?? result.callId;
      return typeof callId === 'string' ? [{ id: callId, name: toolNameOf(result) }] : [];
    });
    return [
      ...this.completeText(step, data['content']),
      ...this.announceCalls(step, [...toolCallsOf(data['toolCalls']), ...announcedByResult]),
      ...this.emitResults(step, results),
      ...this.closeOpen(),
    ];
  }
}

export function stepName(step: number): string {
  return `step-${step}`;
}

export function usageOf(detail: unknown): TokenUsage[] {
  const usage = (detail as { usage?: Record<string, unknown> } | undefined)?.usage ?? {};
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const prompt = count(usage['prompt']);
  const completion = count(usage['completion']);
  const total = count(usage['total']);
  const entry: TokenUsage = {
    ...(prompt === undefined ? {} : { inputTokens: prompt }),
    ...(completion === undefined ? {} : { outputTokens: completion }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
  return [entry];
}

/**
 * The code and message a failed run's terminal record carries. The record holds
 * the error serialized to a string (name, message, kind, code, and a cause that
 * can hold a provider's response); only the code and message are read, so
 * nothing else reaches the wire.
 */
export function errorOf(detail: unknown): { code: string; message: string } {
  let error = (detail as { error?: unknown } | undefined)?.error;
  if (typeof error === 'string') {
    try {
      error = JSON.parse(error) as unknown;
    } catch {
      // Not JSON: the string is the message.
    }
  }
  const fields =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const message =
    typeof fields['message'] === 'string'
      ? fields['message']
      : typeof error === 'string'
        ? error
        : 'The run failed';
  return {
    code:
      typeof fields['code'] === 'string' && fields['code'].length > 0
        ? fields['code']
        : 'RUN_FAILED',
    message,
  };
}
