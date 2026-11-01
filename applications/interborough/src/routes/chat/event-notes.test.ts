/**
 * The lines a run leaves under a chat's messages: what the Bureau's announcements become, what a
 * reloaded thread still says of them, and that the two never double.
 */
import {
  appendMessages,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
  resolveMessageNotes,
  type ConversationHistory,
  type MessageNoteInfo,
} from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TaskView } from '../../lib/bureau-tasks.ts';

import {
  CHILD_RUN_SETTLED_EVENT_NAME,
  CHILD_RUN_STARTED_EVENT_NAME,
  MEMORY_STORE_TOOL_NAME,
  MEMORY_WRITTEN_EVENT_NAME,
  TOOL_GRANT_SETTLED_EVENT_NAME,
  WAKEUP_SCHEDULED_EVENT_NAME,
  carryLiveNotes,
  noteAnnouncementOf,
  stopReasonOf,
  taskNoteAnnouncements,
  withEventNotes,
  withStopReason,
  withStoredMemoryNotes,
  type NoteAnnouncement,
} from './event-notes.ts';

const THREAD = 'thread-1';
const conversation = (): ConversationHistory =>
  appendMessages(
    createConversationHistory({ id: THREAD }),
    { id: 'u1', role: 'user', content: 'Remember this.' },
    { id: 'a1', role: 'assistant', content: 'Done.' },
    { id: 'a2', role: 'assistant', content: 'And this too.' },
  );

function notesOn(history: ConversationHistory, id: string): MessageNoteInfo[] {
  const row = history.messages[id];
  return row === undefined ? [] : (resolveMessageNotes(row) ?? []);
}

function custom(name: string, value: unknown): unknown {
  return { type: 'CUSTOM', name, value };
}

function announced(event: unknown): NoteAnnouncement {
  const announcement = noteAnnouncementOf(event, 'helper');
  if (announcement === undefined) throw new Error('Expected an announcement.');
  return announcement;
}

describe('the announcements the page restates', () => {
  test('use the strings the Bureau’s vocabulary defines', () => {
    const vocabulary = readFileSync(
      join(import.meta.dir, '../../../../../packages/bureau/src/http/ag-ui-vocabulary.ts'),
      'utf8',
    );
    const defined = (name: string): string | undefined =>
      new RegExp(`export const ${name} = '([^']+)'`).exec(vocabulary)?.[1];
    expect(defined('MEMORY_WRITTEN_EVENT_NAME')).toBe(MEMORY_WRITTEN_EVENT_NAME);
    expect(defined('WAKEUP_SCHEDULED_EVENT_NAME')).toBe(WAKEUP_SCHEDULED_EVENT_NAME);
    expect(defined('CHILD_RUN_STARTED_EVENT_NAME')).toBe(CHILD_RUN_STARTED_EVENT_NAME);
    expect(defined('CHILD_RUN_SETTLED_EVENT_NAME')).toBe(CHILD_RUN_SETTLED_EVENT_NAME);
    expect(defined('TOOL_GRANT_SETTLED_EVENT_NAME')).toBe(TOOL_GRANT_SETTLED_EVENT_NAME);
    const projection = readFileSync(
      join(import.meta.dir, '../../../../../packages/bureau/src/http/ag-ui-projection.ts'),
      'utf8',
    );
    expect(
      new RegExp(`MEMORY_STORE_TOOL_NAME = '${MEMORY_STORE_TOOL_NAME}'`).test(projection),
    ).toBe(true);
  });
});

describe('noteAnnouncementOf', () => {
  test('reads a memory record, naming the row and the agent’s memory page', () => {
    expect(
      announced(
        custom(MEMORY_WRITTEN_EVENT_NAME, {
          messageId: 'a1',
          recordId: 'rec-1',
          collection: 'preferences',
          class: 'episodic',
          runId: 'run',
          sessionId: THREAD,
        }),
      ),
    ).toEqual({
      kind: 'note',
      anchor: 'a1',
      note: {
        kind: 'memory',
        id: 'memory:rec-1',
        recordId: 'rec-1',
        collection: 'preferences',
        memoryClass: 'episodic',
        href: '/agents/helper/memories',
      },
    });
  });

  test('reads a wakeup with the time and the note the run left', () => {
    expect(
      announced(
        custom(WAKEUP_SCHEDULED_EVENT_NAME, {
          runId: 'run',
          duration: '6h',
          note: 'check the deploy',
          wakeAt: 1_900_000_000_000,
        }),
      ),
    ).toEqual({
      kind: 'note',
      note: {
        kind: 'wakeup',
        id: 'wakeup:run:1900000000000',
        wakeAt: 1_900_000_000_000,
        note: 'check the deploy',
      },
    });
  });

  test('reads a child run starting, with a link to its page, and its end', () => {
    expect(
      announced(
        custom(CHILD_RUN_STARTED_EVENT_NAME, {
          parentRunId: 'run',
          childRunId: 'child-1',
          childAgentName: 'researcher',
          durable: false,
        }),
      ),
    ).toEqual({
      kind: 'note',
      note: {
        kind: 'child-run',
        id: 'child:child-1',
        childRunId: 'child-1',
        agentName: 'researcher',
        status: 'running',
        href: '/runs/child-1',
      },
    });
    expect(
      announced(custom(CHILD_RUN_SETTLED_EVENT_NAME, { childRunId: 'child-1', status: 'failed' })),
    ).toEqual({ kind: 'child-settled', childRunId: 'child-1', status: 'failed' });
  });

  test('reads nothing from an event that is not one, or whose value is not what the Bureau sends', () => {
    expect(
      noteAnnouncementOf({ type: 'TEXT_MESSAGE_END', messageId: 'x' }, 'helper'),
    ).toBeUndefined();
    expect(noteAnnouncementOf(custom('bureau.other', {}), 'helper')).toBeUndefined();
    expect(
      noteAnnouncementOf(custom(MEMORY_WRITTEN_EVENT_NAME, { recordId: 'r' }), 'helper'),
    ).toBeUndefined();
    expect(
      noteAnnouncementOf(
        custom(WAKEUP_SCHEDULED_EVENT_NAME, { runId: 'r', wakeAt: 'soon' }),
        'helper',
      ),
    ).toBeUndefined();
    expect(
      noteAnnouncementOf(custom(CHILD_RUN_STARTED_EVENT_NAME, { childRunId: 'c' }), 'helper'),
    ).toBeUndefined();
    expect(
      noteAnnouncementOf(
        custom(CHILD_RUN_SETTLED_EVENT_NAME, { childRunId: 'c', status: 'running' }),
        'helper',
      ),
    ).toBeUndefined();
    expect(
      noteAnnouncementOf({ type: 'CUSTOM', name: MEMORY_WRITTEN_EVENT_NAME }, 'helper'),
    ).toBeUndefined();
  });
});

describe('withEventNotes', () => {
  const memory = announced(
    custom(MEMORY_WRITTEN_EVENT_NAME, {
      messageId: 'a1',
      recordId: 'rec-1',
      collection: 'c',
      class: 'k',
    }),
  );
  const wakeup = announced(
    custom(WAKEUP_SCHEDULED_EVENT_NAME, {
      runId: 'run',
      duration: 1000,
      wakeAt: 1_900_000_000_000,
    }),
  );

  test('puts a note on the row it names and one without a row on the last reply', () => {
    const stamped = withEventNotes(conversation(), [memory, wakeup]);

    expect(notesOn(stamped, 'a1').map((note) => note.kind)).toEqual(['memory']);
    expect(notesOn(stamped, 'a2').map((note) => note.kind)).toEqual(['wakeup']);
    expect(notesOn(stamped, 'u1')).toEqual([]);
  });

  test('puts a note whose row is not held on the last reply', () => {
    const elsewhere = announced(
      custom(MEMORY_WRITTEN_EVENT_NAME, {
        messageId: 'gone',
        recordId: 'r',
        collection: 'c',
        class: 'k',
      }),
    );

    expect(notesOn(withEventNotes(conversation(), [elsewhere]), 'a2')).toHaveLength(1);
  });

  test('stamping the same note twice leaves one line', () => {
    const once = withEventNotes(conversation(), [memory]);
    const twice = withEventNotes(once, [memory, wakeup, memory]);

    expect(notesOn(twice, 'a1')).toHaveLength(1);
    expect([...twice.ids].flatMap((id) => notesOn(twice, id))).toHaveLength(2);
  });

  test('a child run’s end changes the line its start left', () => {
    const started = announced(
      custom(CHILD_RUN_STARTED_EVENT_NAME, {
        parentRunId: 'run',
        childRunId: 'c1',
        childAgentName: 'r',
      }),
    );
    const settled = announced(
      custom(CHILD_RUN_SETTLED_EVENT_NAME, { childRunId: 'c1', status: 'completed' }),
    );

    const running = withEventNotes(conversation(), [started]);
    expect(notesOn(running, 'a2')).toMatchObject([{ kind: 'child-run', status: 'running' }]);
    expect(notesOn(withEventNotes(running, [settled]), 'a2')).toMatchObject([
      { kind: 'child-run', status: 'completed' },
    ]);
  });

  test('a child run’s end with no start to change adds nothing', () => {
    const settled = announced(
      custom(CHILD_RUN_SETTLED_EVENT_NAME, { childRunId: 'c1', status: 'failed' }),
    );

    const held = conversation();
    expect(withEventNotes(held, [settled])).toBe(held);
  });

  test('adds nothing to a conversation with no row', () => {
    const none = createConversationHistory({ id: THREAD });

    expect(withEventNotes(none, [memory])).toEqual(none);
  });
});

describe('withStoredMemoryNotes', () => {
  const stored = (
    content: unknown,
    outcome: 'success' | 'error' = 'success',
    name = 'memory_store',
  ) => {
    let history = appendUserMessage(createConversationHistory({ id: THREAD }), 'Remember it');
    history = appendMessages(history, { id: 'a1', role: 'assistant', content: 'Saving.' });
    history = appendToolCall(history, { id: 'call-1', name, arguments: {} });
    history = appendToolResult(history, {
      callId: 'call-1',
      outcome,
      content,
    });
    return appendMessages(history, { id: 'a2', role: 'assistant', content: 'Saved.' });
  };

  test('shows a stored record under the reply that wrote it, as the live announcement would', () => {
    const history = withStoredMemoryNotes(
      stored({ stored: true, id: 'rec-1', collection: 'prefs', memoryClass: 'semantic' }),
      'helper',
    );

    expect(notesOn(history, 'a1')).toEqual([
      {
        kind: 'memory',
        id: 'memory:rec-1',
        recordId: 'rec-1',
        collection: 'prefs',
        memoryClass: 'semantic',
        href: '/agents/helper/memories',
      },
    ]);
    expect(notesOn(history, 'a2')).toEqual([]);
  });

  test('reads a result that arrived as JSON text', () => {
    const history = withStoredMemoryNotes(
      stored(JSON.stringify({ stored: true, id: 'rec-2', collection: 'c', memoryClass: 'k' })),
      'helper',
    );

    expect(notesOn(history, 'a1')).toHaveLength(1);
  });

  test('is the same line the announcement made, not a second one', () => {
    const history = stored({
      stored: true,
      id: 'rec-1',
      collection: 'prefs',
      memoryClass: 'semantic',
    });
    const live = withEventNotes(history, [
      announced(
        custom(MEMORY_WRITTEN_EVENT_NAME, {
          messageId: 'a2',
          recordId: 'rec-1',
          collection: 'prefs',
          class: 'semantic',
        }),
      ),
    ]);

    const both = withStoredMemoryNotes(live, 'helper');

    expect(both.ids.flatMap((id) => notesOn(both, id))).toHaveLength(1);
  });

  test('says nothing for a failed store, a record that was not stored, or another tool', () => {
    const ok = { stored: true, id: 'r', collection: 'c', memoryClass: 'k' };
    for (const history of [
      stored(ok, 'error'),
      stored({ ...ok, stored: false }),
      stored({ stored: true, id: 'r' }),
      stored('not json'),
      stored(ok, 'success', 'memory_search'),
    ]) {
      const result = withStoredMemoryNotes(history, 'helper');
      expect(result.ids.flatMap((id) => notesOn(result, id))).toEqual([]);
    }
  });
});

describe('why the last run stopped', () => {
  const task = (status: string, finishReason: string | null, statusMessage: string | null = null) =>
    ({ status, finishReason, statusMessage }) as Parameters<typeof stopReasonOf>[0];

  test('is the task’s own message when it left one', () => {
    expect(stopReasonOf(task('failed', 'budget-exceeded', 'Budget exceeded: max calls 1'))).toBe(
      'Budget exceeded: max calls 1',
    );
  });

  test('has words for a finish reason that left no message', () => {
    expect(stopReasonOf(task('failed', 'maximum-steps'))).toBe('The run reached its step limit.');
    expect(stopReasonOf(task('failed', 'tripwire'))).toBe('A guardrail stopped the run.');
    expect(stopReasonOf(task('completed', 'budget-exceeded'))).toBe('The run reached its budget.');
    expect(stopReasonOf(task('canceled', null))).toBe('The run was stopped.');
    expect(stopReasonOf(task('failed', null))).toBe('The run failed.');
    expect(stopReasonOf(task('failed', 'something-new'))).toBe('The run failed.');
  });

  test('is nothing for a run that is going, is waiting, or ended its normal way', () => {
    expect(stopReasonOf(task('working', null))).toBeUndefined();
    expect(stopReasonOf(task('input-required', null))).toBeUndefined();
    expect(stopReasonOf(task('submitted', null))).toBeUndefined();
    expect(stopReasonOf(task('completed', 'stop-condition'))).toBeUndefined();
    expect(stopReasonOf(task('completed', null))).toBeUndefined();
    expect(stopReasonOf(task('completed', 'constructor'))).toBeUndefined();
  });

  test('shows under the last reply, and nowhere for a run that did not stop', () => {
    const stopped = withStopReason(
      conversation(),
      task('failed', 'budget-exceeded', 'Over budget'),
    );

    expect(notesOn(stopped, 'a2')).toEqual([
      { kind: 'stopped', id: 'stopped', reason: 'Over budget' },
    ]);
    const held = conversation();
    expect(withStopReason(held, task('completed', null))).toBe(held);
    expect(withStopReason(held, undefined)).toBe(held);
  });

  test('shows under the person’s message when the run stopped before it answered', () => {
    const asked = appendUserMessage(createConversationHistory({ id: THREAD }), 'Do it');

    const stopped = withStopReason(asked, task('failed', 'error', 'Provider unavailable'));

    expect(notesOn(stopped, asked.ids[0]!)).toMatchObject([{ kind: 'stopped' }]);
  });
});

describe('carryLiveNotes', () => {
  test('keeps what only the stream said on the rows a fresh read still has', () => {
    const live = withEventNotes(conversation(), [
      announced(custom(WAKEUP_SCHEDULED_EVENT_NAME, { runId: 'run', duration: 1, wakeAt: 5 })),
      announced(
        custom(MEMORY_WRITTEN_EVENT_NAME, {
          messageId: 'a1',
          recordId: 'r',
          collection: 'c',
          class: 'k',
        }),
      ),
      announced(
        custom(CHILD_RUN_STARTED_EVENT_NAME, {
          parentRunId: 'run',
          childRunId: 'c1',
          childAgentName: 'x',
        }),
      ),
    ]);

    const reread = carryLiveNotes(live, conversation());

    // The memory line is the thread's to say again; the wakeup and the child run are not.
    expect(reread.ids.flatMap((id) => notesOn(reread, id)).map((note) => note.kind)).toEqual([
      'wakeup',
      'child-run',
    ]);
  });

  test('drops a note whose row the fresh read no longer has', () => {
    const live = withEventNotes(conversation(), [
      announced(custom(WAKEUP_SCHEDULED_EVENT_NAME, { runId: 'run', duration: 1, wakeAt: 5 })),
    ]);
    const shorter = appendMessages(createConversationHistory({ id: THREAD }), {
      id: 'u1',
      role: 'user',
      content: 'Remember this.',
    });

    const reread = carryLiveNotes(live, shorter);

    expect(reread.ids.flatMap((id) => notesOn(reread, id))).toEqual([]);
  });
});

describe('taskNoteAnnouncements', () => {
  const NOW = Date.parse('2026-11-01T12:00:00.000Z');
  const AHEAD = '2026-11-01T18:00:00.000Z';
  const child = (overrides: Partial<TaskView> = {}): TaskView => ({
    id: 'child-1',
    contextId: 'child-context',
    agentName: 'researcher',
    owner: 'owner',
    actor: null,
    kind: 'catalog',
    origin: { kind: 'agent', parentRunId: 'run-1', parentContextId: THREAD, agentName: 'helper' },
    status: 'working',
    finishReason: null,
    statusMessage: null,
    createdAt: '2026-11-01T11:00:00.000Z',
    updatedAt: '2026-11-01T11:00:00.000Z',
    cleanup: null,
    openWaits: [],
    wakeAt: null,
    ...overrides,
  });
  const announce = (
    runs: Parameters<typeof taskNoteAnnouncements>[0],
    children: readonly TaskView[],
    history: ConversationHistory = conversation(),
  ) => taskNoteAnnouncements(runs, children, history, NOW);

  test('makes the note the live announcement made, so the two are one line', () => {
    const live = announced(
      custom(WAKEUP_SCHEDULED_EVENT_NAME, {
        runId: 'run-1',
        duration: '6h',
        wakeAt: Date.parse(AHEAD),
      }),
    );
    const liveChild = announced(
      custom(CHILD_RUN_STARTED_EVENT_NAME, {
        parentRunId: 'run-1',
        childRunId: 'child-1',
        childAgentName: 'researcher',
      }),
    );

    const [wakeup, started] = announce([{ id: 'run-1', wakeAt: AHEAD }], [child()]);

    // A note is the same line when it has the same id, and what it says of the run is what the
    // announcement said.
    expect(wakeup).toMatchObject({ kind: 'note', note: live.kind === 'note' ? live.note : null });
    expect(started).toMatchObject({
      kind: 'note',
      note: liveChild.kind === 'note' ? liveChild.note : null,
    });
    const once = withEventNotes(conversation(), [live, liveChild]);
    const reloaded = withEventNotes(once, announce([{ id: 'run-1', wakeAt: AHEAD }], [child()]));
    expect(reloaded.ids.flatMap((id) => notesOn(reloaded, id)).map((note) => note.kind)).toEqual([
      'wakeup',
      'child-run',
    ]);
  });

  test('says nothing of a wakeup that is not pending: none, past, or unreadable', () => {
    expect(
      announce(
        [
          { id: 'a', wakeAt: null },
          { id: 'b' },
          { id: 'c', wakeAt: '2026-11-01T11:59:59.000Z' },
          { id: 'd', wakeAt: 'tomorrow' },
        ],
        [],
      ),
    ).toEqual([]);
  });

  test('shows a child run with its agent and a link to its page, whatever state it is in', () => {
    const states = [
      ['submitted', 'running'],
      ['working', 'running'],
      ['input-required', 'running'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['canceled', 'aborted'],
    ] as const;

    for (const [status, shown] of states) {
      expect(announce([], [child({ status })])).toEqual([
        {
          kind: 'note',
          note: {
            kind: 'child-run',
            id: 'child:child-1',
            childRunId: 'child-1',
            agentName: 'researcher',
            status: shown,
            href: '/runs/child-1',
          },
        },
      ]);
    }
  });

  test('leaves out a child run with no agent to name', () => {
    expect(announce([], [child({ agentName: null })])).toEqual([]);
  });

  test('puts a child run under the reply before the tool call that started it', () => {
    let history = appendUserMessage(createConversationHistory({ id: THREAD }), 'Dig in');
    history = appendMessages(history, { id: 'a1', role: 'assistant', content: 'Delegating.' });
    history = appendToolCall(history, { id: 'call-1', name: 'delegate', arguments: {} });
    history = appendToolResult(history, { callId: 'call-1', outcome: 'success', content: 'ok' });
    history = appendMessages(
      history,
      { id: 'u2', role: 'user', content: 'Again' },
      { id: 'a2', role: 'assistant', content: 'Again, then.' },
    );
    const started = child({
      origin: { kind: 'agent', parentRunId: 'run-1', agentName: 'helper', toolCallId: 'call-1' },
    });

    const stamped = withEventNotes(history, announce([], [started], history), {
      owns: () => true,
    });

    expect(notesOn(stamped, 'a1').map((note) => note.kind)).toEqual(['child-run']);
    expect(notesOn(stamped, 'a2')).toEqual([]);
  });

  test('puts a child run with no call to find on the last reply', () => {
    const stamped = withEventNotes(
      conversation(),
      announce(
        [],
        [child({ origin: { kind: 'agent', parentRunId: 'run-1', toolCallId: 'gone' } })],
      ),
      { owns: () => true },
    );

    expect(notesOn(stamped, 'a2').map((note) => note.kind)).toEqual(['child-run']);
  });
});
