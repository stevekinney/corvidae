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
} from './a2a-task-projection.ts';

/** The part of a Bureau the reader needs. */
export type A2ATaskReaderBureau = Pick<Bureau, 'getRun' | 'eventHistory' | 'getReview'> & {
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
  replyOf(view: TaskView): Promise<string | undefined>;
  /** The task as one response shows it, folding a completed task's reply into its history once. */
  read(view: TaskView, shape: ProjectionShape): Promise<A2ATaskReading>;
};

/** Creates the reader of the tasks recorded in `records`. */
export function createTaskReader(options: {
  readonly bureau: A2ATaskReaderBureau;
  readonly records: A2ATaskRecords;
}): A2ATaskReader {
  const { bureau, records } = options;

  async function replyOf(view: TaskView): Promise<string | undefined> {
    if (view.status !== 'completed') return undefined;
    const run = bureau.getRun(view.id);
    const final = run?.stepDetails.findLast((step) => step.final);
    if (final !== undefined) return final.content;
    const record = await bureau.tasks.record(view.id);
    if (record?.settled?.answer !== undefined) return record.settled.answer.text;
    let since: string | undefined;
    let content: string | undefined;
    for (;;) {
      const page = await bureau.eventHistory(
        { kind: 'run', id: view.id },
        { ...(since === undefined ? {} : { since }), limit: 200 },
      );
      if (!('events' in page)) break;
      for (const event of page.events) {
        if (event.kind !== 'run.completed') continue;
        const payload = event.payload as { content?: unknown } | undefined;
        if (typeof payload?.content === 'string') content = payload.content;
      }
      if (!page.hasMore) break;
      since = page.nextCursor ?? page.events.at(-1)?.cursor;
      if (since === undefined) break;
    }
    return content;
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
    const reply = await replyOf(view);
    // The reply is folded in once it can be read: a completed task whose reply is not yet visible
    // here (its history event has not reached this instance) is folded on a later read.
    const replyReady = view.status !== 'completed' || (reply !== undefined && reply !== '');
    if (record !== undefined && isTerminal(view.status) && !record.replyRecorded && replyReady) {
      record = await records.update(view.id, (current) =>
        current.replyRecorded
          ? undefined
          : {
              ...current,
              replyRecorded: true,
              history:
                reply === undefined || reply === ''
                  ? current.history
                  : [
                      ...current.history,
                      Message.toJSON(
                        agentMessage(view, replyMessageId(view.id), reply),
                      ) as A2AWireMessage,
                    ],
            },
      );
    }
    const task = projectTask(
      {
        view,
        record,
        reply,
        acknowledgement: stored?.cleanupAcknowledgement,
        forms: await formsOf(bureau, view),
      },
      shape,
    );
    return { task, record };
  }

  return { replyOf, read };
}
