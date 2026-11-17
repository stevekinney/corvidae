/**
 * The answers `workflow-page-states.spec.ts` rewrites, as plain functions over the host's own
 * answers, so `tests/workflow-page-states-stubs.test.ts` checks each against the schema the page
 * parses it with (COR-2431). A stub that does not match the wire schema fails its own spec.
 *
 * - A Release notes run parked on the signal `notes-approved` since today at 10:05 AM, at step 4 of
 *   4, started by a person (board PageWorkflow, "Runs tab, a run waiting on a signal", rows 63n and
 *   63o): {@link waitingSignalRun}, put first on the page of runs ({@link withRunFirst}).
 * - Triage inbox as the board draws it ("More menu, and Delete", rows 62q, 62r, 62s and 63l):
 *   started by the signal `message-received`, and also by the Inbox triage schedule, which runs it
 *   from outside its file and is paused ({@link asSignalStarted}, {@link asOutsideSchedule}). The
 *   sample world writes Inbox triage as the file's own schedule trigger, so its delete dialog has no
 *   schedule to offer; this is the state the dialog's checkbox is drawn in.
 */

type JsonRecord = Record<string, unknown>;

/** The identifier the waiting run is given; it is never opened. */
export const WAITING_RUN_ID = 'sample-release-notes-waiting-on-a-signal';

/** Today, 10:05 AM in the sample world's zone, before its 10:46 AM clock. */
export const WAITING_RUN_STARTED = '2026-11-02T10:05:00-06:00';

/**
 * A run of `workflow` on `workflowVersion` that a person started today at 10:05 AM, waiting at its
 * last step for the signal `notes-approved`, as `bureau.workflows.runs.list` answers it.
 */
export function waitingSignalRun(workflow: string, workflowVersion: string): JsonRecord {
  const startedAt = new Date(Date.parse(WAITING_RUN_STARTED)).toISOString();
  return {
    id: WAITING_RUN_ID,
    workflow,
    workflowVersion,
    status: 'suspended',
    createdAt: startedAt,
    updatedAt: startedAt,
    origin: { kind: 'person', principal: 'local', surface: 'web' },
    steps: { total: 4, at: 4 },
    awaitingSignal: 'notes-approved',
    failure: null,
  };
}

/** A page of `bureau.workflows.runs.list` with `run` first, newest first as the Bureau lists them. */
export function withRunFirst(answer: JsonRecord, run: JsonRecord): JsonRecord {
  const runs = Array.isArray(answer['runs']) ? (answer['runs'] as JsonRecord[]) : [];
  return { ...answer, runs: [run, ...runs.filter((other) => other['id'] !== run['id'])] };
}

/** A page of `bureau.workflows.runs.list` with no run on it. */
export function withNoRuns(answer: JsonRecord): JsonRecord {
  return { ...answer, runs: [], nextOffset: null };
}

/** The signal that starts Triage inbox on the board. */
export const TRIAGE_SIGNAL = 'message-received';

/**
 * A file's answer (`bureau.workflows.get`, or one entry of `bureau.workflows.list`) rewritten so the
 * file is started by the signal {@link TRIAGE_SIGNAL} instead of its own schedule: its trigger, its
 * text, and no schedule of its own.
 */
export function asSignalStarted(file: JsonRecord): JsonRecord {
  const trigger = { kind: 'signal', name: TRIAGE_SIGNAL };
  const rewritten: JsonRecord = { ...file, trigger };
  if (typeof file['text'] === 'string') {
    const parsed = JSON.parse(file['text']) as JsonRecord;
    rewritten['text'] = `${JSON.stringify({ ...parsed, trigger }, null, 2)}\n`;
  }
  if ('schedule' in file) rewritten['schedule'] = null;
  return rewritten;
}

/** `bureau.workflows.list` with the file `id` rewritten by {@link asSignalStarted}. */
export function listWithSignalStarted(answer: JsonRecord, id: string): JsonRecord {
  const workflows = Array.isArray(answer['workflows']) ? (answer['workflows'] as JsonRecord[]) : [];
  return {
    ...answer,
    workflows: workflows.map((entry) => (entry['id'] === id ? asSignalStarted(entry) : entry)),
  };
}

/**
 * The morning briefing of board PageWorkflowBuilder ("JSON tab", row 65d, and "A step the builder
 * doesn't model", rows 66a and 66b): a weekday schedule in Central time, a question to Assistant,
 * a person's review, and step 3 of a kind the builder can't draw, as a person types it on the JSON
 * tab. Line 27 is step 3's `kind`.
 */
export const MORNING_BRIEFING_TEXT = `${JSON.stringify(
  {
    name: 'morning-briefing',
    title: 'Morning briefing',
    description: 'Summarizes yesterday for the team.',
    trigger: {
      kind: 'schedule',
      spec: '0 9 * * 1-5',
      timezone: 'America/Chicago',
      overlap: 'skip',
      catchUp: false,
    },
    steps: [
      {
        kind: 'activity',
        handler: 'agent',
        input: { agent: 'assistant', message: 'Summarize what happened yesterday.' },
      },
      { kind: 'await-signal', signal: 'approve-briefing', review: true },
      { kind: 'fan-out', over: 'teams' },
    ],
  },
  null,
  2,
)}\n`;

/** The line of {@link MORNING_BRIEFING_TEXT} the refused document is marked at (row 65z). */
export const REFUSED_LINE = 27;

/**
 * `bureau.workflows.validate` refusing the morning briefing at step 3, whose kind the Bureau does
 * not know, as the operation answers a draft it would not write (row 65z).
 */
export function refusedValidation(): JsonRecord {
  return {
    status: 'invalid',
    code: 'invalid-document',
    issues: [{ path: 'steps[2].kind', message: 'no step kind "fan-out" is registered' }],
  };
}

/**
 * The JSON-RPC error a write that the host could not put on disk is answered with, as the client
 * reads a refusal (rows 65n and 65w). `file` is how the page names the file. The host does not
 * answer this sentence today (COR-2432 reports the gap); the capture draws the state the board does.
 */
export function unwritableAnswer(id: unknown, file: string): JsonRecord {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: `${file} couldn’t be written: permission denied.`,
      data: { reason: 'workflow-file-unwritable', weftCode: 'Unprocessable', httpStatus: 422 },
    },
  };
}

/** The identifier the outside schedule is given in place of the Bureau's own for the file. */
export const OUTSIDE_SCHEDULE_ID = 'inbox-triage';

/**
 * The engine's page of schedules (`GET /schedules?workflowType=…`) with each schedule made one that
 * runs the workflow from outside its file: its own identifier and the name a person reads.
 */
export function asOutsideSchedule(answer: JsonRecord): JsonRecord {
  const items = Array.isArray(answer['items']) ? (answer['items'] as JsonRecord[]) : [];
  return {
    ...answer,
    items: items.map((item, index) => ({
      ...item,
      id: index === 0 ? OUTSIDE_SCHEDULE_ID : `${OUTSIDE_SCHEDULE_ID}-${String(index + 1)}`,
      description: 'Inbox triage',
    })),
  };
}
