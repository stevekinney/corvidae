/**
 * `/settings/a2a` (board PageSettingsSections, "A2A · /settings/a2a" and "A2A with Accept A2A calls
 * off"): the switch that accepts remote calls, the address of the agent card, a switch per agent,
 * push notifications, and the recent calls. Every row saves as it is left, through
 * `bureau.settings.update`. The Bureau is a stub.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { A2A_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { STUB_A2A_DIRECTORY_URL, type BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { AGENT, landAt } from '../../chat/pages.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

/** The eight agents of the sample world, in the order the Agents page lists them. */
const NAMES: readonly [string, string, boolean][] = [
  ['Assistant', 'assistant', true],
  ['Tool runner', 'tool-runner', true],
  ['Request human input', 'request-human-input', false],
  ['Echo', 'echo', false],
  ['Model switcher', 'model-switcher', false],
  ['Workflow author', 'workflow-author', false],
  ['Release helper', 'release-helper', false],
  ['Changelog writer', 'changelog-writer', false],
];
const SAMPLE_AGENTS = NAMES.map(([displayName, name, a2a]) => ({
  ...AGENT,
  name,
  displayName,
  kind: 'code',
  a2a,
}));

type Open = {
  agents?: readonly object[] | 'fail';
  values?: Record<string, unknown>;
  calls?: readonly object[];
};

function open({ agents = SAMPLE_AGENTS, values, calls = [] }: Open = {}) {
  const served = servedSettings(
    values === undefined ? {} : { values: { ...servedSettings().values, ...values } },
  );
  stub = installSettingsBureau(served, {
    'bureau.agents.list': () => {
      if (agents === 'fail') throw new Error('The Bureau is down.');
      return { agents };
    },
    'bureau.audit.query': () => ({ records: calls, nextCursor: null }),
  });
  landAt('/settings/a2a');
  return {
    served,
    view: render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never),
  };
}

const row = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-setting="${key}"]`);

const switchOf = (container: HTMLElement, label: string) =>
  within(container).getByRole('switch', { name: label });

describe('the Agent2Agent section', () => {
  test('is the heading and the intro, then the four rows in the order the board draws them', async () => {
    const { view } = open();

    expect(await view.findByRole('heading', { level: 1, name: 'A2A' })).not.toBeNull();
    expect(view.getByText(A2A_COPY.intro)).not.toBeNull();
    const group = await view.findByRole('group', { name: SETTINGS_COPY.formLabel });
    expect(
      within(group)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Agent2Agent', 'Recent calls']);
    expect(
      [...group.querySelectorAll<HTMLElement>('[data-setting]')].map(
        (entry) => entry.dataset['setting'],
      ),
    ).toEqual([
      'a2a.enabled',
      'agent-card-url',
      'a2a.agents',
      'a2a.push.enabled',
      'a2a.push.sweepIntervalMs',
    ]);
  });

  test('Accept A2A calls is a switch that is on and says it applies after a restart', async () => {
    const { view } = open();
    const enabled = await waitFor(() => {
      const found = row(view.container, 'a2a.enabled');
      expect(found).not.toBeNull();
      return found!;
    });

    expect(enabled.textContent).toContain(A2A_COPY.enabled.label);
    expect(enabled.textContent).toContain('a2a.enabled');
    expect(enabled.textContent).toContain(A2A_COPY.enabled.description);
    expect(enabled.textContent).toContain('Applies after restart');
    expect(switchOf(enabled, A2A_COPY.enabled.label).getAttribute('aria-checked')).toBe('true');
  });

  test('Agent card URL shows the address the host reports in monospace, with a button that copies it', async () => {
    const { view } = open();

    const card = await waitFor(() => {
      const found = row(view.container, 'agent-card-url');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(card.textContent).toContain(A2A_COPY.cardUrl.label);
    expect(card.textContent).toContain(A2A_COPY.cardUrl.description);
    await waitFor(() =>
      expect((within(card).getByTestId('a2a-card-url') as HTMLInputElement).value).toBe(
        STUB_A2A_DIRECTORY_URL,
      ),
    );
    expect(within(card).getByRole('button', { name: A2A_COPY.cardUrl.copy })).not.toBeNull();
  });

  test('Shared agents lists all eight agents in the Agents order, with a switch each', async () => {
    const { view } = open();

    const agents = await waitFor(() => {
      const found = row(view.container, 'a2a.agents');
      expect(found?.querySelectorAll('[data-agent]').length).toBe(8);
      return found!;
    });
    expect(agents.textContent).toContain(A2A_COPY.agents.label);
    expect(agents.textContent).toContain('a2a.agents');
    expect(agents.textContent).toContain(A2A_COPY.agents.description(8));
    expect(A2A_COPY.agents.description(8)).toBe(
      'All eight agents are listed; only the ones you turn on here answer remote calls. You can also set this on each agent’s Settings tab.',
    );
    // Each switch is named by its own agent, never by the row's label.
    for (const [displayName] of NAMES) {
      expect(within(agents).getByRole('switch', { name: displayName })).not.toBeNull();
    }
    expect(within(agents).queryByRole('switch', { name: A2A_COPY.agents.label })).toBeNull();
    expect(
      [...agents.querySelectorAll<HTMLElement>('[data-agent]')].map((item) => [
        item.textContent?.trim(),
        item.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
      ]),
    ).toEqual(NAMES.map(([displayName, , on]) => [displayName, on ? 'true' : 'false']));
  });

  test('Push notifications is a switch with the board’s words', async () => {
    const { view } = open();

    const push = await waitFor(() => {
      const found = row(view.container, 'a2a.push.enabled');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(push.textContent).toContain(A2A_COPY.pushNotifications.label);
    expect(push.textContent).toContain(A2A_COPY.pushNotifications.description);
    expect(switchOf(push, A2A_COPY.pushNotifications.label).getAttribute('aria-checked')).toBe(
      'false',
    );
  });
});

describe('saving a row', () => {
  test('sharing an agent writes the record with the agent in it, and the row says Saved', async () => {
    const { view, served } = open();
    const agents = await waitFor(() => {
      const found = row(view.container, 'a2a.agents');
      expect(found?.querySelectorAll('[data-agent]').length).toBe(8);
      return found!;
    });

    await fireEvent.click(switchOf(agents, 'Echo'));

    await waitUntil(() => (stub?.callsTo('bureau.settings.update').length ?? 0) === 1);
    expect(stub?.callsTo('bureau.settings.update')[0]?.params).toEqual({
      patch: { 'a2a.agents': { echo: true } },
      expectedRevision: 3,
    });
    expect(served.values['a2a.agents']).toEqual({ echo: true });
    await waitFor(() => expect(agents.textContent).toContain('Saved just now'));
    expect(switchOf(agents, 'Echo').getAttribute('aria-checked')).toBe('true');
  });

  test('withdrawing an agent the record already names changes only that agent’s entry', async () => {
    const { view } = open({ values: { 'a2a.agents': { echo: true, assistant: true } } });
    const agents = await waitFor(() => {
      const found = row(view.container, 'a2a.agents');
      expect(found?.querySelectorAll('[data-agent]').length).toBe(8);
      return found!;
    });
    expect(switchOf(agents, 'Echo').getAttribute('aria-checked')).toBe('true');

    await fireEvent.click(switchOf(agents, 'Echo'));

    await waitUntil(() => (stub?.callsTo('bureau.settings.update').length ?? 0) === 1);
    expect(stub?.callsTo('bureau.settings.update')[0]?.params).toMatchObject({
      patch: { 'a2a.agents': { echo: false, assistant: true } },
    });
  });

  test('turning Accept A2A calls off writes it and says the save waits for a restart', async () => {
    const { view, served } = open();
    const enabled = await waitFor(() => {
      const found = row(view.container, 'a2a.enabled');
      expect(found).not.toBeNull();
      return found!;
    });

    await fireEvent.click(switchOf(enabled, A2A_COPY.enabled.label));

    await waitUntil(() => (stub?.callsTo('bureau.settings.update').length ?? 0) === 1);
    expect(stub?.callsTo('bureau.settings.update')[0]?.params).toEqual({
      patch: { 'a2a.enabled': false },
      expectedRevision: 3,
    });
    expect(served.values['a2a.enabled']).toBe(false);
    await waitFor(() => expect(enabled.textContent).toContain('Saved, waiting for a restart'));
    const summary = await view.findByTestId('settings-restart-summary');
    expect(summary.textContent).toContain(A2A_COPY.enabled.label);
  });

  test('push notifications save as the switch changes', async () => {
    const { view } = open();
    const push = await waitFor(() => {
      const found = row(view.container, 'a2a.push.enabled');
      expect(found).not.toBeNull();
      return found!;
    });

    await fireEvent.click(switchOf(push, A2A_COPY.pushNotifications.label));

    await waitUntil(() => (stub?.callsTo('bureau.settings.update').length ?? 0) === 1);
    expect(stub?.callsTo('bureau.settings.update')[0]?.params).toMatchObject({
      patch: { 'a2a.push.enabled': true },
    });
  });
});

describe('with Accept A2A calls off', () => {
  test('the switch says what off means, and the other rows stay visible but cannot be changed', async () => {
    const { view } = open({ values: { 'a2a.enabled': false } });

    const enabled = await waitFor(() => {
      const found = row(view.container, 'a2a.enabled');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(enabled.textContent).toContain(A2A_COPY.enabled.off);
    expect(switchOf(enabled, A2A_COPY.enabled.label).getAttribute('aria-checked')).toBe('false');
    expect((switchOf(enabled, A2A_COPY.enabled.label) as HTMLButtonElement).disabled).toBe(false);

    const agents = await waitFor(() => {
      const found = row(view.container, 'a2a.agents');
      expect(found?.querySelectorAll('[data-agent]').length).toBe(8);
      return found!;
    });
    for (const entry of within(agents).getAllByRole('switch')) {
      expect((entry as HTMLButtonElement).disabled).toBe(true);
    }
    const push = row(view.container, 'a2a.push.enabled')!;
    expect((switchOf(push, A2A_COPY.pushNotifications.label) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(view.getByTestId('a2a-read-only').textContent).toBe(A2A_COPY.readOnly);
    // The address is still there to read and copy.
    expect(row(view.container, 'agent-card-url')?.textContent).toContain(A2A_COPY.cardUrl.label);
  });

  test('a switch that is on has no read-only line', async () => {
    const { view } = open();

    await view.findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(view.queryByTestId('a2a-read-only')).toBeNull();
  });
});

describe('the agents that cannot be listed', () => {
  test('say so on the row, with a way to try again', async () => {
    const { view } = open({ agents: 'fail' });

    const agents = await waitFor(() => {
      const found = row(view.container, 'a2a.agents');
      expect(found?.textContent).toContain(A2A_COPY.agents.loadFailed);
      return found!;
    });

    expect(within(agents).getByRole('button', { name: A2A_COPY.agents.retry })).not.toBeNull();
    expect(within(agents).queryAllByRole('switch')).toHaveLength(0);
  });
});

describe('Recent calls', () => {
  test('are a compact empty state when no remote call was made', async () => {
    const { view } = open();

    const empty = await view.findByTestId('a2a-calls-empty');

    expect(empty.textContent).toContain(A2A_COPY.recent.empty.title);
    expect(empty.textContent).toContain(A2A_COPY.recent.empty.description);
    expect(empty.getAttribute('data-cinder-size')).toBe('compact');
  });

  test('are a list of when, who and which agent answered, newest first, once calls were made', async () => {
    const at = (offset: number) => new Date(Date.now() - offset).toISOString();
    const { view } = open({
      calls: [
        {
          sequence: 1,
          timestamp: at(7_200_000),
          type: 'a2a.call',
          resource: 'task-1',
          principal: 'api-key:planner',
          detail: { agentName: 'tool-runner', taskId: 'task-1', callerName: 'planner' },
        },
        {
          sequence: 2,
          timestamp: at(60_000),
          type: 'a2a.call',
          resource: 'task-2',
          principal: 'api-key:alice',
          detail: { agentName: 'assistant', taskId: 'task-2' },
        },
      ],
    });

    await view.findAllByTestId('a2a-call');

    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-testid="a2a-call"]')];
    expect(rows.map((entry) => entry.dataset['task'])).toEqual(['task-2', 'task-1']);
    // Who made it is the name the caller gave, else its principal; the principal is the tooltip.
    expect(rows[0]?.textContent).toContain('Remote agent “api-key:alice”');
    expect(rows[0]?.textContent).toContain('answered by Assistant');
    expect(rows[1]?.textContent).toContain('Remote agent “planner”');
    expect(rows[1]?.textContent).toContain('answered by Tool runner');
    expect(rows[1]?.querySelector('[title="api-key:planner"]')).not.toBeNull();
    // The time reads as the clock ("Today, 7:48 AM"), not as "2 h ago".
    expect(rows[1]?.querySelector('time')?.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(view.queryByTestId('a2a-calls-empty')).toBeNull();
  });

  test('say so, with a way to try again, when the trail cannot be read', async () => {
    const served = servedSettings();
    stub = installSettingsBureau(served, {
      'bureau.agents.list': () => ({ agents: SAMPLE_AGENTS }),
      'bureau.audit.query': () => {
        throw new Error('The Bureau is down.');
      },
    });
    landAt('/settings/a2a');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    const failed = await view.findByTestId('a2a-calls-failed');

    expect(failed.textContent).toContain(A2A_COPY.recent.loadFailed.title);
  });
});

describe('the agents a disabled plugin holds back', () => {
  test('are listed after the agents that can run, each with a switch, and counted', async () => {
    const running = SAMPLE_AGENTS.slice(0, 6);
    const held = [
      ['demo:release-helper', 'release-helper'],
      ['demo:changelog-writer', 'changelog-writer'],
    ] as const;
    const served = servedSettings();
    stub = installSettingsBureau(served, {
      'bureau.agents.list': () => ({ agents: running }),
      'bureau.agents.definitions.list': () => ({
        agents: [
          ...running.map((agent) => ({
            id: agent.name,
            source: 'code',
            state: 'ready',
            unavailable: null,
            name: agent.displayName,
            description: null,
            a2a: false,
            hash: null,
            problem: null,
          })),
          ...held.map(([id, name]) => ({
            id,
            source: 'code',
            state: 'unavailable',
            unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
            name,
            description: null,
            a2a: false,
            hash: null,
            problem: null,
          })),
        ],
        nextOffset: null,
      }),
      'bureau.audit.query': () => ({ records: [], nextCursor: null }),
    });
    landAt('/settings/a2a');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    const switches = await view.findByTestId('a2a-agent-switches');
    await waitFor(() => expect(switches.querySelectorAll('li')).toHaveLength(8));
    expect([...switches.querySelectorAll('li')].map((item) => item.textContent?.trim())).toEqual([
      'Assistant',
      'Tool runner',
      'Request human input',
      'Echo',
      'Model switcher',
      'Workflow author',
      'Release helper',
      'Changelog writer',
    ]);
    expect(view.container.textContent).toContain('All eight agents are listed');

    // Sharing one is saved under the identifier the plugin's agent has once it is enabled.
    const releaseHelper = within(switches).getByRole('switch', { name: 'Release helper' });
    expect(releaseHelper.getAttribute('aria-disabled')).not.toBe('true');
    await fireEvent.click(releaseHelper);
    await waitUntil(() => (stub?.callsTo('bureau.settings.update').length ?? 0) === 1);
    expect(stub?.callsTo('bureau.settings.update')[0]?.params).toMatchObject({
      patch: { 'a2a.agents': { 'demo:release-helper': true } },
    });
  });
});
