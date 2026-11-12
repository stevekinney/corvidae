/**
 * The edit page's compatibility notice, as board PageWorkflowBuilder ("Edit workflow") says it: the
 * version saving makes, one line for a compatible change, and for a breaking one what changed, what
 * happens to the runs in flight, that later runs use the new version, and that renaming a step is
 * never breaking (row 65t).
 */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import type { WorkflowImpact } from '../../lib/workflow-files.ts';
import { describeBreakingChange, impactNotice } from './workflow-impact.ts';

const copy = WORKFLOW_COPY.editor.impact;

const impact = (overrides: Partial<WorkflowImpact> = {}): WorkflowImpact => ({
  version: '1.4.0',
  previousVersion: '1.3.0',
  changes: [],
  compatibility: 'compatible',
  inFlight: 0,
  ...overrides,
});

describe('the compatibility notice', () => {
  test('says a breaking signal change, that nothing running is affected, and what later runs use (row 65t)', () => {
    const notice = impactNotice(
      impact({
        compatibility: 'breaking',
        changes: [
          { kind: 'step-renamed', step: 2, from: null, to: 'Collect', breaking: false },
          {
            kind: 'step-signal',
            step: 4,
            from: 'notes-approved',
            to: 'release-approved',
            breaking: true,
          },
        ],
      }),
    );
    expect(notice).toEqual({
      tone: 'warning',
      version: '1.4.0',
      lead: 'Saving makes version 1.4.0. This is a breaking change.',
      details: [
        'Step 4 now waits for release-approved instead of notes-approved.',
        'No runs are in flight, so nothing running is affected.',
        'Later runs use 1.4.0.',
        'Renaming a step (its Step name) is never breaking.',
      ],
    });
  });

  test('says a compatible change in one line', () => {
    expect(impactNotice(impact())).toEqual({
      tone: 'info',
      version: '1.4.0',
      lead: copy.compatible('1.4.0'),
      details: [],
    });
  });

  test('names only the version for a workflow that has none before it', () => {
    expect(impactNotice(impact({ previousVersion: null, compatibility: null }))?.lead).toBe(
      'Saving makes version 1.4.0.',
    );
  });

  test('has no notice for a draft that makes no new version', () => {
    expect(impactNotice(impact({ version: null, compatibility: null }))).toBeUndefined();
  });

  test('says what happens to runs in flight, and when they cannot be counted', () => {
    const breaking = { compatibility: 'breaking' as const };
    expect(impactNotice(impact({ ...breaking, inFlight: 2 }))?.details).toContain(
      '2 runs are in flight on version 1.3.0, and this change can stop them from finishing.',
    );
    expect(impactNotice(impact({ ...breaking, inFlight: 1 }))?.details).toContain(
      '1 run is in flight on version 1.3.0, and this change can stop it from finishing.',
    );
    expect(impactNotice(impact({ ...breaking, inFlight: null }))?.details).toContain(
      copy.unknownInFlight,
    );
  });

  test('says each kind of breaking change', () => {
    expect(describeBreakingChange({ kind: 'step-removed', step: 3, breaking: true })).toBe(
      'Step 3 is removed.',
    );
    expect(describeBreakingChange({ kind: 'input-schema', breaking: true })).toBe(
      copy.changes.inputSchema,
    );
    expect(describeBreakingChange({ kind: 'something-new', breaking: true })).toBe(
      copy.changes.other,
    );
  });
});
