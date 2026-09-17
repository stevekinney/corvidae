<script lang="ts">
  import {
    normalizedFormattingOnly,
    rawFormattingOnly,
    formattingOnlySummary,
    locationWithPosition,
    locationWithOffset,
    locationUnknown,
    unparseableTimestamp,
    emptyCommentsExport,
    allSoftDeletedExport,
  } from './review-form-export-fixtures.ts';
  import OrphanedReviewExercise from './orphaned-review-exercise.svelte';
  import {
    buildFormData,
    buildFormDataFromValues,
    exportCommentsMarkdown,
    exportMarkdownSummary,
    exportUnifiedDiff,
    getSummaryContentWithoutHeading,
    ReviewEditor,
    type ReviewState,
    type Thread,
    generateCommentsJSON,
    generateMarkdownSummary,
  } from '@repo/editor';
  const ORIGINAL = `# Release Plan

The first release includes a dashboard and export actions.

## Checklist

- Finalize the component API
- Add playground coverage`;
  let value = $state(`# Release Plan

The first release includes a dashboard, export actions, and inline review.

## Checklist

- Finalize the component API
- Add playground coverage
- Document review export behavior`);
  let threads = $state<Thread[]>([
    {
      id: 'thread-release-plan-title',
      createdAt: '2026-08-11T12:00:00.000Z',
      anchor: {
        from: 1,
        to: 13,
        quote: 'Release Plan',
        prefix: '# ',
        suffix: '\n\nThe first release',
        status: 'anchored',
        originalQuote: 'Release Plan',
        lastKnownOffset: 0,
      },
      comments: [
        {
          id: 'comment-visible',
          threadId: 'thread-release-plan-title',
          authorId: 'maya',
          body: 'Title reads well — keep it.',
          createdAt: '2026-08-11T12:00:00.000Z',
        },
        {
          id: 'comment-soft-deleted',
          threadId: 'thread-release-plan-title',
          authorId: 'dev',
          body: 'Retracted: ignore this one.',
          createdAt: '2026-08-11T12:05:00.000Z',
          deletedAt: '2026-08-11T12:06:00.000Z',
        },
      ],
    },
  ]);
  type FormReadout = {
    keys: string[];
    values: Record<string, string>;
  };
  const emptyReadout: FormReadout = { keys: [], values: {} };
  function readForm(form: HTMLFormElement): FormReadout {
    const entries = [...new FormData(form).entries()];
    return {
      keys: entries.map(([key]) => key),
      values: Object.fromEntries(
        entries.map(([key, entry]) => {
          return [key, String(entry)];
        }),
      ),
    };
  }
  let namedSubmit = $state<FormReadout>(emptyReadout);
  let namedSubmitCount = $state(0);
  let unnamedSubmit = $state<FormReadout>(emptyReadout);
  let unnamedSubmitCount = $state(0);
  let bareSubmit = $state<FormReadout>(emptyReadout);
  let bareSubmitCount = $state(0);
  let editor = $state<ReturnType<typeof ReviewEditor> | undefined>(undefined);
  const instanceKeys = $derived(
    Object.keys((editor ?? {}) as Record<string, unknown>)
      .toSorted()
      .join(','),
  );
  let imperativeFormData = $state('');
  let imperativeStateKeys = $state('');
  function readImperativeFormData() {
    const data = editor?.getFormData();
    imperativeFormData = data ? JSON.stringify(data, null, 2) : '';
  }
  function readImperativeStateKeys() {
    const state = editor?.getState();
    imperativeStateKeys = state ? Object.keys(state).join(',') : '';
  }
  const liveState = $derived<ReviewState>({
    schemaVersion: 4,
    content: value,
    original: ORIGINAL,
    threads,
    frontMatter: null,
    frontMatterRaw: null,
    updatedAt: '2026-08-11T12:00:00.000Z',
  });
  const fromState = $derived(buildFormData(liveState));
  const fromValues = $derived(buildFormDataFromValues(ORIGINAL, value, threads));
  const liveThreadsJson = $derived(JSON.stringify(threads));
  const moduleDiff = $derived(exportUnifiedDiff(liveState).diff);
  const moduleSummary = $derived(exportMarkdownSummary(liveState).markdown);
  const moduleComments = $derived(exportCommentsMarkdown(liveState));
  const moduleCommentsJson = $derived(generateCommentsJSON(liveState).json);
  const coreSummary = $derived(generateMarkdownSummary(liveState).markdown);
  const summaryWithoutHeading = $derived(getSummaryContentWithoutHeading(liveState));
  let bareValue = $state(`# Notes

Just one paragraph.`);
  const bareLineCount = $derived(bareValue.split('\n').length);
  let unnamedValue = $state(`# Unnamed

This editor omits the \`name\` prop entirely.`);
  const paneStyle = 'min-height: 30rem;';
  const outputStyle =
    'width: 100%; min-height: 6rem; font-family: var(--cinder-font-mono, monospace); font-size: 0.75rem;';
</script>

<div style="max-width: 72rem; margin: 0 auto; padding: 1rem; display: grid; gap: 2rem;">
  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;">Form participation — <code>name="review"</code></h2>

    <form
      id="exports-form"
      onsubmit={(event) => {
        event.preventDefault();
        namedSubmit = readForm(event.currentTarget);
        namedSubmitCount += 1;
      }}
      style="display: grid; gap: 0.75rem;"
    >
      <div data-testid="named-editor" style={paneStyle}>
        <ReviewEditor
          bind:this={editor}
          id="exports-editor"
          original={ORIGINAL}
          bind:value
          bind:threads
          currentUserId="steve"
          name="review"
          placeholder="Start reviewing…"
        />
      </div>
      <div>
        <button type="submit" data-testid="submit-named">Submit review</button>
      </div>
    </form>

    <h3 style="margin: 0; font-size: 0.9rem;">Observed state — submitted FormData</h3>
    <p data-testid="named-submit-count" style="margin: 0;">submits: {namedSubmitCount}</p>
    <p data-testid="named-form-keys" style="margin: 0;">{namedSubmit.keys.join(',')}</p>
    <textarea
      readonly
      aria-label="submitted review-original"
      data-testid="submitted-original"
      style={outputStyle}
      value={namedSubmit.values['review-original'] ?? ''}></textarea>
    <textarea
      readonly
      aria-label="submitted review-current"
      data-testid="submitted-current"
      style={outputStyle}
      value={namedSubmit.values['review-current'] ?? ''}></textarea>
    <textarea
      readonly
      aria-label="submitted review-comments"
      data-testid="submitted-comments"
      style={outputStyle}
      value={namedSubmit.values['review-comments'] ?? ''}></textarea>
    <textarea
      readonly
      aria-label="submitted review-diff"
      data-testid="submitted-diff"
      style={outputStyle}
      value={namedSubmit.values['review-diff'] ?? ''}></textarea>
    <textarea
      readonly
      aria-label="submitted review-summary"
      data-testid="submitted-summary"
      style={outputStyle}
      value={namedSubmit.values['review-summary'] ?? ''}></textarea>

    <h3 style="margin: 0; font-size: 0.9rem;">Observed state — the live bindable props</h3>
    <textarea readonly aria-label="live value" data-testid="live-value" style={outputStyle} {value}
    ></textarea>
    <textarea
      readonly
      aria-label="live threads JSON"
      data-testid="live-threads-json"
      style={outputStyle}
      value={liveThreadsJson}></textarea>
  </section>

  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;">
      The imperative surface behind <code>bind:this</code>
    </h2>
    <p data-testid="instance-keys" style="margin: 0; word-break: break-all;">{instanceKeys}</p>
    <div style="display: flex; gap: 0.5rem;">
      <button type="button" data-testid="read-form-data" onclick={readImperativeFormData}>
        Read getFormData()
      </button>
      <button type="button" data-testid="read-state-keys" onclick={readImperativeStateKeys}>
        Read getState() keys
      </button>
    </div>
    <p data-testid="imperative-state-keys" style="margin: 0;">{imperativeStateKeys}</p>
    <textarea
      readonly
      aria-label="getFormData() result"
      data-testid="imperative-form-data"
      style={outputStyle}
      value={imperativeFormData}></textarea>
  </section>

  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;">The same five values, from the pure module functions</h2>
    <textarea
      readonly
      aria-label="buildFormDataFromValues original"
      data-testid="module-original"
      style={outputStyle}
      value={fromValues.original}></textarea>
    <textarea
      readonly
      aria-label="buildFormDataFromValues current"
      data-testid="module-current"
      style={outputStyle}
      value={fromValues.current}></textarea>
    <textarea
      readonly
      aria-label="buildFormDataFromValues comments"
      data-testid="module-comments-from-values"
      style={outputStyle}
      value={fromValues.comments}></textarea>
    <textarea
      readonly
      aria-label="buildFormData comments"
      data-testid="module-comments-from-state"
      style={outputStyle}
      value={fromState.comments}></textarea>
    <textarea
      readonly
      aria-label="exportUnifiedDiff diff"
      data-testid="module-diff"
      style={outputStyle}
      value={moduleDiff}></textarea>
    <textarea
      readonly
      aria-label="exportMarkdownSummary markdown"
      data-testid="module-summary"
      style={outputStyle}
      value={moduleSummary}></textarea>
    <textarea
      readonly
      aria-label="getSummaryContentWithoutHeading"
      data-testid="module-summary-without-heading"
      style={outputStyle}
      value={summaryWithoutHeading}></textarea>
    <textarea
      readonly
      aria-label="generateMarkdownSummary markdown"
      data-testid="core-summary"
      style={outputStyle}
      value={coreSummary}></textarea>
    <textarea
      readonly
      aria-label="exportCommentsMarkdown"
      data-testid="module-comments-markdown"
      style={outputStyle}
      value={moduleComments}></textarea>
    <textarea
      readonly
      aria-label="generateCommentsJSON"
      data-testid="module-comments-json"
      style={outputStyle}
      value={moduleCommentsJson}></textarea>
  </section>

  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;"><code>normalizeInputs</code>, on and off</h2>
    <p data-testid="normalized-stats" style="margin: 0;">
      additions:{normalizedFormattingOnly.stats.additions} deletions:{normalizedFormattingOnly.stats
        .deletions} hunks:{normalizedFormattingOnly.stats.hunks}
    </p>
    <textarea
      readonly
      aria-label="normalized formatting-only diff"
      data-testid="normalized-diff"
      style={outputStyle}
      value={normalizedFormattingOnly.diff}></textarea>
    <p data-testid="raw-stats" style="margin: 0;">
      additions:{rawFormattingOnly.stats.additions} deletions:{rawFormattingOnly.stats.deletions}
      hunks:{rawFormattingOnly.stats.hunks}
    </p>
    <textarea
      readonly
      aria-label="un-normalized formatting-only diff"
      data-testid="raw-diff"
      style={outputStyle}
      value={rawFormattingOnly.diff}></textarea>
    <p data-testid="formatting-only-summary-stats" style="margin: 0;">
      changeCount:{formattingOnlySummary.stats.changeCount} threadCount:{formattingOnlySummary.stats
        .threadCount}
    </p>
    <textarea
      readonly
      aria-label="formatting-only markdown summary"
      data-testid="formatting-only-summary"
      style={outputStyle}
      value={formattingOnlySummary.markdown}></textarea>
  </section>

  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;"><code>generateCommentsExport</code> fallbacks</h2>
    <textarea
      readonly
      aria-label="location from originalPosition"
      data-testid="location-position"
      style={outputStyle}
      value={locationWithPosition}></textarea>
    <textarea
      readonly
      aria-label="location from lastKnownOffset"
      data-testid="location-offset"
      style={outputStyle}
      value={locationWithOffset}></textarea>
    <textarea
      readonly
      aria-label="location unknown"
      data-testid="location-unknown"
      style={outputStyle}
      value={locationUnknown}></textarea>
    <textarea
      readonly
      aria-label="unparseable createdAt"
      data-testid="unparseable-timestamp"
      style={outputStyle}
      value={unparseableTimestamp}></textarea>
    <textarea
      readonly
      aria-label="empty comments export"
      data-testid="empty-comments-export"
      style={outputStyle}
      value={emptyCommentsExport}></textarea>
    <textarea
      readonly
      aria-label="all soft-deleted comments export"
      data-testid="all-soft-deleted-export"
      style={outputStyle}
      value={allSoftDeletedExport}></textarea>
  </section>

  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;">No <code>name</code> prop at all</h2>
    <form
      id="exports-unnamed-form"
      onsubmit={(event) => {
        event.preventDefault();
        unnamedSubmit = readForm(event.currentTarget);
        unnamedSubmitCount += 1;
      }}
      style="display: grid; gap: 0.75rem;"
    >
      <div data-testid="unnamed-editor" style={paneStyle}>
        <ReviewEditor
          id="exports-unnamed"
          original={ORIGINAL}
          bind:value={unnamedValue}
          currentUserId="steve"
        />
      </div>
      <div>
        <button type="submit" data-testid="submit-unnamed">Submit unnamed</button>
      </div>
    </form>
    <p data-testid="unnamed-submit-count" style="margin: 0;">submits: {unnamedSubmitCount}</p>
    <p data-testid="unnamed-form-keys" style="margin: 0;">{unnamedSubmit.keys.join(',')}</p>
  </section>

  <section style="display: grid; gap: 0.75rem;">
    <h2 style="margin: 0;">
      No <code>original</code>, but <code>name="bare"</code>
    </h2>
    <form
      id="exports-no-original-form"
      onsubmit={(event) => {
        event.preventDefault();
        bareSubmit = readForm(event.currentTarget);
        bareSubmitCount += 1;
      }}
      style="display: grid; gap: 0.75rem;"
    >
      <div data-testid="bare-editor" style={paneStyle}>
        <ReviewEditor
          id="exports-no-original"
          bind:value={bareValue}
          currentUserId="steve"
          name="bare"
        />
      </div>
      <div>
        <button type="submit" data-testid="submit-bare">Submit bare</button>
      </div>
    </form>
    <p data-testid="bare-submit-count" style="margin: 0;">submits: {bareSubmitCount}</p>
    <p data-testid="bare-form-keys" style="margin: 0;">{bareSubmit.keys.join(',')}</p>
    <p data-testid="bare-line-count" style="margin: 0;">lines: {bareLineCount}</p>
    <textarea
      readonly
      aria-label="submitted bare-original"
      data-testid="bare-submitted-original"
      style={outputStyle}
      value={bareSubmit.values['bare-original'] ?? ''}></textarea>
    <textarea
      readonly
      aria-label="submitted bare-diff"
      data-testid="bare-submitted-diff"
      style={outputStyle}
      value={bareSubmit.values['bare-diff'] ?? ''}></textarea>
  </section>

  <OrphanedReviewExercise />
</div>
