/**
 * What happened in a run, in order (rows 55s, 06b and 06f): when it started and what set it going,
 * each tool call with how long after the start it was made and how long it ran, what the run asked
 * a person (an approval or a question) and what it does once that is answered, and, for a run that
 * has not replied, that the reply is not there yet. The calls are the run's rows of the chat
 * thread it belongs to (`run-tool-calls.ts`); a row carries the time it was written, and a call's
 * result row records the start and end of the call when the Bureau knew them.
 *
 * Pure: the page reads the thread, and this turns its rows into the entries the section draws.
 */
import { z } from 'zod';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import { clockTime } from '../../../lib/format/clock.ts';
import {
  formatCallDuration,
  keyInput,
  recordedTiming,
  toolDisplayName,
} from '../../chat/tool-activity.ts';
import { toolCallsOfRun } from './run-tool-calls.ts';

/** Where an entry stands: it happened, it is what the run is on now, or it is still to come. */
export type HappenedState = 'done' | 'current' | 'pending';

/** One entry of what happened. */
export type HappenedEntry = {
  /** Distinguishes the entry among the others. */
  readonly key: string;
  /** What happened, in a line. */
  readonly title: string;
  /** How long after the run started it happened, in milliseconds; absent when no time is known. */
  readonly offsetMilliseconds?: number | undefined;
  /** A second, muted line. */
  readonly detail?: string | undefined;
  readonly state: HappenedState;
};

/** What the entries are made from. */
export type HappenedInput = {
  readonly runId: string;
  /** The AG-UI messages of the chat thread the run belongs to. */
  readonly messages: readonly unknown[];
  /** When the run started, in epoch milliseconds. */
  readonly startedAt: number;
  /** What the run waits on a person for, if it does. */
  readonly waiting: 'answer' | 'approval' | null;
  /** Whether the run is over, so nothing is still to come. */
  readonly over: boolean;
  /** The IANA zone the clock is written in; defaults to the viewer's. */
  readonly zone?: string | undefined;
  /** How the run ended and when (epoch milliseconds), for a run that is over: the last entry says it. */
  readonly ended?:
    { readonly outcome: 'done' | 'failed' | 'canceled'; readonly at: number } | undefined;
};

const timeOf = z.string().optional();
const userRow = z.object({ id: z.string(), role: z.literal('user'), createdAt: timeOf });
const assistantRow = z.object({
  id: z.string(),
  role: z.literal('assistant'),
  createdAt: timeOf,
  toolCalls: z.array(z.object({ id: z.string() })).optional(),
});
const toolRow = z.object({
  id: z.string(),
  role: z.literal('tool'),
  toolCallId: z.string(),
  createdAt: timeOf,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** A time written as text, as epoch milliseconds, or `undefined` when it is not a date. */
function epochOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** When each call started and how long it ran, and when the message that started the run was sent. */
function timesOfThread(
  runId: string,
  messages: readonly unknown[],
): {
  readonly callStarts: ReadonlyMap<string, number>;
  readonly callDurations: ReadonlyMap<string, number>;
  readonly messageInAt: number | undefined;
} {
  const callStarts = new Map<string, number>();
  const callDurations = new Map<string, number>();
  let lastUserAt: number | undefined;
  let messageInAt: number | undefined;
  let seenRun = false;
  for (const message of messages) {
    const user = userRow.safeParse(message);
    if (user.success) {
      lastUserAt = seenRun ? lastUserAt : epochOf(user.data.createdAt);
      continue;
    }
    const assistant = assistantRow.safeParse(message);
    if (assistant.success && assistant.data.id.startsWith(`${runId}:`)) {
      if (!seenRun) messageInAt = lastUserAt;
      seenRun = true;
      const wrote = epochOf(assistant.data.createdAt);
      for (const call of assistant.data.toolCalls ?? []) {
        if (wrote !== undefined) callStarts.set(call.id, wrote);
      }
      continue;
    }
    const tool = toolRow.safeParse(message);
    if (tool.success && tool.data.id.startsWith(`${runId}:`)) {
      const timing = recordedTiming(tool.data.metadata);
      if (timing === undefined) continue;
      callStarts.set(tool.data.toolCallId, timing.startedAt);
      callDurations.set(tool.data.toolCallId, timing.endedAt - timing.startedAt);
    }
  }
  return { callStarts, callDurations, messageInAt };
}

/** The offset of an instant from the run's start, or `undefined` when it is not known or is before it. */
function offsetOf(at: number | undefined, startedAt: number): number | undefined {
  return at === undefined || at < startedAt ? undefined : at - startedAt;
}

/** What happened in the run, in order. The first entry is always the start. */
export function happenedOfRun(input: HappenedInput): HappenedEntry[] {
  const copy = RUN_DETAIL_COPY.happened;
  const { startedAt, waiting, over, zone } = input;
  const times = timesOfThread(input.runId, input.messages);
  const calls = toolCallsOfRun(input.runId, input.messages);

  const entries: HappenedEntry[] = [
    {
      key: 'started',
      title: copy.started(clockTime(startedAt, zone)),
      detail:
        times.messageInAt === undefined
          ? undefined
          : copy.startedByMessage(clockTime(times.messageInAt, zone)),
      state: 'done',
    },
  ];

  let askedApproval = false;
  for (const call of calls) {
    const offsetMilliseconds = offsetOf(times.callStarts.get(call.callId), startedAt);
    if (call.state === 'needs-you') {
      askedApproval = true;
      entries.push({
        key: `call:${call.callId}`,
        title: copy.askedApproval,
        offsetMilliseconds,
        detail: copy.waitingForApproval,
        state: 'current',
      });
      continue;
    }
    const name = toolDisplayName(call.name);
    const subject = keyInput(call.arguments);
    const duration = times.callDurations.get(call.callId);
    entries.push({
      key: `call:${call.callId}`,
      title: subject === '' ? name : `${name} ${subject}`,
      offsetMilliseconds,
      detail: duration === undefined ? undefined : copy.ranIn(name, formatCallDuration(duration)),
      state: call.state === 'running' ? 'current' : 'done',
    });
  }

  if (waiting === 'approval' && !askedApproval) {
    entries.push({
      key: 'asked',
      title: copy.askedApproval,
      detail: copy.waitingForApproval,
      state: 'current',
    });
  } else if (waiting === 'answer') {
    entries.push({
      key: 'asked',
      title: copy.askedAnswer,
      detail: copy.waitingForAnswer,
      state: 'current',
    });
  }

  if (waiting !== null) {
    entries.push({
      key: 'next',
      title: copy.nextSteps,
      detail: waiting === 'approval' ? copy.nextApprovalWords : copy.nextAnswerWords,
      state: 'pending',
    });
  } else if (!over) {
    entries.push({ key: 'replied', title: copy.replied, detail: copy.notRun, state: 'pending' });
  }
  // A run that is over ends on how it ended, so the sequence never stops at "Started".
  if (over && input.ended !== undefined) {
    entries.push({
      key: 'ended',
      title: copy.ended[input.ended.outcome](clockTime(input.ended.at, zone)),
      offsetMilliseconds: offsetOf(input.ended.at, startedAt),
      state: 'done',
    });
  }
  return entries;
}
