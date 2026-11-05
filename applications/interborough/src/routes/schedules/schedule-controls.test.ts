/**
 * What the controls of a schedule's page do for each kind of schedule, driven against
 * `installWorkflowWorld` as `schedule-owners.test.ts` is: Skip the next one and Run now go through
 * the service that owns the schedule (the Bureau, naming the revision the page read, for an agent
 * run), a workflow file's schedule offers neither, a run now says what the overlap policy did, and
 * the fires a schedule missed are listed among its past runs from the service that recorded them.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  scheduleFixture,
  sourceDefinition,
  workflowFaults,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import IndexHarness from './index-test-harness.test-harness.svelte';

let stub: WorkflowStub | undefined;

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const AGENT_SCHEDULE = 'daily-summary';
const FILE_SCHEDULE = 'bureau-workflow-schedule:digest:1';
const CODE_SCHEDULE = 'every-5';
const NEXT_FIRE = Date.parse('2030-01-01T09:00:00.000Z');

function world(overrides: Partial<World> = {}): World {
  return emptyWorld({
    definitions: [
      codeDefinition('order-processing'),
      codeDefinition('agentRun'),
      sourceDefinition('digest'),
    ],
    files: [readyFile('digest')],
    schedules: [
      scheduleFixture(AGENT_SCHEDULE, 'agentRun', {
        description: 'Daily summary',
        revision: 3,
        cronExpression: '0 9 * * *',
        nextFireAt: NEXT_FIRE,
      }),
      scheduleFixture(FILE_SCHEDULE, 'digest', { description: 'Workflow digest' }),
      scheduleFixture(CODE_SCHEDULE, 'order-processing', { revision: 5 }),
    ],
    scheduleAgents: { [AGENT_SCHEDULE]: 'assistant' },
    ...overrides,
  });
}

/** `before` changes how the services answer, ahead of the first request the page makes. */
function open(
  path: string,
  overrides: Partial<World> = {},
  before: (installed: WorkflowStub) => void = () => undefined,
) {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  stub = installWorkflowWorld(world(overrides));
  before(stub);
  router.navigate(path, { replace: true });
  return render(IndexHarness, { props: { client: stub.client, externalBureau: true } });
}

describe('Skip the next one, for an agent run', () => {
  test('goes through the Bureau naming the revision and the run the page read, and marks the skipped run', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: /^Skip / }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.skipnext')).toHaveLength(1));
    expect(stub?.callsTo('bureau.schedules.skipnext')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      occurrence: '2030-01-01T09:00:00.000Z',
      expectedRevision: 3,
    });
    const list = await findByTestId('schedule-runs');
    await waitFor(() => expect(list.querySelector('time[data-cinder-struck]')).not.toBeNull());
  });

  test('is refused as stale when the schedule changed after the page read it, and writes nothing', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);
    const skip = await findByRole('button', { name: /^Skip / });
    const schedule = stub?.world.schedules.find((candidate) => candidate.id === AGENT_SCHEDULE);
    if (schedule === undefined) throw new Error('expected the seeded schedule');
    schedule.revision = 4;

    await fireEvent.click(skip);

    const notice = await findByTestId('schedule-notice');
    expect(notice.getAttribute('data-notice')).toBe('stale');
    expect(schedule.skipUntil).toBeUndefined();
  });

  test('is refused as stale when a fire moved the next run after the page read it, and the page reads the schedule again', async () => {
    // A fire moves `nextFireAt` and leaves the revision and the status, so only the run the skip
    // names can tell that the run the person chose has gone.
    const { findByRole, findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);
    const skip = await findByRole('button', { name: /^Skip / });
    const schedule = stub?.world.schedules.find((candidate) => candidate.id === AGENT_SCHEDULE);
    if (schedule === undefined) throw new Error('expected the seeded schedule');
    const fired = Date.parse('2030-01-02T09:00:00.000Z');
    schedule.nextFireAt = fired;

    await fireEvent.click(skip);

    const notice = await findByTestId('schedule-notice');
    expect(notice.getAttribute('data-notice')).toBe('stale');
    expect(schedule.skipUntil).toBeUndefined();
    const list = await findByTestId('schedule-runs');
    // The nearest run is the last upcoming row, against the Now marker.
    await waitFor(() =>
      expect(
        Array.from(list.querySelectorAll('li[data-cinder-tone="pending"] time'))
          .at(-1)
          ?.getAttribute('datetime'),
      ).toBe('2030-01-02T09:00:00.000Z'),
    );
  });

  test('says what was not done, and not that the schedule changed, for any other refusal', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`);
    const skip = await findByRole('button', { name: /^Skip / });
    stub?.on('bureau.schedules.skipnext', () => {
      throw workflowFaults.unavailable();
    });

    await fireEvent.click(skip);

    await findByText(SCHEDULE_COPY.skipFailed, { exact: false });
  });
});

describe('Run now, for an agent run', () => {
  test('goes through the Bureau and says so in a toast that opens the task it started', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'Run now' }));

    await findByText('Started Daily summary.');
    expect(stub?.callsTo('bureau.schedules.runnow')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
    });
    await fireEvent.click(await findByRole('button', { name: 'Open run' }));
    await waitFor(() => expect(router.pathname).toBe(`/runs/task-run-now-${AGENT_SCHEDULE}`));
  });

  test('says when the run was queued behind the one going, and when it was skipped for it', async () => {
    const { findByRole, findByText, queryByRole } = open(`/schedules/${AGENT_SCHEDULE}`);
    const answers = [
      { outcome: 'queued', taskId: 'task-queued' },
      { outcome: 'skipped', blockingTaskId: null },
    ];
    stub?.on('bureau.schedules.runnow', () => answers.shift());

    await fireEvent.click(await findByRole('button', { name: 'Run now' }));
    await findByText(SCHEDULE_COPY.detail.runNowOutcome.queued);
    expect(await findByRole('button', { name: 'Open run' })).not.toBeNull();

    await waitFor(() =>
      expect(
        (document.querySelector('button[data-changes]') as HTMLButtonElement | null)?.disabled,
      ).toBe(false),
    );
    await fireEvent.click(await findByRole('button', { name: 'Run now' }));
    await findByText(SCHEDULE_COPY.detail.runNowOutcome.skipped);
    // Only the queued toast links to a run: a skipped one started nothing.
    expect(queryByRole('button', { name: 'Open run' })?.closest('[role="alert"]')).toBeNull();
  });
});

describe('a workflow file’s schedule', () => {
  test('offers Skip on its next run, and Run now starts the file with what its trigger sends', async () => {
    const { findByRole, findByText } = open(`/schedules/${FILE_SCHEDULE}`, {
      files: [
        readyFile('digest', {
          trigger: { kind: 'schedule', spec: '0 6 * * *', input: { branch: 'main' } },
        }),
      ],
    });

    await findByRole('switch', { name: 'Active, Workflow digest schedule' });
    expect(await findByRole('button', { name: /^Skip / })).not.toBeNull();

    await fireEvent.click(await findByRole('button', { name: 'Run now' }));

    await findByText('Started Workflow digest.');
    expect(stub?.world.startedRuns).toEqual([{ id: 'digest', input: { branch: 'main' } }]);
  });
});

describe('the details of a schedule', () => {
  test('say the revision it is pinned to, and that it catches up after downtime', async () => {
    const { findByTestId } = open(`/schedules/${CODE_SCHEDULE}`, {
      schedules: [
        scheduleFixture(CODE_SCHEDULE, 'order-processing', {
          revision: 5,
          jitterMs: 30_000,
          revisionPolicy: 'pinned',
          pinnedRevision: 'rev-1',
          backfill: true,
        }),
      ],
    });

    const card = within(await findByTestId('schedule-details'));
    await card.findByText('Pinned to rev-1');
    expect(card.getByText(SCHEDULE_COPY.detail.card.catchUpOn)).not.toBeNull();
  });
});

describe('the past runs of a schedule', () => {
  test('fold the fires an agent run missed into one band below Now, which opens to each with why and how many', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`, {
      missedFires: {
        [AGENT_SCHEDULE]: [
          { occurrence: Date.parse('2030-01-01T09:00:00.000Z'), reason: 'late', count: 1 },
          { occurrence: Date.parse('2029-03-10T02:30:00.000Z'), reason: 'dst-gap', count: 2 },
        ],
      },
    });

    await findByText(/^Missed 3 times since /);
    await fireEvent.click(await findByRole('button', { name: /Show each/ }));
    await findByText(
      SCHEDULE_COPY.detail.runs.missedRow(1, SCHEDULE_COPY.detail.runs.missedReason.late),
    );
    await findByText(
      SCHEDULE_COPY.detail.runs.missedRow(2, SCHEDULE_COPY.detail.runs.missedReason['dst-gap']),
    );
    expect(stub?.callsTo('bureau.schedules.missed')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
    });
  });

  test('say which list could not be read, and read it again on request', async () => {
    let failing = true;
    const { findByText, findByRole } = open(
      `/schedules/${AGENT_SCHEDULE}`,
      { missedFires: { [AGENT_SCHEDULE]: [{ occurrence: NEXT_FIRE, reason: 'late', count: 1 }] } },
      (installed) =>
        installed.on('bureau.schedules.missed', (params) => {
          if (failing) throw workflowFaults.unavailable();
          return installed.world.missedFires[String(params['scheduleId'])]?.length === 0
            ? { missed: [] }
            : {
                missed: [
                  {
                    scheduleId: AGENT_SCHEDULE,
                    owner: 'anonymous:local',
                    occurrence: new Date(NEXT_FIRE).toISOString(),
                    reason: 'late',
                    count: 1,
                    recordedAt: new Date(NEXT_FIRE + 1).toISOString(),
                  },
                ],
              };
        }),
    );

    await findByText(SCHEDULE_COPY.detail.missedFailed, { exact: false });
    failing = false;
    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    await findByText(/^Missed once on /);
  });

  test('say when a schedule has no past run at all', async () => {
    const { findByText } = open(`/schedules/${AGENT_SCHEDULE}`);

    await findByText(SCHEDULE_COPY.detail.runs.empty.title);
  });
});
