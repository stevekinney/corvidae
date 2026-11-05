/**
 * The heading, the actions and the details card of a schedule's page (COR-2018, rows 72a to 72u,
 * 73r to 73t, 72l to 72p), driven against `installWorkflowWorld` as `schedule-controls.test.ts` is:
 * the Active switch named with its visible label first, the one status word, the sentence under
 * the heading, why Run now is off, a paused workflow and the link that resumes it, the actions a
 * schedule that a file defines offers, and the card's groups.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  runFixture,
  scheduleFixture,
  sourceDefinition,
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

const DAILY = 'daily';
const RUNNER = 'weekly-runner';
const DIGEST = 'bureau-workflow-schedule:digest:1';
const TRIAGE = 'bureau-workflow-schedule:triage:1';
const NOW = Date.now();
const DAY = 24 * 60 * 60_000;

function world(overrides: Partial<World> = {}): World {
  return emptyWorld({
    definitions: [
      codeDefinition('agentRun'),
      sourceDefinition('digest'),
      sourceDefinition('triage'),
    ],
    files: [
      readyFile('digest', {
        title: 'Release notes',
        trigger: { kind: 'schedule', spec: '0 11 * * 5', input: { branch: 'main' } },
      }),
      readyFile('triage', {
        title: 'Triage inbox',
        paused: true,
        trigger: { kind: 'schedule', spec: '0 8 * * *' },
        schedule: { id: TRIAGE, status: 'paused', nextFireAt: null },
      }),
    ],
    schedules: [
      scheduleFixture(DAILY, 'agentRun', {
        description: 'Daily summary',
        cronExpression: '0 9 * * *',
        revision: 3,
        createdAt: NOW - 7 * DAY,
        lastFireAt: NOW - 6 * DAY,
        nextFireAt: NOW + 16.5 * 60 * 60_000,
        missedFireCount: 4,
        lastMissedFireAt: NOW - DAY,
      }),
      scheduleFixture(RUNNER, 'agentRun', {
        description: 'Weekly runner',
        cronExpression: '0 11 * * 1',
        revision: 2,
      }),
      scheduleFixture(DIGEST, 'digest', {
        description: 'Release notes digest',
        cronExpression: '0 11 * * 5',
      }),
      scheduleFixture(TRIAGE, 'triage', {
        description: 'Inbox triage',
        status: 'paused',
        cronExpression: '0 8 * * *',
        nextFireAt: null,
      }),
    ],
    scheduleAgents: { [DAILY]: 'assistant', [RUNNER]: 'tool-runner' },
    scheduleInputs: {
      [DAILY]: 'Summarize yesterday’s chats and open reviews.',
      [RUNNER]: 'Audit refunds.',
    },
    agentModels: { assistant: null, 'tool-runner': 'anthropic/claude-sonnet-5-5' },
    agents: [
      { name: 'assistant', displayName: 'Assistant', media: null },
      { name: 'tool-runner', displayName: 'Tool runner', media: null },
    ],
    attention: [
      { kind: 'no-provider', area: 'providers', at: NOW - 3_600_000, provider: 'anthropic' },
      {
        kind: 'missed-runs',
        area: 'schedules',
        at: NOW - DAY,
        scheduleId: DAILY,
        scheduleName: 'Daily summary',
        count: 4,
        since: NOW - 3 * DAY,
        occurrences: [],
      },
    ],
    ...overrides,
  });
}

function open(path: string, overrides: Partial<World> = {}) {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  stub = installWorkflowWorld(world(overrides));
  router.navigate(path, { replace: true });
  return render(IndexHarness, { props: { client: stub.client, externalBureau: true } });
}

/** The status word of the heading row, which the page draws once. */
function headerStatus(): string | null | undefined {
  return document
    .querySelector('.cinder-page-header [data-status-word]')
    ?.getAttribute('data-status-word');
}

describe('the heading of a schedule', () => {
  test('is the name, the Active switch named label first, and one status word with the missed runs in it', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${DAILY}`);

    await findByRole('heading', { level: 1, name: 'Daily summary' });
    const toggle = await findByRole('switch', { name: 'Active, Daily summary schedule' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('data-changes')).toBe(true);
    await waitFor(() => expect(headerStatus()).toBe('Missed runs · 4'));
    // The sentence: the workflow and the agent are links, and the schedule's own time is in parentheses.
    const sentence = await findByTestId('schedule-status-line');
    expect(sentence.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
      /^Runs Chat with an agent with Assistant every day at .*\.$/,
    );
    expect(Array.from(sentence.querySelectorAll('a'), (link) => link.getAttribute('href'))).toEqual(
      ['/internal-workflows', '/agents/assistant'],
    );
  });

  test('names the schedule in the breadcrumb while the page is open', async () => {
    const { findByRole } = open(`/schedules/${DAILY}`);

    await findByRole('heading', { level: 1, name: 'Daily summary' });
    await waitFor(() =>
      expect(breadcrumbTrail(`/schedules/${DAILY}`).map((item) => item.label)).toEqual([
        'Schedules',
        'Daily summary',
      ]),
    );
  });

  test('has Edit, Run now and a menu, and says when it runs next and when it last ran', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${DAILY}`);

    expect(await findByRole('button', { name: 'Edit' })).not.toBeNull();
    expect(await findByRole('button', { name: 'Run now' })).not.toBeNull();
    expect(await findByRole('button', { name: 'More actions' })).not.toBeNull();
    const summary = await findByTestId('schedule-summary');
    await waitFor(() => expect(summary.textContent).toMatch(/Next .* \(in 16 hours\)/));
    await waitFor(() => expect(summary.textContent).toMatch(/Last ran\s+[A-Z][a-z]{2} \d+/));
  });

  test('a paused schedule has the switch off, says Paused, and has no next run', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${TRIAGE}`);

    const toggle = await findByRole('switch', { name: 'Active, Inbox triage schedule' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await waitFor(() => expect(headerStatus()).toBe('Paused'));
    const summary = await findByTestId('schedule-summary');
    expect(summary.textContent).toContain('No next run while paused');
  });
});

describe('Run now', () => {
  test('is off, with its reason as its description, while no provider is connected and the agent needs a model', async () => {
    const { findByRole } = open(`/schedules/${RUNNER}`);

    const button = await findByRole('button', { name: 'Run now' });
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('true'));
    const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('No model provider is connected.');

    await fireEvent.click(button);
    expect(stub?.callsTo('bureau.schedules.runnow')).toHaveLength(0);
  });

  test('is never off for a schedule on Assistant, which is scripted and needs no model', async () => {
    const { findByRole } = open(`/schedules/${DAILY}`);

    const button = await findByRole('button', { name: 'Run now' });
    // Let the agents and their models be read, which is when a provider would hold it.
    await waitFor(() => expect(headerStatus()).toBe('Missed runs · 4'));
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('a schedule whose workflow is paused', () => {
  test('says so under the sentence, describes the switch, and resumes the workflow from its link', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${TRIAGE}`);

    const note = await findByTestId('schedule-workflow-paused');
    expect(note.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Triage inbox is paused, so this schedule won’t run it. Resume workflow',
    );
    const toggle = await findByRole('switch', { name: 'Active, Inbox triage schedule' });
    const description = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toContain('Resuming this schedule would schedule runs');
    expect(description?.textContent).toContain('Resume workflow');

    await fireEvent.click(within(note).getByRole('button', { name: 'Resume workflow' }));

    await waitFor(() => expect(stub?.callsTo('bureau.workflows.resume')).toHaveLength(1));
    expect(stub?.callsTo('bureau.workflows.resume')[0]?.params['id']).toBe('triage');
  });
});

describe('a schedule that a file defines', () => {
  test('offers Open file and Run now only, with a switch that only shows its state', async () => {
    const { findByRole, queryByRole } = open(`/schedules/${DIGEST}`);

    const open_ = await findByRole('link', { name: 'Open file' });
    expect(open_.getAttribute('href')).toBe('/workflows/digest/edit');
    expect(await findByRole('button', { name: 'Run now' })).not.toBeNull();
    expect(queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(queryByRole('button', { name: 'More actions' })).toBeNull();
    const toggle = await findByRole('switch', { name: 'Active, Release notes digest schedule' });
    expect(toggle.getAttribute('aria-readonly')).toBe('true');
  });
});

describe('the chip of a schedule that a file defines (rows 73d and 73j)', () => {
  test('says Defined in the file’s path relative to the home, with the full path on hover, and no callout', async () => {
    const { findByTestId } = open(`/schedules/${DIGEST}`);

    const chip = await findByTestId('schedule-file');
    expect(chip.textContent?.replace(/\s+/g, ' ').trim()).toBe('Defined in workflows/digest.json');
    const path = await findByTestId('schedule-file-path');
    await waitFor(() => expect(path.getAttribute('title')).toMatch(/\/workflows\/digest\.json$/));
    expect(path.getAttribute('title')).not.toBe('workflows/digest.json');
    // A line under the sentence, not a callout, and nothing on the page says the file locks it.
    expect(chip.closest('.cinder-alert, .cinder-callout')).toBeNull();
    expect(document.querySelector('.cinder-callout')).toBeNull();
  });

  test('is not drawn for a schedule made for the workflow, which Edit opens', async () => {
    const { findByRole, queryByTestId } = open(`/schedules/${DAILY}`);

    await findByRole('button', { name: 'Edit' });
    expect(queryByTestId('schedule-file')).toBeNull();
  });
});

describe('a schedule while one of its runs is going (rows 73c, 73d and 73e)', () => {
  const going = runFixture('run-now', 'digest', {
    status: 'running',
    createdAt: Date.now() - 38_000,
    updatedAt: Date.now() - 38_000,
  });

  test('reads Running with its switch still on, and says so first in the summary line, with a link to the run', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${DIGEST}`, { runs: [going] });

    const toggle = await findByRole('switch', { name: 'Active, Release notes digest schedule' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-readonly')).toBe('true');
    await waitFor(() => expect(headerStatus()).toBe('Running'));
    const summary = await findByTestId('schedule-summary');
    await waitFor(() =>
      expect(summary.textContent?.replace(/\s+/g, ' ').trim()).toMatch(
        /^Running now: started \d+ seconds ago · Open run · Next .*\d{1,2}:\d{2} [AP]M · /,
      ),
    );
    expect(summary.textContent).not.toContain('(in ');
    const leading = await findByTestId('schedule-running-now');
    expect(leading.getAttribute('data-tone')).toBe('info');
    expect(within(summary).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      '/runs/run-now',
    );
  });

  test('keeps Run now on and says beside it that it starts a second run', async () => {
    const { findByRole, findByTestId } = open(`/schedules/${DIGEST}`, { runs: [going] });

    const runNow = await findByRole('button', { name: 'Run now' });
    expect(runNow.hasAttribute('disabled')).toBe(false);
    const note = await findByTestId('schedule-run-now-second');
    expect(note.textContent?.trim()).toBe('Another run is going; this starts a second one.');
  });

  test('says none of it when no run is going', async () => {
    const finished = runFixture('run-done', 'digest', { status: 'completed' });
    const { findByRole, queryByTestId } = open(`/schedules/${DIGEST}`, { runs: [finished] });

    await findByRole('button', { name: 'Run now' });
    await waitFor(() => expect(headerStatus()).toBe('Active'));
    expect(queryByTestId('schedule-running-now')).toBeNull();
    expect(queryByTestId('schedule-run-now-second')).toBeNull();
  });
});

describe('the details card', () => {
  test('has What runs, Input with a Fields and JSON switch and a copy button, When, Behaviour and Created', async () => {
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    });
    try {
      const { findByTestId } = open(`/schedules/${DAILY}`);
      const card = within(await findByTestId('schedule-details'));

      // What runs: the built-in workflow with its small identifier, and the agent.
      expect(card.getByTestId('schedule-workflow').textContent).toContain('Chat with an agent');
      expect(card.getByTestId('schedule-workflow').textContent).toContain('(built in)');
      expect(card.getByTestId('schedule-workflow').querySelector('code')?.textContent).toBe(
        'agentRun',
      );
      expect(card.getByTestId('schedule-agents').textContent).toContain('Assistant');

      // Input: fields first, JSON on the switch, one copy button.
      const input = within(card.getByTestId('schedule-input'));
      expect(input.getByText('Message')).not.toBeNull();
      expect(input.getByText('Summarize yesterday’s chats and open reviews.')).not.toBeNull();
      await fireEvent.click(input.getByRole('radio', { name: 'JSON' }));
      // The JSON view shows the stored key, `message`, where the fields showed its label.
      await waitFor(() =>
        expect(card.getByTestId('schedule-input').textContent).toContain('message'),
      );
      expect(input.queryByText('Message')).toBeNull();
      await fireEvent.click(input.getByRole('button', { name: 'Copy input' }));
      await waitFor(() =>
        expect(JSON.parse(written[0] ?? 'null')).toEqual({
          message: 'Summarize yesterday’s chats and open reviews.',
        }),
      );

      // When: the form's labels, with Edit; Behaviour; Created.
      expect(card.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
        `/schedules/${DAILY}/edit`,
      );
      for (const label of ['Repeats', 'At', 'Time zone'])
        expect(card.getByText(label)).not.toBeNull();
      expect(card.getByText('Every day')).not.toBeNull();
      expect(card.getByText('9:00 AM')).not.toBeNull();
      expect(card.getByText('UTC')).not.toBeNull();
      expect(card.getByText('If a run is still going')).not.toBeNull();
      expect(card.getByText('Skip this one')).not.toBeNull();
      expect(card.getByText('If Interborough was off')).not.toBeNull();
      expect(card.getByText('Don’t catch up on missed runs')).not.toBeNull();
      expect(card.getByText('Workflow version')).not.toBeNull();
      expect(card.getByText('Latest')).not.toBeNull();
      expect(card.getByRole('button', { name: 'About the workflow version' })).not.toBeNull();
      expect(card.getByTestId('schedule-created').textContent).toMatch(
        /^Created [A-Z][a-z]{2} \d+$/,
      );
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test('has no Input group for a workflow with no input, and a file’s trigger values are its fields', async () => {
    const { findByTestId, queryByTestId } = open(`/schedules/${TRIAGE}`);
    const card = await findByTestId('schedule-details');
    expect(within(card).getByText('Triage inbox')).not.toBeNull();
    expect(queryByTestId('schedule-input')).toBeNull();
  });

  test('a file-defined schedule’s Input group is the values its trigger sends, by their labels', async () => {
    const { findByTestId } = open(`/schedules/${DIGEST}`);
    const input = within(await findByTestId('schedule-input'));
    expect(input.getByText('Branch')).not.toBeNull();
    expect(input.getByText('main')).not.toBeNull();
  });
});
