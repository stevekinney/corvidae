/**
 * Reading one task as an A2A `Task` (COR-903, COR-1543): its reply, and the wire task a response
 * or a push snapshot carries. The request handler and the push projector read through it, so a
 * task looks the same wherever it is sent.
 *
 * @module a2a-task-reader
 */

import { Message, type Task } from '@a2a-js/sdk';

import type { TaskRegistry, TaskView } from '../task-registry.ts';
import type { Bureau } from '../types.ts';
import { formsOf } from './a2a-input-forms.ts';
import {
  type A2ATaskRecord,
  type A2ATaskRecords,
  type A2AWireMessage,
  clearedRecord,
} from './a2a-task-record.ts';
import {
  agentMessage,
  isTerminal,
  projectTask,
  type ProjectionShape,
  replyMessageId,
  type ReplyParts,
  textPart,
} from './a2a-task-projection.ts';
import type { MultiModalContent } from 'conversationalist';
import { replyPartsOf } from './a2a-reply-parts.ts';

/** The part of a Bureau the reader needs. */
export type A2ATaskReaderBureau = Pick<
  Bureau,
  'getRun' | 'eventHistory' | 'getReview' | 'assets' | 'surfaces'
> & {
  readonly tasks: Pick<TaskRegistry, 'record'>;
};

/** A task as one response shows it, with the record it was read from. */
export type A2ATaskReading = {
  readonly task: Task;
  readonly record: A2ATaskRecord | undefined;
};

/** Reads tasks for A2A responses and push snapshots. */
export type A2ATaskReader = {
  /** The agent's reply on a completed task: from the live run, its settlement, or its history. */
  replyOf(view: TaskView): Promise<ReplyParts | undefined>;
  /** The task as one response shows it, folding a completed task's reply into its history once. */
  read(view: TaskView, shape: ProjectionShape): Promise<A2ATaskReading>;
  /** Records a settled task's reply in its A2A record, so a restart before any read loses nothing. */
  recordSettled(view: TaskView): Promise<void>;
};

/** Creates the reader of the tasks recorded in `records`. */
export function createTaskReader(options: {
  readonly bureau: A2ATaskReaderBureau;
  readonly records: A2ATaskRecords;
  /** The handler's public origin and base path: a reply's media is served from its asset route. */
  readonly publicUrl: string;
}): A2ATaskReader {
  const { bureau, records } = options;
  const textOf = (text: string): ReplyParts => (text === '' ? [] : [textPart(text)]);

  /**
   * The reply a recorded A2A history already holds: once a completed task's reply is folded into
   * its record, that message is the reply, whatever the run has since forgotten (a restart).
   */
  async function recordedReplyOf(view: TaskView): Promise<ReplyParts | undefined> {
    const record = await records.read(view.id);
    const held = record?.history.find(
      (message) => message['messageId'] === replyMessageId(view.id),
    );
    return held === undefined ? undefined : Message.fromJSON(held).parts;
  }

  /** A reply, and whether it came from the one source that holds only a task's text. */
  type Reply = { readonly parts: ReplyParts; readonly textOnlyFallback: boolean };

  async function resolveReply(view: TaskView): Promise<Reply | undefined> {
    if (view.status !== 'completed') return undefined;
    const context = { publicUrl: options.publicUrl, assets: bureau.assets, owner: view.owner };
    // Once the reply is folded into the task's record, that message is the reply, whatever the run
    // holds or has since forgotten: a later read replays the same wire result.
    const recorded = await recordedReplyOf(view);
    if (recorded !== undefined && recorded.length > 0) {
      return { parts: recorded, textOnlyFallback: false };
    }
    const run = bureau.getRun(view.id);
    const final = run?.stepDetails.findLast((step) => step.final);
    if (final !== undefined) {
      const projected = await replyPartsOf(final.parts, context);
      return {
        parts: projected.length > 0 ? projected : textOf(final.content),
        textOnlyFallback: false,
      };
    }
    // Otherwise the run's durable `run.completed` event: its parts hold generated media as managed
    // assets, so a task completed before a restart, or by another process, keeps its media.
    let since: string | undefined;
    let content: string | undefined;
    let held: readonly unknown[] = [];
    for (;;) {
      const page = await bureau.eventHistory(
        { kind: 'run', id: view.id },
        { ...(since === undefined ? {} : { since }), limit: 200 },
      );
      if (!('events' in page)) break;
      for (const event of page.events) {
        if (event.kind !== 'run.completed') continue;
        const payload = event.payload as { content?: unknown; parts?: unknown } | undefined;
        if (typeof payload?.content === 'string') content = payload.content;
        if (Array.isArray(payload?.parts)) held = payload.parts as unknown[];
      }
      if (!page.hasMore) break;
      since = page.nextCursor ?? page.events.at(-1)?.cursor;
      if (since === undefined) break;
    }
    const projected = await replyPartsOf(held as MultiModalContent[], context);
    if (projected.length > 0) return { parts: projected, textOnlyFallback: false };
    if (content !== undefined && content !== '') {
      return { parts: textOf(content), textOnlyFallback: false };
    }
    // The registry's bounded answer text is a last resort: it cannot say whether the run produced
    // media, so a reply read from it is shown but never recorded as the task's reply.
    const stored = await bureau.tasks.record(view.id);
    if (stored?.settled?.answer !== undefined) {
      return { parts: textOf(stored.settled.answer.text), textOnlyFallback: true };
    }
    return content === undefined ? undefined : { parts: [], textOnlyFallback: false };
  }

  async function replyOf(view: TaskView): Promise<ReplyParts | undefined> {
    const reply = await resolveReply(view);
    return reply?.parts;
  }

  /**
   * Folds a terminal task's reply into its record once it can be read: a completed task whose
   * reply is not yet visible here (its history event has not reached this instance) is folded on
   * a later read, and a reply read from the text-only fallback is not recorded.
   */
  async function foldReply(
    view: TaskView,
    record: A2ATaskRecord | undefined,
    reply: Reply | undefined,
  ): Promise<A2ATaskRecord | undefined> {
    if (record === undefined || !isTerminal(view.status) || record.replyRecorded) return record;
    const parts = reply?.parts ?? [];
    if (view.status === 'completed' && (parts.length === 0 || reply?.textOnlyFallback === true)) {
      return record;
    }
    return records.update(view.id, (current) =>
      current.replyRecorded
        ? undefined
        : {
            ...current,
            replyRecorded: true,
            history:
              parts.length === 0
                ? current.history
                : [
                    ...current.history,
                    Message.toJSON(
                      agentMessage(view, replyMessageId(view.id), parts),
                    ) as A2AWireMessage,
                  ],
          },
    );
  }

  /** Records a task's reply when it settles, on the instance that ran it. */
  async function recordSettled(view: TaskView): Promise<void> {
    await foldReply(view, await records.read(view.id), await resolveReply(view));
  }

  async function read(view: TaskView, shape: ProjectionShape): Promise<A2ATaskReading> {
    const stored = await bureau.tasks.record(view.id);
    let record = await records.read(view.id);
    // A deleted context empties its tasks' own history, and the A2A history goes with it, even on
    // an instance that did not see the deletion happen.
    if (record !== undefined && stored !== undefined && stored.history.length === 0) {
      if (record.history.length > 0 || !record.replyRecorded) {
        record = await records.update(view.id, (current) =>
          current.history.length === 0 && current.replyRecorded
            ? undefined
            : clearedRecord(current),
        );
      }
    }
    const reply = await resolveReply(view);
    record = await foldReply(view, record, reply);
    const task = projectTask(
      {
        view,
        record,
        reply: reply?.parts,
        acknowledgement: stored?.cleanupAcknowledgement,
        forms: await formsOf(bureau, view),
        surfaces: await bureau.surfaces?.list(view.id),
      },
      shape,
    );
    return { task, record };
  }

  return { replyOf, read, recordSettled };
}
