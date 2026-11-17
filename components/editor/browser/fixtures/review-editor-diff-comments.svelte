<script lang="ts">
  /**
   * COR-512 / DR-7 browser fixture: `ReviewEditor`'s opt-in diff-review integration, mounted
   * through the real published component and state module -- no copied controller. Exercises
   * the scenario `DiffViewer` cannot exercise under the `bun:test` happy-dom harness (see
   * `review-editor-diff-comments.test.ts`'s file header): creating a comment in the diff tab,
   * switching tabs, and confirming it survives.
   */
  import { ReviewEditor, createDiffReviewState } from '@lostgradient/editor';
  import type { DiffReviewState, Thread } from '@lostgradient/editor';

  // `original` has a bullet ("Ship the beta program") that `initialValue` drops entirely and no
  // corresponding line replaces -- a genuine, isolated OLD-side deletion, not merely the old side
  // of an unchanged/context row (which is also selectable, per the contract's "unchanged text
  // rows are also commentable," but proves a different thing). It sits non-adjacent to the one
  // line `initialValue` adds ("Ship CSV export"), so the line-diff reports them as an isolated
  // `removed` row and an isolated `added` row, never a paired `modified` row.
  const original = `# Release notes

- Ship login
- Ship the beta program
- Ship dashboard
`;

  const initialValue = `# Release notes

- Ship login
- Ship dashboard
- Ship CSV export
`;
  let value = $state(initialValue);

  const created = createDiffReviewState([
    {
      targetId: 'release-notes',
      kind: 'markdown',
      label: 'Document diff',
      original,
      current: initialValue,
      normalizeInputs: true,
    },
  ]);
  if (!created.ok) throw new Error('Fixture setup failed: invalid diff-review target.');
  let diffReviewState = $state<DiffReviewState>(created.value);

  // Host-controlled readonly toggle, purely for the Playwright spec that proves a pending draft
  // opened from the "Unsaved drafts" inventory while read-only renders a disabled composer with
  // an explanatory note (COR-512 / DR-7 review follow-up) -- `mode='readonly'` cannot be reached
  // any other way from a real user gesture once a draft already exists.
  let readonly = $state(false);

  let threads = $state<Thread[]>([
    {
      id: 'thread-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      anchor: {
        type: 'text',
        quote: 'Ship login',
        prefix: '',
        suffix: '\n- Ship dashboard',
        status: 'anchored',
        // The quote's ProseMirror range, so the first sync decorates it. A 0/0
        // seed waits for the plugin's 300 ms deferred re-anchor, and a small
        // screenshot can settle before it lands (COR-1536).
        from: 18,
        to: 28,
      },
      comments: [
        {
          id: 'thread-comment-1',
          threadId: 'thread-1',
          authorId: 'reviewer',
          body: 'Confirm the login flow covers SSO too.',
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    },
  ]);
</script>

<div id="example-mount-diff-comments" style="min-height: 34rem;">
  <button type="button" id="toggle-readonly" onclick={() => (readonly = !readonly)}>
    {readonly ? 'Enable editing' : 'Make read-only'}
  </button>
  <ReviewEditor
    id="review-editor-diff-comments"
    mode={readonly ? 'readonly' : 'edit'}
    {original}
    bind:value
    bind:threads
    currentUserId="steve"
    {diffReviewState}
    onDiffReviewStateChange={(next) => (diffReviewState = next)}
  />
</div>
