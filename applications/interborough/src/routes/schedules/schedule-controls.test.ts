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
  test('goes through the Bureau naming the revision the page read, and marks the skipped run', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'Skip the next one' }));

    await waitFor(() => expect(stub?.callsTo('bureau.schedules.skipnext')).toHaveLength(1));
    expect(stub?.callsTo('bureau.schedules.skipnext')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
      expectedRevision: 3,
    });
    const list = await findByTestId('schedule-next-fires');
    await waitFor(() => expect(list.querySelector('[data-skipped="true"]')).not.toBeNull());
  });

  test('is refused as stale when the schedule changed after the page read it, and writes nothing', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);
    const skip = await findByRole('button', { name: 'Skip the next one' });
    const schedule = stub?.world.schedules.find((candidate) => candidate.id === AGENT_SCHEDULE);
    if (schedule === undefined) throw new Error('expected the seeded schedule');
    schedule.revision = 4;

    await fireEvent.click(skip);

    const notice = await findByTestId('schedule-notice');
    expect(notice.getAttribute('data-notice')).toBe('stale');
    expect(schedule.skipUntil).toBeUndefined();
  });

  test('says what was not done, and not that the schedule changed, for any other refusal', async () => {
    const { findByRole, findByText } = open(`/schedules/${AGENT_SCHEDULE}`);
    const skip = await findByRole('button', { name: 'Skip the next one' });
    stub?.on('bureau.schedules.skipnext', () => {
      throw workflowFaults.unavailable();
    });

    await fireEvent.click(skip);

    await findByText(SCHEDULE_COPY.skipFailed, { exact: false });
  });
});

describe('Run now, for an agent run', () => {
  test('goes through the Bureau and links to the task it started, and the notice can be dismissed', async () => {
    const { findByRole, findByTestId, queryByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);

    await fireEvent.click(await findByRole('button', { name: 'Run now' }));

    const result = await findByTestId('schedule-run-now');
    expect(result.getAttribute('data-outcome')).toBe('started');
    expect(within(result).getByRole('link', { name: 'View the run' }).getAttribute('href')).toBe(
      `/runs/task-run-now-${AGENT_SCHEDULE}`,
    );
    expect(stub?.callsTo('bureau.schedules.runnow')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
    });

    await fireEvent.click(within(result).getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(queryByTestId('schedule-run-now')?.outerHTML ?? null).toBeNull());
  });

  test('says when the run was queued behind the one going, and when it was skipped for it', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${AGENT_SCHEDULE}`);
    const answers = [
      { outcome: 'queued', taskId: 'task-queued' },
      { outcome: 'skipped', blockingTaskId: null },
    ];
    stub?.on('bureau.schedules.runnow', () => answers.shift());

    await fireEvent.click(await findByRole('button', { name: 'Run now' }));
    const queued = await findByTestId('schedule-run-now');
    expect(queued.getAttribute('data-outcome')).toBe('queued');
    expect(queued.textContent).toContain(SCHEDULE_COPY.detail.runNowOutcome.queued);
    expect(within(queued).getByRole('link', { name: 'View the run' })).not.toBeNull();

    await waitFor(() =>
      expect(
        (document.querySelector('button[data-changes]') as HTMLButtonElement | null)?.disabled,
      ).toBe(false),
    );
    await fireEvent.click(await findByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="schedule-run-now"]')?.getAttribute('data-outcome'),
      ).toBe('skipped'),
    );
    const skipped = await findByTestId('schedule-run-now');
    expect(within(skipped).queryByRole('link', { name: 'View the run' })).toBeNull();
  });
});

describe('a workflow file’s schedule', () => {
  test('offers neither Skip the next one nor Run now, because only its file changes it', async () => {
    const { findByRole, queryByRole } = open(`/schedules/${FILE_SCHEDULE}`);

    await findByRole('switch', { name: 'On' });
    expect(queryByRole('button', { name: 'Skip the next one' })).toBeNull();
    expect(queryByRole('button', { name: 'Run now' })).toBeNull();
  });
});

describe('the details of a schedule', () => {
  test('say its jitter, the revision it is pinned to, and that it catches up after downtime', async () => {
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

    const rail = within(await findByTestId('schedule-rail'));
    await rail.findByText('±30000ms');
    expect(rail.getByText('Pinned (rev-1)')).not.toBeNull();
    expect(rail.getByText(SCHEDULE_COPY.detail.rail.catchUpOn)).not.toBeNull();
  });
});

describe('the past runs of a schedule', () => {
  test('list the fires an agent run missed, read through the Bureau, with why and how many', async () => {
    const { findAllByTestId, findByText } = open(`/schedules/${AGENT_SCHEDULE}`, {
      missedFires: {
        [AGENT_SCHEDULE]: [
          { occurrence: Date.parse('2030-01-01T09:00:00.000Z'), reason: 'late', count: 1 },
          { occurrence: Date.parse('2029-03-10T02:30:00.000Z'), reason: 'dst-gap', count: 2 },
        ],
      },
    });

    const rows = await findAllByTestId('schedule-missed-row');
    expect(rows).toHaveLength(2);
    await findByText(new RegExp(SCHEDULE_COPY.detail.missedReason.late));
    await findByText(
      new RegExp(
        `${SCHEDULE_COPY.detail.missedCount(2)}\\. ${SCHEDULE_COPY.detail.missedReason['dst-gap']}`,
      ),
    );
    expect(stub?.callsTo('bureau.schedules.missed')[0]?.params).toEqual({
      scheduleId: AGENT_SCHEDULE,
    });
  });

  test('say which list could not be read, and read it again on request', async () => {
    let failing = true;
    const { findByText, findByRole, findAllByTestId } = open(
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

    expect(await findAllByTestId('schedule-missed-row')).toHaveLength(1);
  });

  test('say when a schedule has no past run at all', async () => {
    const { findByText } = open(`/schedules/${AGENT_SCHEDULE}`);

    await findByText(SCHEDULE_COPY.detail.noPastRuns.title);
  });
});
