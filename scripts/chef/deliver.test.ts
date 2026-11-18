import { describe, expect, test } from 'bun:test';

import { renderDeliver } from './deliver.ts';

describe('delivery report validation', () => {
  test('renders a branch refusal with its verification detail', () => {
    expect(
      renderDeliver({
        pr: null,
        branch: 'cor-1',
        merged: false,
        mergeCommit: null,
        mergeable: null,
        mainHealthWarning: null,
        guardsAlreadyFailing: [],
        failedStep: 'verification',
        detail: 'AC1:verify is pending',
        issues: [],
        acceptedReverts: [],
        leftOpen: [],
        worktree: null,
        swept: null,
        ledgerWarning: null,
      }),
    ).toContain('FAILED at verification: AC1:verify is pending');
  });
});
