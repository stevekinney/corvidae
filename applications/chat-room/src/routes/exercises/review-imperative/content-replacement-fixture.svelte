<script lang="ts">
  import {
    ReviewEditor,
    addThread,
    deleteThread as deleteThreadReducer,
    type Thread,
  } from '@repo/editor';
  import { undo, undoDepth } from '@milkdown/kit/prose/history';
  import {
    AUTHOR,
    anchorRows,
    keepingFocus,
    select,
    threadFromCreateEvent,
    type RecordReviewCall,
  } from './imperative-utilities';

  let { record }: { record: RecordReviewCall } = $props();
  const CONTENT_ORIGINAL = '### Content Baseline\n\nThe rollout plan is still being drafted.';
  const CONTENT_HEADING = 'Content Replacement Fixture';
  const CONTENT_PARAGRAPH_ONE = 'The rollout plan names a dashboard owner and a migration owner.';
  const CONTENT_PARAGRAPH_TWO = 'The rollback checklist is owned by the platform team.';
  const CONTENT_INITIAL = `### ${CONTENT_HEADING}\n\n${CONTENT_PARAGRAPH_ONE}\n\n${CONTENT_PARAGRAPH_TWO}`;
  const CONTENT_INSERTED = 'A late addition pushes the rest of the document down.';
  const CONTENT_CLOSING = 'The deployment window is now agreed.';
  const CONTENT_REPLACEMENT = `### ${CONTENT_HEADING}\n\n${CONTENT_INSERTED}\n\n${CONTENT_PARAGRAPH_ONE}\n\n${CONTENT_CLOSING}`;
  const SURVIVING_QUOTE = 'dashboard owner';
  const SURVIVING_FROM = 55;
  const SURVIVING_TO = 70;
  const REMOVED_QUOTE = 'rollback checklist';
  const REMOVED_FROM = 99;
  const REMOVED_TO = 117;
  let contentValue = $state(CONTENT_INITIAL);
  let contentThreads = $state<Thread[]>([]);
  let contentEvents = $state<string[]>([]);
  let contentEditor = $state<ReturnType<typeof ReviewEditor>>();
  const contentAnchorsJson = $derived(JSON.stringify(anchorRows(contentThreads)));
  const contentTally = () =>
    `${contentThreads.length} ${contentThreads.length === 1 ? 'thread' : 'threads'} in the content review`;
  let contentMarkdownJson = $state('null');
  let contentAstJson = $state('[]');
  let contentAstError = $state('');
  let contentUndoDepth = $state(-1);
  let contentUndoProbes = $state(0);
  function nodeText(node: unknown): string {
    if (typeof node !== 'object' || node === null) return '';
    const candidate = node as {
      value?: unknown;
      children?: unknown[];
    };
    if (typeof candidate.value === 'string') return candidate.value;
    if (Array.isArray(candidate.children)) return candidate.children.map(nodeText).join('');
    return '';
  }
  function readContentAst() {
    try {
      const root = contentEditor?.getAst();
      contentAstError = '';
      contentAstJson = JSON.stringify(
        (root?.children ?? []).map((node) => ({
          type: node.type,
          depth: 'depth' in node ? node.depth : null,
          text: nodeText(node),
        })),
      );
    } catch (error) {
      contentAstError = error instanceof Error ? error.message : String(error);
      contentAstJson = '[]';
    }
  }
  function readContentMarkdown() {
    const fromGetMarkdown = contentEditor?.getMarkdown() ?? '';
    contentMarkdownJson = JSON.stringify({
      fromGetMarkdown,
      valueProp: contentValue,
      getMarkdownLength: fromGetMarkdown.length,
      valuePropLength: contentValue.length,
    });
  }
  function readContentUndoDepth() {
    const view = contentEditor?.getView();
    contentUndoDepth = view ? undoDepth(view.state) : -1;
    contentUndoProbes += 1;
  }
  function undoContent() {
    const view = contentEditor?.getView();
    if (!view) return;
    undo(view.state, (transaction) => view.dispatch(transaction));
  }
  async function seedContentThreads() {
    await select(contentEditor, SURVIVING_FROM, SURVIVING_TO);
    const survivor =
      contentEditor?.createThread(
        `Anchored to "${SURVIVING_QUOTE}", which the replacement keeps.`,
        AUTHOR,
      ) ?? null;
    await select(contentEditor, REMOVED_FROM, REMOVED_TO);
    const doomed =
      contentEditor?.createThread(
        `Anchored to "${REMOVED_QUOTE}", which the replacement drops.`,
        AUTHOR,
      ) ?? null;
    record(
      'createThread(content) twice',
      survivor && doomed ? 'created' : 'refused',
      `${survivor ?? 'null'},${doomed ?? 'null'}`,
      {
        reason: 'no text is currently selected',
        noun: 'two threads',
        tally: contentTally(),
      },
    );
  }
  function setContentMarkdown() {
    const before = contentValue;
    contentEditor?.setMarkdown(CONTENT_REPLACEMENT);
    record('setMarkdown(content)', contentValue === before ? 'refused' : 'completed', undefined, {
      reason: 'the value prop did not move',
      tally: contentTally(),
    });
    readContentMarkdown();
  }
  function resetContent() {
    const beforeValue = contentValue;
    const beforeEvents = contentEvents.length;
    contentEditor?.reset();
    const released = contentEvents.length - beforeEvents;
    const restored = contentValue !== beforeValue;
    record('reset(content)', restored || released > 0 ? 'completed' : 'refused', undefined, {
      reason: 'the value was already the original and no thread was released',
      tally: `${contentTally()}, ${released} released by this reset`,
    });
    readContentMarkdown();
  }
  export function getEditorHandle() {
    return contentEditor;
  }
</script>

<section aria-labelledby="content-heading">
  <h2 id="content-heading">Content replacement and reset</h2>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
    <button data-testid="content-seed" onclick={() => keepingFocus(seedContentThreads)}
      >seed two threads</button
    >
    <button data-testid="content-set-markdown" onclick={setContentMarkdown}>setMarkdown</button>
    <button data-testid="content-reset" onclick={resetContent}>reset</button>
    <button data-testid="content-get-markdown" onclick={readContentMarkdown}>getMarkdown</button>
    <button data-testid="content-get-ast" onclick={readContentAst}>getAst</button>
    <button data-testid="content-probe-undo" onclick={readContentUndoDepth}>probe undo depth</button
    >
    <button data-testid="content-undo" onclick={undoContent}>undo</button>
  </div>

  <ReviewEditor
    bind:this={contentEditor}
    id="imperative-content"
    original={CONTENT_ORIGINAL}
    bind:value={contentValue}
    bind:threads={contentThreads}
    currentUserId={AUTHOR}
    onthreadcreate={(event) => {
      contentEvents = [...contentEvents, `onthreadcreate:${event.requestId}`];
      contentThreads = addThread(contentThreads, threadFromCreateEvent(event)).threads;
    }}
    onthreaddelete={(event) => {
      contentEvents = [...contentEvents, `onthreaddelete:${event.threadId}`];
      contentThreads = deleteThreadReducer(contentThreads, event.threadId).threads;
    }}
  />
</section>
<p data-testid="content-thread-count" style="margin: 0;">
  content threads: {contentThreads.length}
</p>
<p data-testid="content-anchors-json" style="margin: 0; word-break: break-all;">
  {contentAnchorsJson}
</p>
<p data-testid="content-events" style="margin: 0; word-break: break-all;">
  {contentEvents.join('|')}
</p>
<p data-testid="content-markdown-json" style="margin: 0; word-break: break-all;">
  {contentMarkdownJson}
</p>
<p data-testid="content-ast-json" style="margin: 0; word-break: break-all;">{contentAstJson}</p>
<p data-testid="content-ast-error" style="margin: 0; word-break: break-all;">
  {contentAstError}
</p>
<p data-testid="content-undo-json" style="margin: 0;">
  {JSON.stringify({ probe: contentUndoProbes, depth: contentUndoDepth })}
</p>
