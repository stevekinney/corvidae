import { describe, expect, test } from 'bun:test';

import { executionReportHeadings, executionReportProblems, renderDeliver } from './deliver.ts';

describe('delivery report validation', () => {
  test('accepts the required report headings in order', () => {
    const report = [
      'Execution report: cor-1 attempt 1',
      '',
      ...executionReportHeadings.flatMap((heading) => [`## ${heading}`, '', 'Complete.', '']),
    ].join('\n');

    expect(executionReportProblems(report)).toEqual([]);
  });

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
