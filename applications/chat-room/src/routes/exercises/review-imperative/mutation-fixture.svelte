<script lang="ts">
  import LiveAnnouncement from './live-announcement.svelte';
  import MutationReadouts from './mutation-readouts.svelte';
  import {
    ReviewEditor,
    addComment,
    addThread,
    deleteComment as deleteCommentReducer,
    deleteThread as deleteThreadReducer,
    timestamp,
    updateComment as updateCommentReducer,
    type Thread,
    type ThreadCreateEvent,
  } from '@repo/editor';
  import {
    AUTHOR,
    AUTHOR_SEED,
    BLOCK_SHIFT_TEXT,
    INITIAL,
    PARAGRAPH_ONE,
    PARAGRAPH_TWO,
    PARAGRAPH_THREE,
    QUOTE_FROM,
    QUOTE_TO,
    anchorRows,
    announcementForReviewRecord,
    compactAnchorRows,
    firstCommentId,
    firstThreadId,
    keepingFocus,
    select,
    threadFromCreateEvent,
  } from './imperative-utilities';
  let value = $state(INITIAL);
  let threads = $state<Thread[]>([]);
  const READONLY_INITIAL = `### Readonly Reference\n\n${PARAGRAPH_ONE}\n\n${PARAGRAPH_TWO}`;
  let readonlyValue = $state(READONLY_INITIAL);
  const SEEDED_READONLY_THREAD: Thread = {
    id: 'readonly-thread-1',
    anchor: {
      from: 0,
      to: 0,
      quote: '',
      prefix: '',
      suffix: '',
      type: 'document',
      status: 'anchored',
    } as Thread['anchor'],
    comments: [
      {
        id: 'readonly-comment-1',
        threadId: 'readonly-thread-1',
        authorId: AUTHOR_SEED,
        body: 'Seeded so the readonly guards have something to refuse.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  let readonlyThreads = $state<Thread[]>([structuredClone(SEEDED_READONLY_THREAD)]);
  let readonlyEvents = $state<string[]>([]);
  let editor = $state<ReturnType<typeof ReviewEditor>>();
  let readonlyEditor = $state<ReturnType<typeof ReviewEditor>>();

  function applyThreadCreate(event: ThreadCreateEvent) {
    threads = addThread(threads, threadFromCreateEvent(event)).threads;
  }
  let lastReturn = $state('(none)');
  let lastCall = $state('(none)');
  let events = $state<string[]>([]);
  let announcement = $state('');
  function announce(text: string) {
    announcement = '';
    queueMicrotask(() => {
      announcement = text;
    });
  }
  type Outcome = 'refused' | 'completed' | 'created';
  export function record(
    name: string,
    outcome: Outcome,
    result: unknown,
    detail?: {
      reason?: string;
      noun?: string;
      tally?: string;
    },
  ) {
    lastCall = name;
    lastReturn = result === null ? 'null' : result === undefined ? 'undefined' : String(result);
    const editable = threads.length;
    const readonlyCount = readonlyThreads.length;
    const tally =
      detail?.tally ??
      `${editable} ${editable === 1 ? 'thread' : 'threads'} in the editable review, ${readonlyCount} in the readonly one`;
    announce(announcementForReviewRecord(name, outcome, detail, tally));
  }
  function recordRefused(name: string, result?: unknown) {
    record(name, 'refused', result, { reason: 'the editor is readonly' });
  }
  function recordVoid(
    name: string,
    call: () => void,
    reason: string,
    observe: () => number = () => events.length,
  ) {
    const before = observe();
    call();
    const happened = observe() > before;
    record(name, happened ? 'completed' : 'refused', undefined, { reason });
  }
  const anchorsJson = $derived(JSON.stringify(anchorRows(threads)));
  const readonlyAnchorsJson = $derived(JSON.stringify(compactAnchorRows(readonlyThreads)));
  let probeJson = $state('[]');
  let selectionJson = $state('null');
  let selectionAtCall = $state('null');
  function readSelection() {
    const viaGetSelection = editor?.getSelection() ?? null;
    const view = editor?.getView();
    const fromView = view ? { from: view.state.selection.from, to: view.state.selection.to } : null;
    selectionJson = JSON.stringify({ viaGetSelection, view: fromView });
  }
  function probeOffsets() {
    const view = editor?.getView();
    if (!view) {
      probeJson = '[]';
      return;
    }
    probeJson = JSON.stringify(
      threads.map((thread) => {
        const from = thread.anchor?.from;
        if (typeof from !== 'number') return null;
        return view.state.doc.textBetween(0, from, '\n').length;
      }),
    );
  }
  async function createAnchoredThread() {
    await select(editor, QUOTE_FROM, QUOTE_TO);
    const created = editor?.createThread('Is this the right surface?', AUTHOR) ?? null;
    record('createThread', created ? 'created' : 'refused', created, {
      reason: 'no text is currently selected',
      noun: 'a thread',
    });
    probeOffsets();
  }
  async function createAnchoredThreadReadonly() {
    await select(readonlyEditor, QUOTE_FROM, QUOTE_TO);
    recordRefused(
      'createThread(readonly)',
      readonlyEditor?.createThread('Should not exist', AUTHOR) ?? null,
    );
  }
  function resetReadonly() {
    const beforeValue = readonlyValue;
    const beforeEvents = readonlyEvents.length;
    readonlyEditor?.reset();
    const released = readonlyEvents.length - beforeEvents;
    const restored = readonlyValue !== beforeValue;
    record('reset(readonly)', restored || released > 0 ? 'completed' : 'refused', undefined, {
      reason: 'the editor is readonly',
    });
  }
</script>

<section aria-labelledby="editable-heading">
  <h2 id="editable-heading">Editable</h2>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
    <button data-testid="create-thread" onclick={() => keepingFocus(createAnchoredThread)}
      >createThread</button
    >
    <button
      data-testid="create-thread-nodomselect"
      onclick={() => {
        const view = editor?.getView();
        selectionAtCall = view
          ? JSON.stringify({ from: view.state.selection.from, to: view.state.selection.to })
          : 'null';
        const dragged = editor?.createThread('From a real drag', AUTHOR) ?? null;
        record('createThread(existing selection)', dragged ? 'created' : 'refused', dragged, {
          reason: 'no text is currently selected',
          noun: 'a thread',
        });
        probeOffsets();
      }}>createThread (existing selection)</button
    >
    <button
      data-testid="create-document-thread"
      onclick={() => {
        const documentId = editor?.createDocumentThread('Document-level note', AUTHOR) ?? null;
        record('createDocumentThread', documentId ? 'created' : 'refused', documentId, {
          reason: 'unexpected — this method has no other guard on an editable instance',
          noun: 'a document-level thread',
        });
        probeOffsets();
      }}>createDocumentThread</button
    >
    <button
      data-testid="create-block-thread"
      onclick={() =>
        keepingFocus(async () => {
          await select(editor, 200, 200);
          const blockId = editor?.createBlockThread('Whole-block note', AUTHOR) ?? null;
          record('createBlockThread', blockId ? 'created' : 'refused', blockId, {
            reason: 'the editor view is not ready, or the caret is not inside a block',
            noun: 'a block-level thread',
          });
          probeOffsets();
        })}>createBlockThread</button
    >
    <button
      data-testid="create-block-thread-at-doc-start"
      onclick={() =>
        keepingFocus(async () => {
          await select(editor, 0, 0);
          const blockId = editor?.createBlockThread('Should not exist', AUTHOR) ?? null;
          record('createBlockThread', blockId ? 'created' : 'refused', blockId, {
            reason: 'the editor view is not ready, or the caret is not inside a block',
            noun: 'a block-level thread',
          });
        })}>createBlockThread (at doc start)</button
    >
    <button
      data-testid="create-comment"
      onclick={() => {
        const id = editor?.createComment(firstThreadId(threads), 'A reply', AUTHOR) ?? null;
        record('createComment', id ? 'created' : 'refused', id, {
          reason: 'no thread exists to comment on',
          noun: 'a comment',
        });
      }}>createComment</button
    >
    <button
      data-testid="update-comment"
      onclick={() => {
        recordVoid(
          'updateComment',
          () =>
            editor?.updateComment(firstThreadId(threads), firstCommentId(threads), 'Edited body'),
          'no eligible comment to update',
        );
      }}>updateComment</button
    >
    <button
      data-testid="delete-comment-soft"
      onclick={() => {
        recordVoid(
          'deleteComment(soft default)',
          () => editor?.deleteComment(firstThreadId(threads), firstCommentId(threads)),
          'no eligible comment to delete',
        );
      }}>deleteComment (soft)</button
    >
    <button
      data-testid="delete-comment-hard"
      onclick={() => {
        recordVoid(
          'deleteComment(hard)',
          () => editor?.deleteComment(firstThreadId(threads), firstCommentId(threads), false),
          'no eligible comment to delete',
        );
      }}>deleteComment (hard)</button
    >
    <button
      data-testid="delete-thread"
      onclick={() => {
        recordVoid(
          'deleteThread',
          () => editor?.deleteThread(firstThreadId(threads)),
          'no eligible thread to delete',
        );
        probeOffsets();
      }}>deleteThread</button
    >
    <button
      data-testid="clear-all-threads"
      onclick={() => {
        recordVoid('clearAllThreads', () => editor?.clearAllThreads(), 'no threads to clear');
        probeOffsets();
      }}>clearAllThreads</button
    >
    <button
      data-testid="insert-before-block"
      onclick={() => {
        value = value.replace(PARAGRAPH_ONE, `${BLOCK_SHIFT_TEXT}${PARAGRAPH_ONE}`);
      }}>insert before block</button
    >
    <button
      data-testid="edit-elsewhere"
      onclick={() => {
        value = value.replace(PARAGRAPH_THREE, `${PARAGRAPH_THREE} Mitigation is drafted.`);
      }}>edit elsewhere</button
    >
    <button
      data-testid="remove-quote"
      onclick={() => {
        value = value.replace('a dashboard, ', 'a ');
      }}>remove quoted text</button
    >
    <button data-testid="probe-offsets" onclick={probeOffsets}>probe offsets</button>
    <button data-testid="read-selection" onclick={readSelection}>read selection</button>
    <button
      data-testid="select-quote"
      onclick={() =>
        keepingFocus(async () => {
          await select(editor, QUOTE_FROM, QUOTE_TO);
          readSelection();
        })}>select quote</button
    >
  </div>

  <div data-testid="editor-host">
    <ReviewEditor
      bind:this={editor}
      id="imperative-editor"
      name="imperative"
      bind:value
      bind:threads
      currentUserId={AUTHOR}
      onthreadcreate={(event) => {
        events = [...events, `onthreadcreate:${event.requestId}`];
        applyThreadCreate(event);
        probeOffsets();
      }}
      onthreaddelete={(event) => {
        events = [...events, `onthreaddelete:${event.threadId}`];
        threads = deleteThreadReducer(threads, event.threadId).threads;
        probeOffsets();
      }}
      oncommentcreate={(event) => {
        events = [...events, `oncommentcreate:${event.threadId}`];
        threads = addComment(threads, event.threadId, {
          id: event.requestId,
          threadId: event.threadId,
          authorId: event.authorId,
          body: event.body,
          createdAt: timestamp(),
          mentions: event.mentions,
        }).threads;
      }}
      oncommentupdate={(event) => {
        events = [...events, `oncommentupdate:${event.threadId}`];
        threads = updateCommentReducer(threads, event.threadId, event.commentId, {
          body: event.body,
          editedAt: timestamp(),
        }).threads;
      }}
      oncommentdelete={(event) => {
        events = [...events, `oncommentdelete:${event.threadId}:soft=${event.soft}`];
        threads = deleteCommentReducer(threads, event.threadId, event.commentId, {
          soft: event.soft,
        }).threads;
      }}
    />
  </div>
</section>

<section aria-labelledby="readonly-heading">
  <h2 id="readonly-heading">Readonly</h2>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
    <button data-testid="ro-create-thread" onclick={createAnchoredThreadReadonly}
      >createThread</button
    >
    <button
      data-testid="ro-create-document-thread"
      onclick={() =>
        recordRefused(
          'createDocumentThread(readonly)',
          readonlyEditor?.createDocumentThread('Nope', AUTHOR) ?? null,
        )}>createDocumentThread</button
    >
    <button
      data-testid="ro-create-block-thread"
      onclick={() =>
        recordRefused(
          'createBlockThread(readonly)',
          readonlyEditor?.createBlockThread('Nope', AUTHOR) ?? null,
        )}>createBlockThread</button
    >
    <button
      data-testid="ro-create-comment"
      onclick={() =>
        recordRefused(
          'createComment(readonly)',
          readonlyEditor?.createComment(firstThreadId(readonlyThreads), 'Nope', AUTHOR) ?? null,
        )}>createComment</button
    >
    <button
      data-testid="ro-update-comment"
      onclick={() => {
        readonlyEditor?.updateComment(
          firstThreadId(readonlyThreads),
          firstCommentId(readonlyThreads),
          'Nope',
        );
        recordRefused('updateComment(readonly)');
      }}>updateComment</button
    >
    <button
      data-testid="ro-delete-comment"
      onclick={() => {
        readonlyEditor?.deleteComment(
          firstThreadId(readonlyThreads),
          firstCommentId(readonlyThreads),
        );
        recordRefused('deleteComment(readonly)');
      }}>deleteComment</button
    >
    <button
      data-testid="ro-delete-thread"
      onclick={() => {
        readonlyEditor?.deleteThread(firstThreadId(readonlyThreads));
        recordRefused('deleteThread(readonly)');
      }}>deleteThread</button
    >
    <button
      data-testid="ro-clear-all-threads"
      onclick={() => {
        readonlyEditor?.clearAllThreads();
        recordRefused('clearAllThreads(readonly)');
      }}>clearAllThreads</button
    >
    <button
      data-testid="ro-set-markdown"
      onclick={() => {
        readonlyEditor?.setMarkdown('# Replaced through a readonly editor');
        record('setMarkdown(readonly)', 'completed', undefined);
      }}>setMarkdown</button
    >
    <button data-testid="ro-reset" onclick={resetReadonly}>reset</button>
  </div>

  <ReviewEditor
    bind:this={readonlyEditor}
    id="imperative-readonly"
    name="imperative-readonly"
    mode="readonly"
    bind:value={readonlyValue}
    bind:threads={readonlyThreads}
    currentUserId={AUTHOR}
    onthreadcreate={(event) => {
      readonlyEvents = [...readonlyEvents, `onthreadcreate:${event.requestId}`];
    }}
    onthreaddelete={(event) => {
      readonlyEvents = [...readonlyEvents, `onthreaddelete:${event.threadId}`];
      readonlyThreads = deleteThreadReducer(readonlyThreads, event.threadId).threads;
    }}
    oncommentcreate={(event) => {
      readonlyEvents = [...readonlyEvents, `oncommentcreate:${event.threadId}`];
      readonlyThreads = addComment(readonlyThreads, event.threadId, {
        id: event.requestId,
        threadId: event.threadId,
        authorId: event.authorId,
        body: event.body,
        createdAt: timestamp(),
      }).threads;
    }}
    oncommentupdate={(event) => {
      readonlyEvents = [...readonlyEvents, `oncommentupdate:${event.threadId}`];
      readonlyThreads = updateCommentReducer(readonlyThreads, event.threadId, event.commentId, {
        body: event.body,
        editedAt: timestamp(),
      }).threads;
    }}
    oncommentdelete={(event) => {
      readonlyEvents = [...readonlyEvents, `oncommentdelete:${event.threadId}`];
      readonlyThreads = deleteCommentReducer(readonlyThreads, event.threadId, event.commentId, {
        soft: event.soft,
      }).threads;
    }}
  />
</section>

<LiveAnnouncement {announcement} />

<MutationReadouts
  threadCount={threads.length}
  {lastCall}
  {lastReturn}
  {anchorsJson}
  {probeJson}
  {selectionJson}
  {selectionAtCall}
  {events}
  readonlyThreadCount={readonlyThreads.length}
  {readonlyAnchorsJson}
  {readonlyEvents}
  readonlyCommentBodies={readonlyThreads
    .flatMap((thread) => thread.comments.map((comment) => comment.body))
    .join('|')}
  commentBodies={threads
    .flatMap((thread) => thread.comments.map((comment) => comment.body))
    .join('|')}
  readonlyValueLength={readonlyValue.length}
  valueLength={value.length}
/>
