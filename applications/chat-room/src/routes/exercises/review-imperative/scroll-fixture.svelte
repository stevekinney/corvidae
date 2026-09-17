<script lang="ts">
  import {
    ReviewEditor,
    addThread,
    deleteThread as deleteThreadReducer,
    type Thread,
  } from '@repo/editor';
  import {
    AUTHOR,
    AUTHOR_SEED,
    anchorRows,
    keepingFocus,
    select,
    threadFromCreateEvent,
    type RecordReviewCall,
    type ReviewEditorHandle,
  } from './imperative-utilities';

  let {
    record,
    getOtherEditor,
  }: { record: RecordReviewCall; getOtherEditor: () => ReviewEditorHandle | undefined } = $props();
  const TALL_ID = 'imperative-tall';
  const TALL_HEADING = 'Scroll Target Document';
  const TALL_FILLER_COUNT = 24;
  const tallFiller = (index: number) =>
    `Filler paragraph ${String(index).padStart(2, '0')} keeps the scroll target below the fold.`;
  const TALL_TARGET = 'The migration script is untested and needs a decision.';
  const TALL_INITIAL = [
    `### ${TALL_HEADING}`,
    ...Array.from({ length: TALL_FILLER_COUNT }, (_, index) => tallFiller(index + 1)),
    TALL_TARGET,
  ].join('\n\n');
  const TALL_QUOTE = 'migration script';
  const TALL_FROM = 1493;
  const TALL_TO = 1509;
  const TALL_ORPHAN_ID = 'tall-orphan-1';
  const TALL_ORPHAN_QUOTE = 'a paragraph that was cut from an earlier draft';
  const SEEDED_TALL_ORPHAN: Thread = {
    id: TALL_ORPHAN_ID,
    anchor: {
      from: 0,
      to: 0,
      quote: TALL_ORPHAN_QUOTE,
      prefix: '',
      suffix: '',
      status: 'orphaned',
    } as Thread['anchor'],
    comments: [
      {
        id: 'tall-orphan-comment-1',
        threadId: TALL_ORPHAN_ID,
        authorId: AUTHOR_SEED,
        body: 'Anchored to text that is not in this document.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  let tallValue = $state(TALL_INITIAL);
  let tallThreads = $state<Thread[]>([structuredClone(SEEDED_TALL_ORPHAN)]);
  let tallEvents = $state<string[]>([]);
  let tallEditor = $state<ReturnType<typeof ReviewEditor>>();
  let tallAnchoredId = $state('');
  const tallAnchorsJson = $derived(JSON.stringify(anchorRows(tallThreads)));
  const tallTally = () =>
    `${tallThreads.length} ${tallThreads.length === 1 ? 'thread' : 'threads'} in the scroll review`;
  let scrollJson = $state('null');
  let scrollCalls = $state<string[]>([]);
  let scrollInstrumented = false;
  function instrumentScrollTarget() {
    const dom = tallEditor?.getView()?.dom;
    if (!dom || scrollInstrumented) return;
    scrollInstrumented = true;
    const passThrough = dom.scrollTo.bind(dom) as (...args: unknown[]) => void;
    Object.defineProperty(dom, 'scrollTo', {
      configurable: true,
      value: (...args: unknown[]) => {
        scrollCalls = [...scrollCalls, JSON.stringify(args[0] ?? null)];
        passThrough(...args);
      },
    });
  }
  type ScrollSample = {
    winY: number;
    domTop: number;
    scrollerTop: number;
    anchorTop: number | null;
    viewportHeight: number;
    active: string;
  };
  function activeElementName(active: Element | null): string {
    if (active === document.body) return 'BODY';
    return active?.getAttribute('data-testid') ?? active?.tagName ?? 'null';
  }

  function elementScrollTop(element: Element | null | undefined): number {
    return Math.round(element?.scrollTop ?? -1);
  }

  function anchorTop(anchor: Element | null): number | null {
    return anchor ? Math.round(anchor.getBoundingClientRect().top) : null;
  }

  function sampleScroll(): ScrollSample {
    const dom = tallEditor?.getView()?.dom ?? null;
    const scroller = dom?.closest('.markdown-editor');
    const anchor = document.querySelector(`#${TALL_ID} .ProseMirror span.comment-anchor`);
    return {
      winY: Math.round(window.scrollY),
      domTop: elementScrollTop(dom),
      scrollerTop: elementScrollTop(scroller),
      anchorTop: anchorTop(anchor),
      viewportHeight: window.innerHeight,
      active: activeElementName(document.activeElement),
    };
  }

  function scrollMoved(before: ScrollSample, after: ScrollSample): boolean {
    return (
      after.winY !== before.winY ||
      after.domTop !== before.domTop ||
      after.scrollerTop !== before.scrollerTop
    );
  }

  function runScroll(name: string, threadId: string) {
    instrumentScrollTarget();
    const before = sampleScroll();
    const callsBefore = scrollCalls.length;
    let threw: string | null = null;
    let returned: string;
    try {
      returned = String(tallEditor?.scrollToThread(threadId));
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
      returned = '(threw)';
    }
    const after = sampleScroll();
    const moved = scrollMoved(before, after);
    scrollJson = JSON.stringify({
      threadId,
      before,
      after,
      moved,
      threw,
      returned,
      calls: scrollCalls.length - callsBefore,
      lastCallArgument: scrollCalls.at(-1) ?? null,
    });
    record(name, moved ? 'completed' : 'refused', undefined, {
      reason: 'nothing on this page scrolled',
      tally: tallTally(),
    });
  }
  function scrollAnchorControl() {
    const before = sampleScroll();
    document
      .querySelector(`#${TALL_ID} .ProseMirror span.comment-anchor`)
      ?.scrollIntoView({ behavior: 'instant', block: 'center' });
    const after = sampleScroll();
    scrollJson = JSON.stringify({
      threadId: '(scrollIntoView control)',
      before,
      after,
      moved: scrollMoved(before, after),
      threw: null,
      returned: 'undefined',
      calls: 0,
      lastCallArgument: null,
    });
  }
  let editorIdentityJson = $state('null');
  function actionProbe(editor: ReturnType<ReviewEditorHandle['getEditor']>): {
    actionCtxIsEditorCtx: boolean | null;
    actionThrew: string | null;
  } {
    try {
      return {
        actionCtxIsEditorCtx: editor ? editor.action((ctx) => ctx) === editor.ctx : null,
        actionThrew: null,
      };
    } catch (error) {
      return {
        actionCtxIsEditorCtx: null,
        actionThrew: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function editorStatus(editor: ReturnType<ReviewEditorHandle['getEditor']>): string | null {
    return editor?.status ?? null;
  }

  function sameEditor(
    left: ReturnType<ReviewEditorHandle['getEditor']>,
    right: ReturnType<ReviewEditorHandle['getEditor']>,
  ): boolean {
    return left !== null && left === right;
  }

  function distinctEditors(
    left: ReturnType<ReviewEditorHandle['getEditor']>,
    right: ReturnType<ReviewEditorHandle['getEditor']>,
  ): boolean {
    return left !== null && right !== null && left !== right;
  }

  function viewDocSize(handle: ReviewEditorHandle | undefined): number | null {
    return handle?.getView()?.state.doc.content.size ?? null;
  }

  function readEditorIdentity() {
    const tall = tallEditor?.getEditor() ?? null;
    const otherEditor = getOtherEditor();
    const content = otherEditor?.getEditor() ?? null;
    editorIdentityJson = JSON.stringify({
      present: tall !== null,
      status: editorStatus(tall),
      stableAcrossCalls: sameEditor(tall, tallEditor?.getEditor() ?? null),
      distinctFromOtherInstance: distinctEditors(tall, content),
      ...actionProbe(tall),
      viewDocSize: viewDocSize(tallEditor),
      otherViewDocSize: viewDocSize(otherEditor),
    });
  }

  async function seedTallThread() {
    await select(tallEditor, TALL_FROM, TALL_TO);
    const created =
      tallEditor?.createThread(`The scroll target, anchored to "${TALL_QUOTE}".`, AUTHOR) ?? null;
    tallAnchoredId = created ?? '';
    record('createThread(scroll)', created ? 'created' : 'refused', created, {
      reason: 'no text is currently selected',
      noun: 'the scroll target thread',
      tally: tallTally(),
    });
  }
</script>

<section aria-labelledby="scroll-heading">
  <h2 id="scroll-heading">Scroll and editor handle</h2>
  <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
    <button data-testid="tall-seed" onclick={() => keepingFocus(seedTallThread)}
      >createThread at the foot</button
    >
    <button
      data-testid="scroll-to-thread"
      onclick={() => runScroll('scrollToThread(anchored)', tallAnchoredId)}
      >scrollToThread (anchored)</button
    >
    <button
      data-testid="scroll-to-orphan"
      onclick={() => runScroll('scrollToThread(orphaned)', TALL_ORPHAN_ID)}
      >scrollToThread (orphaned)</button
    >
    <button
      data-testid="scroll-to-unknown"
      onclick={() => runScroll('scrollToThread(unknown id)', 'no-such-thread')}
      >scrollToThread (unknown id)</button
    >
    <button data-testid="scroll-into-view-control" onclick={scrollAnchorControl}
      >scrollIntoView control</button
    >
    <button data-testid="read-editor-identity" onclick={readEditorIdentity}>getEditor</button>
  </div>

  <ReviewEditor
    bind:this={tallEditor}
    id={TALL_ID}
    bind:value={tallValue}
    bind:threads={tallThreads}
    currentUserId={AUTHOR}
    onthreadcreate={(event) => {
      tallEvents = [...tallEvents, `onthreadcreate:${event.requestId}`];
      tallThreads = addThread(tallThreads, threadFromCreateEvent(event)).threads;
    }}
    onthreaddelete={(event) => {
      tallEvents = [...tallEvents, `onthreaddelete:${event.threadId}`];
      tallThreads = deleteThreadReducer(tallThreads, event.threadId).threads;
    }}
  />
</section>
<p data-testid="tall-thread-count" style="margin: 0;">scroll threads: {tallThreads.length}</p>
<p data-testid="tall-anchors-json" style="margin: 0; word-break: break-all;">
  {tallAnchorsJson}
</p>
<p data-testid="tall-events" style="margin: 0; word-break: break-all;">
  {tallEvents.join('|')}
</p>
<p data-testid="scroll-json" style="margin: 0; word-break: break-all;">{scrollJson}</p>
<p data-testid="editor-identity-json" style="margin: 0; word-break: break-all;">
  {editorIdentityJson}
</p>
