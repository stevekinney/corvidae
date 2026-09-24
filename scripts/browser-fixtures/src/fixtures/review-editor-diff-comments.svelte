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

  const original = `# Release notes

- Ship login
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
        from: 0,
        to: 0,
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
  <ReviewEditor
    id="review-editor-diff-comments"
    {original}
    bind:value
    bind:threads
    currentUserId="steve"
    {diffReviewState}
    onDiffReviewStateChange={(next) => (diffReviewState = next)}
  />
</div>
