import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import { historyEntry } from '../../lib/workflow-world.test-support.ts';
import { changeWords, historyRows, runsWords } from './workflow-history.ts';

const ZONE = 'America/Chicago';

describe('COR-2431: what changed from the version before', () => {
  test('changes that share a verb read as one clause: "changed step 2’s input and the workflow input" (row 62o)', () => {
    expect(
      changeWords(
        historyEntry({
          previousVersion: '1.0.0',
          changes: [
            { kind: 'step-input', step: 2, breaking: true },
            { kind: 'input-schema', breaking: true },
          ],
        }),
      ),
    ).toBe('changed step 2’s input and the workflow input');
  });

  test('a step added is named by its title, and the first version was created', () => {
    expect(
      changeWords(
        historyEntry({
          previousVersion: '1.1.0',
          steps: [{ kind: 'sleep' }, { kind: 'await-signal', title: 'Wait for approval' }],
          changes: [{ kind: 'step-added', step: 2, breaking: false }],
        }),
      ),
    ).toBe('added step 2 (Wait for approval)');
    expect(changeWords(historyEntry({ previousVersion: null }))).toBe(
      WORKFLOW_COPY.history.changes.created,
    );
  });
});

describe('COR-2431: what a version meant for the runs', () => {
  test('a version that ran says how many runs it had and the day of the last (row 62p)', () => {
    expect(
      runsWords(
        historyEntry({
          current: false,
          runs: {
            count: 1,
            firstRunAt: '2026-10-30T16:00:00.000Z',
            lastRunAt: '2026-10-30T16:00:00.000Z',
          },
        }),
        ZONE,
      ),
    ).toBe('run on this version: 1 (Fri, Oct 30)');
  });

  test('a breaking version says the runs going finished on the version before', () => {
    expect(
      runsWords(
        historyEntry({ current: false, previousVersion: '1.0.0', compatibility: 'breaking' }),
        ZONE,
      ),
    ).toBe(WORKFLOW_COPY.history.finishedOn('1.0.0'));
  });
});

describe('COR-2431: the History tab’s rows', () => {
  test('name the version, its verdict and the day it was saved, never the engine’s hash', () => {
    const [row] = historyRows(
      [
        historyEntry({
          version: '1.3.0',
          workflowVersion: 'sha256:0123456789abcdef',
          savedAt: '2026-11-01T22:30:00.000Z',
          origin: 'write',
          surface: 'web',
          previousVersion: '1.2.0',
          changes: [{ kind: 'step-reworded', step: 2, breaking: false }],
          compatibility: 'compatible',
        }),
      ],
      ZONE,
    );
    expect(row).toEqual({
      version: '1.3.0',
      title: 'Version 1.3.0, current version',
      verdict: 'Compatible',
      line: `Edited in the builder: reworded step 2, ${WORKFLOW_COPY.history.inFlightKeepGoing}`,
      savedAt: 'Sun, Nov 1, 4:30 PM',
      savedAtIso: '2026-11-01T22:30:00.000Z',
    });
  });
});
