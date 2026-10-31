/**
 * Projects one native run's events onto AG-UI events.
 *
 * The projector is a small state machine for one native run. It reads two kinds of
 * input, the run's recorded events (`step.started`, `generate.completed`,
 * `tools.executing`, `tools.executed`, `step.completed`, and the terminal ones)
 * and the live text-delta frames, and returns the AG-UI events each one yields.
 * A mount's live producer shares one instance across attachments; settled and
 * peer replay paths own an instance. Only the producer advances a shared
 * projector, while attachments read its checkpoint without changing it.
 *
 * Why the recorded events and not the replay-live feed `operative.runs.events`
 * serves: that feed is projected for observers and leaves out tool arguments,
 * tool results, and text, all of which a chat client has to show. The recorded
 * events carry them, are ordered by the store's own sequence, and are the same
 * records on a replay as live.
 *
 * Its `CUSTOM` vocabulary is closed and documented in `ag-ui-vocabulary.ts`:
 *
 * - `bureau.asset-part`, once for each managed asset a step's response carries, in ascending part
 *   index, inside the step's text message (after its start, before its end). A step with assets
 *   and no text gets a message of its own to hold them.
 * - `bureau.memory-written`, once for each `memory_store` call whose result says it stored a
 *   record, right after that call's result.
 * - `bureau.wakeup-scheduled`, once for each `schedule.wakeup` record the run left.
 * - `bureau.child-run-started` and `bureau.child-run-settled`, once for each
 *   `multiagent.child-workflow.*` record the run left.
 *
 * Reasoning is the one family that is live and private (COR-1806). A step whose response carries
 * `thinking` parts is announced as `REASONING_START`, `REASONING_MESSAGE_START`,
 * `REASONING_MESSAGE_CONTENT`, `REASONING_MESSAGE_END` and `REASONING_END`, once for each part,
 * before the step's text message. It is read from `generate.completed`, which the run records only
 * after its output guardrails have run, so a guardrail that blocked or redacted a response also
 * replaced the parts the frames would have been read from: no frame ever carries the response as
 * the model first produced it. On a step that called tools, redaction keeps the flagged thinking
 * parts (the provider requires them back unmodified) and names them in the response's
 * `withheldThinking`; no frame is sent for those. `redacted_thinking` parts and every part's
 * `signature` are never sent. The projector emits these events; it is the stream that sends them
 * to the run's owner alone and never in a replay. None of the reasoning events, and none of the
 * `CUSTOM` events above except `bureau.asset-part`, enters the checkpoint a late attach replays:
 * they are announced to the streams that are attached when they happen.
 *
 * What it does not emit: `STATE_DELTA`, `ACTIVITY_*`, `RAW`, `SUBAGENT_*`,
 * `REASONING_ENCRYPTED_VALUE`, and the `*_CHUNK` forms.
 *
 * @module ag-ui-projection
 */

import { type Event, EventType, type TokenUsage } from '@ag-ui/core';
import { materializeToolResult, toAGUIToolMessage } from 'conversationalist';
import {
  assistantMessageIdentifier,
  isFailureFinishReason,
  toolResultMessageIdentifier,
} from '@lostgradient/operative';

import { assetPartsOf } from './ag-ui-asset-parts.ts';
import { ProjectionCheckpoint } from './ag-ui-projection-checkpoint.ts';
import {
  ASSET_PART_EVENT_NAME,
  type AssetPartAnnouncement,
  type AssetPartReference,
  CHILD_RUN_SETTLED_EVENT_NAME,
  CHILD_RUN_STARTED_EVENT_NAME,
  type ChildRunSettledAnnouncement,
  type ChildRunStartedAnnouncement,
  type EventStamp,
  MEMORY_WRITTEN_EVENT_NAME,
  type MemoryWrittenAnnouncement,
  stamp,
  WAKEUP_SCHEDULED_EVENT_NAME,
  type WakeupScheduledAnnouncement,
} from './ag-ui-vocabulary.ts';

/** The terminal fact of a native run, before it is turned into the event that ends the AG-UI run. */
export type NativeTerminal = {
  readonly outcome: 'completed' | 'error' | 'aborted';
  readonly detail: unknown;
  readonly tripwire: boolean;
  /**
   * The recorded event that ended the run, when it is not the one `outcome` names: a run that
   * stopped at its step limit ends in `error` on its `run.completed` record, so the cursor the
   * terminal event carries is that record's. Absent, `outcome` names it.
   */
  readonly recordedAs?: 'run.completed' | 'run.error' | 'run.aborted' | undefined;
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
  wakeupScheduled: 'schedule.wakeup',
  childStarted: 'multiagent.child-workflow.started',
  childCompleted: 'multiagent.child-workflow.completed',
  childFailed: 'multiagent.child-workflow.failed',
  childAborted: 'multiagent.child-workflow.aborted',
} as const;

/** The tool whose result says a record was written to memory. */
export const MEMORY_STORE_TOOL_NAME = 'memory_store';

/** The `code` of the error a run that stopped at its step limit announces with `run.error`. */
export const MAXIMUM_STEPS_CODE = 'MAXIMUM_STEPS';

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

/**
 * The text of every `thinking` part of a response, in order, except the parts its output guardrail
 * withheld (their indices in `parts`, as `withheldThinking`). Redacted thinking has none to send.
 */
function thinkingOf(response: Record<string, unknown>): string[] {
  const { parts, withheldThinking } = response;
  if (!Array.isArray(parts)) return [];
  const withheld = new Set(Array.isArray(withheldThinking) ? (withheldThinking as unknown[]) : []);
  return (parts as unknown[]).flatMap((part, index) => {
    if (withheld.has(index)) return [];
    const { type, thinking } = record(part);
    return type === 'thinking' && typeof thinking === 'string' && thinking.length > 0
      ? [thinking]
      : [];
  });
}

/** A tool result's content as an object: the object itself, or the JSON text of one. */
function contentRecord(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') return record(content);
  try {
    return record(JSON.parse(content) as unknown);
  } catch {
    return {};
  }
}

/**
 * What a `memory_store` result says was written, or `undefined` when it says nothing was: the
 * result must be a success with `stored: true` and name the record, its collection and its class.
 * A tool that stores without naming them announces nothing, because the announcement is the
 * client's only way to find the record.
 */
function memoryWriteOf(
  result: ToolResultDetail,
): Pick<MemoryWrittenAnnouncement, 'recordId' | 'collection' | 'class'> | undefined {
  if (toolNameOf(result) !== MEMORY_STORE_TOOL_NAME || result['outcome'] !== 'success') {
    return undefined;
  }
  const content = contentRecord(result['content']);
  const { stored, id, collection, memoryClass } = content;
  if (
    stored !== true ||
    typeof id !== 'string' ||
    id === '' ||
    typeof collection !== 'string' ||
    collection === '' ||
    typeof memoryClass !== 'string' ||
    memoryClass === ''
  ) {
    return undefined;
  }
  return { recordId: id, collection, class: memoryClass };
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
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
  private readonly reasoned = new Set<number>();
  private tripwire = false;
  private readonly checkpoint = new ProjectionCheckpoint();

  constructor(
    private readonly runId: string,
    private readonly context: EventStamp,
  ) {}

  /** The Bureau session, which is the AG-UI thread. */
  private get sessionId(): string | undefined {
    return this.context.sessionId;
  }

  private live<TEvent extends Event>(event: TEvent): TEvent {
    const stamped = stamp(event, this.context, { durable: false });
    this.checkpoint.record(stamped);
    return stamped;
  }

  /**
   * An event for the streams attached now and for no one who attaches later: stamped as a live
   * event and kept out of the checkpoint a late attach replays. Reasoning is private to the run's
   * owner and must never be part of a replay; the announcements below carry nothing a message
   * row would later hold, so a checkpoint entry for them would never be released.
   */
  private liveOnly<TEvent extends Event>(event: TEvent): TEvent {
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

  /** The in-flight step at one synchronous producer cut; reading never advances projection. */
  snapshot(held: ReadonlySet<string> = new Set()): Event[] {
    return this.checkpoint.read(held);
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
          events: [
            ...this.announceReasoning(stepOf(data), thinkingOf(response)),
            ...this.completeText(
              stepOf(data),
              response['content'],
              assetPartsOf(response['parts']),
            ),
          ],
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
      case RECORDED.wakeupScheduled:
        return { events: this.announceWakeup(data) };
      case RECORDED.childStarted:
        return { events: this.announceChildStarted(data) };
      case RECORDED.childCompleted:
        return { events: this.announceChildSettled(data, 'completed') };
      case RECORDED.childFailed:
        return { events: this.announceChildSettled(data, 'failed') };
      case RECORDED.childAborted:
        return { events: this.announceChildSettled(data, 'aborted') };
      case RECORDED.runTripwire:
        this.tripwire = true;
        return { events: [] };
      case RECORDED.runCompleted:
        // COR-1627: the completion of a run that failed ends the AG-UI run with `RUN_ERROR`, by
        // the one predicate, so a reader that ends on the last terminal record (a replay, a
        // history read) ends in the error its `run.error` announced. For a run that stopped at
        // its step limit the `run.error` projected no ending, so the stream does not end before
        // the `onMaximumSteps` answer, which only this record carries.
        if (isFailureFinishReason(data['finishReason'])) {
          return {
            events: this.maximumStepsTail(data),
            terminal: { ...this.ending('error', detail), recordedAs: RECORDED.runCompleted },
          };
        }
        return { events: this.maximumStepsTail(data), terminal: this.ending('completed', detail) };
      case RECORDED.runError:
        // Only a `run.error` whose run finished at its step limit is deferred to the
        // `run.completed` that follows, which carries the `onMaximumSteps` answer. Every other
        // `run.error` ends the stream here, a record from before the payload carried a finish
        // reason included: `main` recorded no `run.error` for a run that ran out of steps, so such
        // a record is a thrown error, which ended the stream then as it does now.
        if (data['finishReason'] === 'maximum-steps') return { events: [] };
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
  closeOpen(preserve = false): Event[] {
    const events: Event[] = [];
    if (this.text !== undefined && this.text.started && !this.text.ended) {
      if (!preserve) this.text.ended = true;
      events.push(
        stamp(
          { type: EventType.TEXT_MESSAGE_END, messageId: this.messageId(this.text.step) },
          this.context,
          { durable: false },
        ),
      );
    }
    if (this.openStep !== undefined) {
      events.push(
        stamp({ type: EventType.STEP_FINISHED, stepName: stepName(this.openStep) }, this.context, {
          durable: false,
        }),
      );
      if (!preserve) this.openStep = undefined;
    }
    if (!preserve) for (const event of events) this.checkpoint.record(event);
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

  /**
   * The step's `thinking` parts as AG-UI reasoning: one span for the step, holding one message for
   * each part. Sent once for a step however many times its `generate.completed` is read, and only
   * while that step is the one in flight.
   */
  private announceReasoning(step: number | undefined, thoughts: readonly string[]): Event[] {
    if (step === undefined || this.openStep !== step || thoughts.length === 0) return [];
    if (this.reasoned.has(step)) return [];
    this.reasoned.add(step);
    const span = `${this.messageId(step)}:reasoning`;
    return [
      this.liveOnly({ type: EventType.REASONING_START, messageId: span }),
      ...thoughts.flatMap((thought, index) => {
        const messageId = `${span}:${index}`;
        return [
          this.liveOnly({ type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' }),
          this.liveOnly({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId,
            delta: thought,
          }),
          this.liveOnly({ type: EventType.REASONING_MESSAGE_END, messageId }),
        ];
      }),
      this.liveOnly({ type: EventType.REASONING_END, messageId: span }),
    ];
  }

  private announceWakeup(data: Record<string, unknown>): Event[] {
    const { duration, note, wakeAt } = data;
    if (
      (typeof duration !== 'number' && typeof duration !== 'string') ||
      typeof wakeAt !== 'number' ||
      !Number.isFinite(wakeAt)
    ) {
      return [];
    }
    const noted = textOf(note);
    const value: WakeupScheduledAnnouncement = {
      runId: this.runId,
      duration,
      ...(noted === undefined ? {} : { note: noted }),
      wakeAt,
    };
    return [this.liveOnly({ type: EventType.CUSTOM, name: WAKEUP_SCHEDULED_EVENT_NAME, value })];
  }

  private announceChildStarted(data: Record<string, unknown>): Event[] {
    const parentRunId = textOf(data['parentRunId']);
    const childRunId = textOf(data['childRunId']);
    const childAgentName = textOf(data['childAgentName']);
    if (parentRunId === undefined || childRunId === undefined || childAgentName === undefined) {
      return [];
    }
    const value: ChildRunStartedAnnouncement = {
      parentRunId,
      childRunId,
      childAgentName,
      durable: data['durable'] === true,
    };
    return [this.liveOnly({ type: EventType.CUSTOM, name: CHILD_RUN_STARTED_EVENT_NAME, value })];
  }

  private announceChildSettled(
    data: Record<string, unknown>,
    status: ChildRunSettledAnnouncement['status'],
  ): Event[] {
    const childRunId = textOf(data['childRunId']);
    if (childRunId === undefined) return [];
    const value: ChildRunSettledAnnouncement = { childRunId, status };
    return [this.liveOnly({ type: EventType.CUSTOM, name: CHILD_RUN_SETTLED_EVENT_NAME, value })];
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
          toolCallName: this.context.toolCallName?.(call.name) ?? call.name,
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
      const written = memoryWriteOf(result);
      if (written !== undefined && this.sessionId !== undefined) {
        const value: MemoryWrittenAnnouncement = {
          messageId: this.messageId(step),
          ...written,
          runId: this.runId,
          sessionId: this.sessionId,
        };
        events.push(
          this.liveOnly({ type: EventType.CUSTOM, name: MEMORY_WRITTEN_EVENT_NAME, value }),
        );
      }
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
