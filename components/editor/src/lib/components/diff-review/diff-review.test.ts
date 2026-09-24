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
});

describe('DiffReview component shell: file comment composer', () => {
  test('Add file comment opens a composer; Save creates a file-anchored comment', async () => {
    const state = createdState(twoFileTargets);
    let latest = state;
    const { getByText, getByLabelText } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: (next: DiffReviewState) => {
        latest = next;
      },
    });
    await fireEvent.click(getByText('Add file comment'));
    await fireEvent.input(getByLabelText('Comment'), {
      target: { value: 'Please check this file.' },
    });
    await fireEvent.click(getByText('Save'));
    expect(latest.comments).toHaveLength(1);
    expect(latest.comments[0]?.anchor).toEqual({ kind: 'file', fileOccurrence: 0 });
    expect(latest.comments[0]?.body).toBe('Please check this file.');
  });

  test('Cancel discards the composer without dispatching any action', async () => {
    const state = createdState(twoFileTargets);
    let called = false;
    const { getByText, getByLabelText, queryByLabelText } = render(DiffReview, {
      targets: twoFileTargets,
      state,
      onStateChange: () => {
        called = true;
      },
    });
    await fireEvent.click(getByText('Add file comment'));
    await fireEvent.input(getByLabelText('Comment'), { target: { value: 'draft text' } });
    await fireEvent.click(getByText('Cancel'));
    expect(called).toBe(false);
    expect(queryByLabelText('Comment')).toBeNull();
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
