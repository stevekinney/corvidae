/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { DiffReviewState, DiffReviewTargetInput } from '../../diff-review-state/index.ts';
import { createDiffReviewState, reduceDiffReviewState } from '../../diff-review-state/index.ts';

setupHappyDom();

const { render, fireEvent } = await import('@testing-library/svelte');
const { default: DiffReview } = await import('./diff-review.svelte');

const twoFileTargets: DiffReviewTargetInput[] = [
  {
    targetId: 't1',
    kind: 'source',
    label: 'Patch',
    patch: `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 keep();
diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,2 +1,2 @@
-const b = 1;
+const b = 2;
 keep();
`,
  },
];

const twoTargetSession: DiffReviewTargetInput[] = [
  {
    targetId: 'readme',
    kind: 'markdown',
    label: 'README.md',
    original: 'a',
    current: 'b',
    normalizeInputs: false,
  },
  {
    targetId: 'patch',
    kind: 'source',
    label: 'Patch',
    patch: `diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,2 +1,2 @@
-const b = 1;
+const b = 2;
 keep();
`,
  },
];

function createdState(targets: DiffReviewTargetInput[]): DiffReviewState {
  const created = createDiffReviewState(targets);
  if (!created.ok) throw new Error('fixture setup failed');
  return created.value;
}

describe('DiffReview component shell: file list and filter', () => {
  test('the path filter narrows the visible file list without changing selection', async () => {
    const state = createdState(twoFileTargets);
    const { container, getByLabelText } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: () => {},
    });
    expect(container.querySelectorAll('.diff-review-file-list-item')).toHaveLength(2);
    await fireEvent.input(getByLabelText('Filter files by path'), { target: { value: 'two' } });
    expect(container.querySelectorAll('.diff-review-file-list-item')).toHaveLength(1);
    expect(container.textContent).toContain('src/two.ts');
  });

  test('selecting a file dispatches select-target and select-file', async () => {
    const state = createdState(twoFileTargets);
    let latest = state;
    const { container } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    });
    const buttons = container.querySelectorAll('.diff-review-file-list-button');
    await fireEvent.click(buttons[1]!);
    expect(latest.selectedFileOccurrence).toBe(1);
  });

  test('selecting a file on a different target applies both transitions atomically', async () => {
    // Regression: selectFile used to dispatch select-target and select-file
    // as two separate calls against the same stale `reviewState`, so the
    // second reducer call never saw the first transition and the target
    // switch was silently dropped.
    const state = createdState(twoTargetSession);
    let latest = state;
    const { container } = render(DiffReview, {
      targets: twoTargetSession,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    });
    expect(state.selectedTargetId).toBe('readme');
    const buttons = container.querySelectorAll('.diff-review-file-list-button');
    await fireEvent.click(buttons[1]!);
    expect(latest.selectedTargetId).toBe('patch');
    expect(latest.selectedFileOccurrence).toBe(0);
  });
});

describe('DiffReview component shell: file comment composer', () => {
  test('Add file comment opens a composer; Save creates a file-anchored comment', async () => {
    const state = createdState(twoFileTargets);
    let latest = state;
    const props = {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    };
    const { getByText, getByLabelText, rerender } = render(DiffReview, props);
    // Add file comment immediately creates a real draft (create-draft) --
    // the composer is a view over `state.drafts`, so the host must feed the
    // updated state back for the textarea to appear, exactly as a real
    // controlled host would.
    await fireEvent.click(getByText('Add file comment'));
    await rerender({ ...props, state: latest });
    await fireEvent.input(getByLabelText('Comment'), {
      target: { value: 'Please check this file.' },
    });
    await rerender({ ...props, state: latest });
    await fireEvent.click(getByText('Save'));
    expect(latest.drafts).toHaveLength(0);
    expect(latest.comments).toHaveLength(1);
    expect(latest.comments[0]?.anchor).toEqual({ kind: 'file', fileOccurrence: 0 });
    expect(latest.comments[0]?.body).toBe('Please check this file.');
  });

  test('Cancel closes the composer without discarding the draft', async () => {
    const state = createdState(twoFileTargets);
    let latest = state;
    const props = {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    };
    const { getByText, getByLabelText, queryByLabelText, rerender } = render(DiffReview, props);
    await fireEvent.click(getByText('Add file comment'));
    await rerender({ ...props, state: latest });
    await fireEvent.input(getByLabelText('Comment'), { target: { value: 'draft text' } });
    await rerender({ ...props, state: latest });
    await fireEvent.click(getByText('Cancel'));
    expect(queryByLabelText('Comment')).toBeNull();
    // Closing the composer is not the same as discarding: the draft (with
    // its typed text) survives, recoverable from the drafts inventory.
    expect(latest.drafts).toHaveLength(1);
    expect(latest.drafts[0]?.body).toBe('draft text');
  });

  test('a partially written comment survives a path-filter change and remount', async () => {
    // Regression: the composer used to hold its text in local component
    // $state, disconnected from `state.drafts` -- filtering the file list or
    // remounting the component (as a real target/mode switch would) lost it.
    const state = createdState(twoFileTargets);
    let latest = state;
    const props = {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    };
    const { getByText, getByLabelText, rerender, unmount } = render(DiffReview, props);
    await fireEvent.click(getByText('Add file comment'));
    await rerender({ ...props, state: latest });
    await fireEvent.input(getByLabelText('Comment'), { target: { value: 'not done yet' } });
    await rerender({ ...props, state: latest });

    // Filtering the file list does not touch the draft.
    await fireEvent.input(getByLabelText('Filter files by path'), { target: { value: 'two' } });
    expect(latest.drafts).toHaveLength(1);
    expect(latest.drafts[0]?.body).toBe('not done yet');

    // A fresh mount (simulating remount/target-list update) does not reopen
    // the composer panel -- which draft is "active" in the composer is UI
    // ephemera, not part of `DiffReviewState` -- but the draft's own text is
    // real persisted state and survives, discoverable from the drafts
    // inventory the blocked export gate links to.
    unmount();
    const remounted = render(DiffReview, { ...props, state: latest });
    expect(remounted.queryByLabelText('Comment')).toBeNull();
    await fireEvent.click(remounted.getByText('Review drafts'));
    expect(remounted.getByText('not done yet')).not.toBeNull();
  });

  test('readonly hides the file-comment composer entry point', () => {
    const state = createdState(twoFileTargets);
    const { queryByText } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: () => {},
      readonly: true,
    });
    expect(queryByText('Add file comment')).toBeNull();
  });
});

describe('DiffReview component shell: export gating', () => {
  test('a nonempty draft blocks Copy/Download and shows the pending count', () => {
    const state = createdState(twoFileTargets);
    const withDraft = reduceDiffReviewState(state, {
      type: 'create-draft',
      targetId: 't1',
      anchor: { kind: 'file', fileOccurrence: 0 },
      body: 'still writing this',
    });
    if (!withDraft.ok) throw new Error('fixture setup failed');

    const { queryByText, getByText } = render(DiffReview, {
      targets: twoFileTargets,
      state: withDraft.value,
      onStateChange: () => {},
    });
    expect(queryByText('Copy review')).toBeNull();
    expect(getByText(/1 unsaved draft must be saved or discarded before export\./)).not.toBeNull();
  });

  test('with no pending drafts, export controls are available', () => {
    const state = createdState(twoFileTargets);
    const { getByText, queryByText } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: () => {},
    });
    expect(getByText('Copy review')).not.toBeNull();
    expect(queryByText(/unsaved draft/)).toBeNull();
  });

  test('typing in the file-comment composer (not just a reducer-seeded draft) blocks export', async () => {
    // Regression: the composer used to bypass diff-review-state entirely
    // (create-comment on Save, no draft in between), so typed-but-unsaved
    // text never appeared in `state.drafts` and never blocked export.
    const state = createdState(twoFileTargets);
    let latest = state;
    const props = {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    };
    const { getByText, getByLabelText, rerender, queryByText } = render(DiffReview, props);
    expect(getByText('Copy review')).not.toBeNull();

    await fireEvent.click(getByText('Add file comment'));
    await rerender({ ...props, state: latest });
    await fireEvent.input(getByLabelText('Comment'), { target: { value: 'in progress' } });
    await rerender({ ...props, state: latest });

    expect(queryByText('Copy review')).toBeNull();
    expect(getByText(/1 unsaved draft must be saved or discarded before export\./)).not.toBeNull();
  });
});

describe('DiffReview component shell: export scope', () => {
  test('Download Markdown includes a resolved comment and a comment on a path-filtered-out file (COR-509 / DR-6)', async () => {
    // Contract: "Copy-all includes comments from hidden files and
    // resolved/outdated groups ... regardless of navigation or filters."
    // `getExportContent` must pass the FULL review state to the exporter,
    // never the path-filtered `visibleFileEntries` view -- this exercises
    // that through the real toolbar UI, not just the pure exporter (which
    // COR-513 already covers in isolation).
    const created = createdState(twoFileTargets);
    const withResolved = reduceDiffReviewState(created, {
      type: 'create-comment',
      id: 'c-visible',
      targetId: 't1',
      anchor: { kind: 'file', fileOccurrence: 0 },
      body: 'On the visible file.',
    });
    if (!withResolved.ok) throw new Error('fixture setup failed');
    const resolved = reduceDiffReviewState(withResolved.value, {
      type: 'resolve-comment',
      id: 'c-visible',
    });
    if (!resolved.ok) throw new Error('fixture setup failed');
    const withHidden = reduceDiffReviewState(resolved.value, {
      type: 'create-comment',
      id: 'c-hidden',
      targetId: 't1',
      anchor: { kind: 'file', fileOccurrence: 1 },
      body: 'On the file the filter hides.',
    });
    if (!withHidden.ok) throw new Error('fixture setup failed');

    const { container, getByLabelText, getByText } = render(DiffReview, {
      targets: twoFileTargets,
      state: withHidden.value,
      onStateChange: () => {},
    });

    // Narrow the file *navigation list* to `src/one.ts` only -- the filter
    // only scopes the nav panel (the diff surface below still renders the
    // whole patch); `src/two.ts`'s comment must still make it into export.
    await fireEvent.input(getByLabelText('Filter files by path'), {
      target: { value: 'one' },
    });
    const nav = container.querySelector('.diff-review-files');
    if (!nav) throw new Error('file navigation not found');
    expect(nav.querySelectorAll('.diff-review-file-list-item')).toHaveLength(1);
    expect(nav.textContent).not.toContain('src/two.ts');

    let capturedBlob: Blob | undefined;
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:diff-review-test';
    }) as typeof URL.createObjectURL;
    try {
      await fireEvent.click(getByText('Download Markdown'));
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }

    if (!capturedBlob) throw new Error('Download Markdown did not build a Blob.');
    const content = await capturedBlob.text();
    expect(content).toContain('On the visible file.');
    expect(content).toContain('resolved');
    expect(content).toContain('On the file the filter hides.');
  });
});

describe('DiffReview component shell: reviewed markers', () => {
  test('checking Reviewed dispatches set-reviewed for exactly that target/file', async () => {
    const state = createdState(twoFileTargets);
    let latest = state;
    const { getAllByLabelText } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    });
    const checkboxes = getAllByLabelText('Reviewed') as HTMLInputElement[];
    await fireEvent.click(checkboxes[1]!);
    expect(latest.reviewedMarkers).toContainEqual(
      expect.objectContaining({ targetId: 't1', fileOccurrence: 1 }),
    );
    expect(latest.reviewedMarkers).toHaveLength(1);
  });
});
