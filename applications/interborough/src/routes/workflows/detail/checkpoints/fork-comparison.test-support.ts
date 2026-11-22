/**
 * Test doubles for the two Weft operations the comparison and the fork dialog read (COR-2538):
 * `weft.workflows.compare` and `weft.workflows.fork` with `dryRun: true`. The defaults answer an
 * empty comparison and a preview that keeps one step and runs one again, so a test that is about
 * something else renders the dialog and the comparison without writing its own answers.
 */
import { fireEvent, waitFor } from '@testing-library/svelte';
import { expect } from 'bun:test';

import type { ForkComparisonClient, ForkPreviewClient } from './fork-comparison-data.ts';

/**
 * Waits for the fork dialog's preview to answer, which is what enables Create fork, then clicks it.
 * A test that confirms before the preview has landed would be confirming what the dialog refuses.
 */
export async function confirmFork(
  getByRole: (role: 'button', options: { name: string }) => HTMLElement,
): Promise<void> {
  await waitFor(() =>
    expect(getByRole('button', { name: 'Create fork' }).hasAttribute('disabled')).toBe(false),
  );
  await fireEvent.click(getByRole('button', { name: 'Create fork' }));
}

type CompareOperation = ForkComparisonClient['operations']['weft.workflows.compare'];
type ForkOperation = ForkPreviewClient['operations']['weft.workflows.fork'];
type ForkPreviewAnswer = Extract<Awaited<ReturnType<ForkOperation>>, { readonly dryRun: true }>;

/** What a test may override of the two operations; the rest answer the defaults. */
export type ForkOperationOverrides = {
  readonly compare?: CompareOperation;
  readonly fork?: ForkOperation;
};

/** A preview of a fork from `fromStep` that keeps one step and runs one again. */
export function previewAnswer(overrides: Partial<ForkPreviewAnswer> = {}): ForkPreviewAnswer {
  return {
    dryRun: true,
    workflowId: 'wf-1',
    forkPoint: 2,
    keptSteps: [
      { index: 0, operationType: 'activity', label: 'reserveStock', status: 'completed' },
    ],
    rerunSteps: [
      { index: 1, operationType: 'activity', label: 'issueTicket', status: 'completed' },
    ],
    revisionWouldChange: false,
    ...overrides,
  };
}

/** The two operations as a client's `operations` carries them, over `overrides`. */
export function forkOperations(overrides: ForkOperationOverrides = {}): {
  readonly 'weft.workflows.compare': CompareOperation;
  readonly 'weft.workflows.fork': ForkOperation;
} {
  return {
    'weft.workflows.compare':
      overrides.compare ??
      (async (input) => ({
        workflowId: input.workflowId,
        sourceWorkflowId: 'wf-1',
        forkPoint: 2,
        steps: [],
      })),
    'weft.workflows.fork': overrides.fork ?? (async () => previewAnswer()),
  };
}
