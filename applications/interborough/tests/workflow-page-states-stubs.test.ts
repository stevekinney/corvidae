/**
 * The unit-lane guard for `tests/e2e/workflow-page-states.spec.ts` (COR-2431), which runs in a
 * browser outside `check`: every answer it rewrites still parses with the schema the page reads it
 * with, so a stub can never fail its own spec on the wire's shape, and says what the capture needs.
 */
import { describe, expect, test } from 'bun:test';

import { SHOWCASE_TRIAGE_INBOX_FILE } from '../fixtures/showcase-content.ts';
import {
  parseWorkflowText,
  workflowFileDetailSchema,
  workflowFileRunsPageSchema,
  workflowValidationSchema,
} from '../src/lib/workflow-files.ts';
import { documentProblemOf } from '../src/routes/workflow-definitions/workflow-issue-line.ts';
import { workflowRunRow } from '../src/routes/workflow-definitions/workflow-run-rows.ts';
import { runStatusWord } from '../src/routes/workflows/runs/run-rows.ts';
import {
  asOutsideSchedule,
  asSignalStarted,
  listWithSignalStarted,
  MORNING_BRIEFING_TEXT,
  OUTSIDE_SCHEDULE_ID,
  REFUSED_LINE,
  refusedValidation,
  TRIAGE_SIGNAL,
  unwritableAnswer,
  WAITING_RUN_ID,
  waitingSignalRun,
  withNoRuns,
  withRunFirst,
} from './e2e/workflow-page-states-stubs.ts';

/** A run of Release notes as the host answers it, which the stubs keep on the page. */
const FAILED_RUN = {
  id: 'run-failed',
  workflow: 'release-notes',
  workflowVersion: 'sha256:1',
  status: 'failed',
  createdAt: '2026-10-30T16:00:00.000Z',
  updatedAt: '2026-10-30T16:00:03.000Z',
  origin: { kind: 'schedule', scheduleId: 'schedule-1', fireId: 'fire-1' },
  steps: { total: 4, at: 2 },
  awaitingSignal: null,
  failure: 'GitHub didn’t answer',
};

/** Triage inbox as `bureau.workflows.get` answers it on the sample world. */
const TRIAGE_DETAIL = {
  id: 'triage-inbox',
  state: 'ready',
  owner: 'local',
  hash: 'hash-1',
  title: 'Triage inbox',
  description: 'Sorts new messages into the right folder and flags anything urgent.',
  agent: null,
  paused: true,
  inputSchema: null,
  outputSchema: null,
  version: 'sha256:2',
  trigger: { kind: 'schedule', name: 'Inbox triage', spec: '0 8 * * *' },
  problem: null,
  text: SHOWCASE_TRIAGE_INBOX_FILE.text,
  schedule: { id: 'bureau-workflow-schedule:triage-inbox:1', status: 'paused', nextFireAt: null },
};

describe('the waiting run (rows 63n, 63o)', () => {
  test('parses as a page of runs, first, and reads as Waiting for its signal', () => {
    const page = withRunFirst(
      { runs: [FAILED_RUN], nextOffset: null },
      waitingSignalRun('release-notes', 'sha256:1'),
    );
    const parsed = workflowFileRunsPageSchema.parse(page);
    expect(parsed.runs.map((run) => run.id)).toEqual([WAITING_RUN_ID, 'run-failed']);
    const [waiting] = parsed.runs;
    if (waiting === undefined) throw new Error('Expected the waiting run');
    expect(waiting.awaitingSignal).toBe('notes-approved');
    const row = workflowRunRow(
      {
        id: waiting.id,
        status: waiting.status,
        createdAt: Date.parse(waiting.createdAt),
        updatedAt: Date.parse(waiting.updatedAt),
        origin: waiting.origin,
        steps: waiting.steps,
        awaitingSignal: waiting.awaitingSignal,
        failure: waiting.failure,
      },
      { title: 'Release notes', agentName: null, type: 'release-notes' },
    );
    expect(runStatusWord(row)).toBe('Waiting');
  });

  test('an empty page parses', () => {
    expect(workflowFileRunsPageSchema.parse(withNoRuns({ runs: [FAILED_RUN] })).runs).toEqual([]);
  });
});

describe('the builder’s states (COR-2432, rows 65d, 65n, 65w, 65z, 66a)', () => {
  test('the morning briefing parses, with step 3 of a kind the builder cannot draw', () => {
    const document = parseWorkflowText(MORNING_BRIEFING_TEXT);
    expect(document?.trigger).toMatchObject({
      kind: 'schedule',
      spec: '0 9 * * 1-5',
      timezone: 'America/Chicago',
    });
    expect(document?.steps.map((step) => step.kind)).toEqual([
      'activity',
      'await-signal',
      'fan-out',
    ]);
  });

  test('the refusal parses as a validation answer and names the line the capture expects', () => {
    const answer = workflowValidationSchema.parse(refusedValidation());
    if (answer.status !== 'invalid') throw new Error('Expected a refusal');
    expect(documentProblemOf(MORNING_BRIEFING_TEXT, answer.issues)?.line).toBe(REFUSED_LINE);
  });

  test('the unwritable answer is a JSON-RPC refusal the client reads as one', () => {
    const answer = unwritableAnswer(7, 'release-notes.json');
    expect(answer).toMatchObject({
      jsonrpc: '2.0',
      id: 7,
      error: {
        message: 'release-notes.json couldn’t be written: permission denied.',
        data: { weftCode: 'Unprocessable', httpStatus: 422 },
      },
    });
  });
});

describe('Triage inbox as drawn (rows 62q, 62r, 62s, 63l)', () => {
  test('the file parses as a detail, started by its signal, with no schedule of its own', () => {
    const detail = workflowFileDetailSchema.parse(asSignalStarted(TRIAGE_DETAIL));
    expect(detail.trigger).toEqual({ kind: 'signal', name: TRIAGE_SIGNAL });
    expect(detail.schedule).toBeNull();
    expect(parseWorkflowText(detail.text)?.trigger).toEqual({
      kind: 'signal',
      name: TRIAGE_SIGNAL,
    });
  });

  test('the list rewrites only Triage inbox, and its entry still parses', () => {
    const answer = listWithSignalStarted(
      { workflows: [{ id: 'release-notes', trigger: { kind: 'schedule' } }, TRIAGE_DETAIL] },
      'triage-inbox',
    );
    const workflows = answer['workflows'] as Array<Record<string, unknown>>;
    expect(workflows[0]?.['trigger']).toEqual({ kind: 'schedule' });
    expect(workflowFileDetailSchema.parse(workflows[1]).trigger).toEqual({
      kind: 'signal',
      name: TRIAGE_SIGNAL,
    });
  });

  test('the schedule runs it from outside its file, by name, and keeps its status', () => {
    const answer = asOutsideSchedule({
      items: [{ id: 'bureau-workflow-schedule:triage-inbox:1', status: 'paused' }],
      total: 1,
    });
    expect(answer['items']).toEqual([
      { id: OUTSIDE_SCHEDULE_ID, status: 'paused', description: 'Inbox triage' },
    ]);
    expect(OUTSIDE_SCHEDULE_ID.startsWith('bureau-workflow-schedule:')).toBe(false);
  });
});
