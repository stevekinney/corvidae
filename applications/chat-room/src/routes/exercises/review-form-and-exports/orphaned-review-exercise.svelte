<script lang="ts">
  import {
    ReviewEditor,
    generateMarkdownSummary,
    type ReviewState,
    type Thread,
  } from '@repo/editor';
  const ORPHAN_DOCUMENT = `# Beta Notes

The beta rollout ships to ten teams.

Everything else is unchanged.`;
  let orphanValue = $state(ORPHAN_DOCUMENT);
  let orphanThreads = $state<Thread[]>([
    {
      id: 'thread-rollout',
      createdAt: '2026-08-11T12:00:00.000Z',
      anchor: {
        type: 'text',
        from: 17,
        to: 29,
        quote: 'beta rollout',
        prefix: 'The ',
        suffix: ' ships to ten teams.',
        status: 'anchored',
        originalQuote: 'beta rollout',
        lastKnownOffset: 15,
      },
      comments: [
        {
          id: 'comment-rollout',
          threadId: 'thread-rollout',
          authorId: 'maya',
          body: 'Which teams, exactly?',
          createdAt: '2026-08-11T12:00:00.000Z',
        },
      ],
    },
    {
      id: 'thread-heading',
      createdAt: '2026-08-11T12:01:00.000Z',
      anchor: {
        type: 'text',
        from: 1,
        to: 11,
        quote: 'Beta Notes',
        prefix: '# ',
        suffix: '\n\nThe beta rollout',
        status: 'anchored',
        originalQuote: 'Beta Notes',
        lastKnownOffset: 0,
      },
      comments: [
        {
          id: 'comment-heading',
          threadId: 'thread-heading',
          authorId: 'steve',
          body: 'Heading reads fine.',
          createdAt: '2026-08-11T12:01:00.000Z',
        },
      ],
    },
    {
      id: 'thread-whole-document',
      createdAt: '2026-08-11T12:02:00.000Z',
      anchor: {
        type: 'document',
        from: 0,
        to: 0,
        quote: '',
        prefix: '',
        suffix: '',
        status: 'anchored',
      },
      comments: [
        {
          id: 'comment-whole-document',
          threadId: 'thread-whole-document',
          authorId: 'maya',
          body: 'Overall: ready to ship.',
          createdAt: '2026-08-11T12:02:00.000Z',
        },
      ],
    },
  ]);
  let orphanEditor = $state<ReturnType<typeof ReviewEditor> | undefined>(undefined);
  function deleteAnchoredPhrase() {
    const view = orphanEditor?.getView();
    if (!view) return;
    view.dispatch(view.state.tr.delete(17, 29));
  }
  const orphanStatuses = $derived(
    orphanThreads
      .map((thread) => `${thread.id}:${thread.anchor.status}`)
      .toSorted()
      .join(','),
  );
  const orphanState = $derived<ReviewState>({
    schemaVersion: 4,
    content: orphanValue,
    original: ORPHAN_DOCUMENT,
    threads: orphanThreads,
    frontMatter: null,
    frontMatterRaw: null,
    updatedAt: '2026-08-11T12:00:00.000Z',
  });
  const orphanModuleSummary = $derived(generateMarkdownSummary(orphanState));
  const paneStyle = 'min-height: 30rem;';
  const outputStyle =
    'width: 100%; min-height: 6rem; font-family: var(--cinder-font-mono, monospace); font-size: 0.75rem;';
</script>

<section style="display: grid; gap: 0.75rem;">
  <h2 style="margin: 0;">
    Orphaned, anchored, and document-level threads — <code>name="orphan"</code>
  </h2>
  <p style="margin: 0;">
    No wrapping form: the five hidden inputs render wherever <code>name</code> is set, and reading one
    directly is the same string a submit would carry.
  </p>
  <button type="button" data-testid="orphan-delete" onclick={deleteAnchoredPhrase}>
    Delete the anchored phrase
  </button>
  <div data-testid="orphan-editor" style={paneStyle}>
    <ReviewEditor
      bind:this={orphanEditor}
      id="exports-orphan"
      original={ORPHAN_DOCUMENT}
      bind:value={orphanValue}
      bind:threads={orphanThreads}
      currentUserId="steve"
      name="orphan"
    />
  </div>
  <p data-testid="orphan-thread-statuses" style="margin: 0;">{orphanStatuses}</p>
  <p data-testid="orphan-thread-count" style="margin: 0;">threads: {orphanThreads.length}</p>
  <p data-testid="orphan-module-stats" style="margin: 0;">
    changeCount:{orphanModuleSummary.stats.changeCount} threadCount:{orphanModuleSummary.stats
      .threadCount}
  </p>
  <textarea
    readonly
    aria-label="orphan fixture live value"
    data-testid="orphan-live-value"
    style={outputStyle}
    value={orphanValue}></textarea>
  <textarea
    readonly
    aria-label="orphan fixture module summary"
    data-testid="orphan-module-summary"
    style={outputStyle}
    value={orphanModuleSummary.markdown}></textarea>
</section>
