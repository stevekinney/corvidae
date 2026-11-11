/**
 * `/settings/data-and-retention` (board PageSettingsSections, "Data and retention"; rows 50d to
 * 50g and the field error of 50i): four retention rows that each choose between Keep forever and
 * Delete after a number of days, a Storage section with one read-only row, and the saves each row
 * makes through `bureau.settings.update`. The Bureau is a stub.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { DATA_RETENTION_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';

const DAY = 86_400_000;

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

type Open = {
  values?: Record<string, unknown>;
  locked?: readonly string[];
  alerts?: readonly object[];
  sizeBytes?: number | null;
  /** Answers `/host/clean-up`. Left out, the host does not say. */
  cleanUp?: (method: 'GET' | 'POST') => Response | Promise<Response>;
};

function open({ values, locked, alerts = [], sizeBytes, cleanUp }: Open = {}) {
  const served = servedSettings({
    values: { ...servedSettings().values, ...values },
    ...(locked === undefined ? {} : { locked: new Set(locked) }),
  });
  stub = installSettingsBureau(
    served,
    { 'bureau.health.attention': () => ({ items: alerts, count: alerts.length, checks: [] }) },
    undefined,
    undefined,
    sizeBytes,
    cleanUp,
  );
  landAt('/settings/data-and-retention');
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

const rowOf = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-setting="${key}"]`);

async function rowReady(view: ReturnType<typeof open>['view'], key: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = rowOf(view.container, key);
    expect(found).not.toBeNull();
    return found!;
  });
}

const updates = () => stub?.callsTo('bureau.settings.update') ?? [];

const choiceOf = (row: HTMLElement, name: string) => within(row).getByRole('radio', { name });

describe('Settings › Data and retention', () => {
  test('is the heading and the intro, then Retention with its four rows and Storage', async () => {
    const { view } = open();

    expect(
      await view.findByRole('heading', { level: 1, name: 'Data and retention' }),
    ).not.toBeNull();
    expect(view.getByText(DATA_RETENTION_COPY.intro)).not.toBeNull();
    const group = await view.findByRole('group', { name: SETTINGS_COPY.formLabel });
    const headings = within(group)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.slice(0, 1)).toEqual(['Retention']);
    expect(headings.slice(-2)).toEqual(['Storage', 'Clean-up']);
    const keys = [...group.querySelectorAll<HTMLElement>('[data-setting]')].map(
      (entry) => entry.dataset['setting'],
    );
    expect(keys.slice(0, 4)).toEqual([
      'retention.audit',
      'retention.runs',
      'retention.chats',
      'retention.memory',
    ]);
    expect(keys.at(-2)).toBe('storage-usage');
    expect(keys.at(-1)).toBe('clean-up');
  });

  test('a window nothing stored shows the one in force, so thirty days do not read as forever', async () => {
    const served = servedSettings({
      effective: { 'retention.notifications': { olderThan: 30 * DAY } },
    });
    stub = installSettingsBureau(served, {
      'bureau.health.attention': () => ({ items: [], count: 0, checks: [] }),
    });
    landAt('/settings/data-and-retention');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    const row = await rowReady(view, 'retention.notifications');
    expect(choiceOf(row, 'Delete after').getAttribute('aria-checked')).toBe('true');
    expect((within(row).getByRole('spinbutton') as HTMLInputElement).value).toBe('30');
  });

  test('every row has a sentence-case name with its raw key beside it, and the Bureau’s description', async () => {
    const { view } = open();
    const expected = [
      [
        'retention.audit',
        'Audit records',
        'How long audit records are kept before they are deleted.',
      ],
      [
        'retention.runs',
        'Run history',
        'How long finished runs and their steps are kept. Deleting a run removes its page; a link to it then says the run doesn’t exist.',
      ],
      ['retention.chats', 'Chats', 'How long chats are kept after their last message.'],
      ['retention.memory', 'Memory', 'Memories an agent saved. Agents can correct them.'],
    ] as const;
    for (const [key, label, description] of expected) {
      const row = await rowReady(view, key);
      expect(row.textContent).toContain(label);
      expect(row.querySelector('.cinder-setting-row__identifier')?.textContent).toBe(key);
      expect(row.textContent).toContain(description);
      // Memory deletes while unset, so it has no choice to make: no segmented control at all, only
      // the days (decisions, B11 after round 3).
      if (key === 'retention.memory') {
        expect(within(row).queryByRole('radio')).toBeNull();
        expect(within(row).getByRole('spinbutton')).not.toBeNull();
      } else {
        expect(choiceOf(row, 'Keep forever')).not.toBeNull();
        expect(choiceOf(row, 'Delete after')).not.toBeNull();
      }
    }
  });

  test('a window shows Delete after and its days, and one that keeps for ever shows no days', async () => {
    const { view } = open({ values: { 'retention.audit': { olderThan: 90 * DAY } } });

    const audit = await rowReady(view, 'retention.audit');
    expect(choiceOf(audit, 'Delete after').getAttribute('aria-checked')).toBe('true');
    expect((within(audit).getByRole('spinbutton') as HTMLInputElement).value).toBe('90');
    expect(audit.textContent).toContain('days');

    const runs = await rowReady(view, 'retention.runs');
    expect(choiceOf(runs, 'Keep forever').getAttribute('aria-checked')).toBe('true');
    expect(within(runs).queryByRole('spinbutton')).toBeNull();
  });

  test('choosing Delete after only opens the days field; nothing is saved until days are typed', async () => {
    const { view, served } = open();
    const runs = await rowReady(view, 'retention.runs');

    await fireEvent.click(choiceOf(runs, 'Delete after'));
    const days = (await within(runs).findByRole('spinbutton')) as HTMLInputElement;
    expect(days.value).toBe('');
    expect(updates()).toHaveLength(0);

    await fireEvent.input(days, { target: { value: '30' } });
    await fireEvent.blur(days);
    await fireEvent.focusOut(days);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'retention.runs': { olderThan: 30 * DAY } });
    expect(served.values['retention.runs']).toEqual({ olderThan: 30 * DAY });
    await waitFor(() => expect(runs.textContent).toContain('Saved just now'));
    expect(view.getByTestId('settings-header-status').textContent).toContain('Saved just now');
  });

  test('leaving Delete after with no days typed leaves the row as it was', async () => {
    const { view } = open();
    const chats = await rowReady(view, 'retention.chats');

    await fireEvent.click(choiceOf(chats, 'Delete after'));
    const days = (await within(chats).findByRole('spinbutton')) as HTMLInputElement;
    await fireEvent.blur(days);
    await fireEvent.focusOut(days);

    await waitFor(() => expect(within(chats).queryByRole('spinbutton') === null).toBe(true));
    expect(choiceOf(chats, 'Keep forever').getAttribute('aria-checked')).toBe('true');
    expect(updates()).toHaveLength(0);
  });

  test('choosing Keep forever saves forever, and for a window kept while unset, which has no such value, clears it', async () => {
    const { view, served } = open({
      values: {
        'retention.audit': { olderThan: 90 * DAY },
        'retention.logs': { olderThan: 30 * DAY },
      },
    });

    await fireEvent.click(choiceOf(await rowReady(view, 'retention.audit'), 'Keep forever'));
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'retention.audit': 'forever' });

    // Unset, the Bureau keeps a finished run's log lines until the run is purged.
    await fireEvent.click(choiceOf(await rowReady(view, 'retention.logs'), 'Keep forever'));
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()[1]?.params['patch']).toEqual({ 'retention.logs': null });
    expect(served.values['retention.logs']).toBeUndefined();
  });

  test('Memory draws the days alone, no one-segment control, shows the 90 days in force while unset, and never saves a cleared value', async () => {
    const { view, served } = open();
    const memory = await rowReady(view, 'retention.memory');

    expect(within(memory).queryByRole('radio')).toBeNull();
    expect(within(memory).queryByRole('radiogroup')).toBeNull();
    expect((within(memory).getByRole('spinbutton') as HTMLInputElement).value).toBe('90');
    expect(served.values['retention.memory']).toBeUndefined();

    // Leaving the field writes nothing; typing days saves a window, never a null patch.
    const days = within(memory).getByRole('spinbutton') as HTMLInputElement;
    await fireEvent.focusOut(days);
    expect(updates()).toHaveLength(0);
    await fireEvent.input(days, { target: { value: '30' } });
    await fireEvent.blur(days);
    await fireEvent.focusOut(days);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({ 'retention.memory': { olderThan: 30 * DAY } });
    expect(
      updates().some(
        (call) => (call.params['patch'] as Record<string, unknown>)['retention.memory'] === null,
      ),
    ).toBe(false);
  });

  test('Receipts draws the days alone, so no click can clear it back to its one-week default', async () => {
    const { view, served } = open({ values: { 'retention.receipts': { olderThan: 30 * DAY } } });
    const receipts = await rowReady(view, 'retention.receipts');

    expect(within(receipts).queryByRole('radio')).toBeNull();
    expect(within(receipts).queryByRole('radiogroup')).toBeNull();
    expect((within(receipts).getByRole('spinbutton') as HTMLInputElement).value).toBe('30');
    expect(
      updates().filter((call) => 'retention.receipts' in (call.params['patch'] as object)),
    ).toHaveLength(0);
    expect(served.values['retention.receipts']).toEqual({ olderThan: 30 * DAY });

    // Leaving the days alone writes nothing; typing new ones saves a window, never a clear.
    const days = within(receipts).getByRole('spinbutton') as HTMLInputElement;
    await fireEvent.input(days, { target: { value: '14' } });
    await fireEvent.blur(days);
    await fireEvent.focusOut(days);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]?.params['patch']).toEqual({
      'retention.receipts': { olderThan: 14 * DAY },
    });
  });

  test('a number of days outside 1 to 3650 fails at the field and nothing is saved', async () => {
    const { view } = open({ values: { 'retention.runs': { olderThan: 30 * DAY } } });
    const runs = await rowReady(view, 'retention.runs');
    const days = within(runs).getByRole('spinbutton') as HTMLInputElement;

    await fireEvent.input(days, { target: { value: '9999' } });
    await fireEvent.blur(days);
    await fireEvent.focusOut(days);

    await waitFor(() =>
      expect(runs.textContent).toContain('Enter a number from 1 to 3650. Nothing was saved.'),
    );
    expect(days.getAttribute('aria-invalid')).toBe('true');
    expect(updates()).toHaveLength(0);
  });

  test('a setting the deployment locked cannot be changed', async () => {
    const { view } = open({ locked: ['retention.audit'] });
    const audit = await rowReady(view, 'retention.audit');

    expect(choiceOf(audit, 'Keep forever').getAttribute('aria-disabled')).toBe('true');
    expect(choiceOf(audit, 'Delete after').getAttribute('aria-disabled')).toBe('true');
  });

  test('the windows the board draws no row for follow the four', async () => {
    const { view } = open();
    await rowReady(view, 'retention.memory');
    const keys = [...view.container.querySelectorAll<HTMLElement>('[data-setting]')].map(
      (entry) => entry.dataset['setting'],
    );
    expect(keys.slice(4)).toContain('retention.events');
    expect(keys.indexOf('retention.events')).toBeLessThan(keys.indexOf('storage-usage'));
  });
});

describe('Settings › Data and retention › Storage', () => {
  const FIRING = {
    kind: 'alert',
    area: 'storage',
    at: 1,
    metric: 'storage.size',
    currentValue: 1_717_986_918,
    threshold: 1_073_741_824,
  };

  test('with a storage alert firing it reads the warning and the size, and links to Health', async () => {
    const { view } = open({ alerts: [FIRING], sizeBytes: 5 });
    const row = await rowReady(view, 'storage-usage');

    await waitFor(() =>
      expect(row.textContent).toContain('Storage is over its warning level, 1.6 GB'),
    );
    expect(row.textContent).toContain('Space used');
    expect(row.textContent).toContain('Health lists this under Needs attention.');
    expect(within(row).getByRole('link', { name: 'Open Health' }).getAttribute('href')).toBe(
      '/health',
    );
    expect(row.querySelector('[data-cinder-status="warning"]')).not.toBeNull();
  });

  test('draws no meter, capacity or warning-level row', async () => {
    const { view } = open({ alerts: [FIRING] });
    const row = await rowReady(view, 'storage-usage');

    expect(within(row).queryByRole('meter')).toBeNull();
    expect(within(row).queryByRole('progressbar')).toBeNull();
    expect(view.container.textContent).not.toContain('Warn at');
    expect(view.container.textContent).not.toContain('Capacity');
  });

  test('with no rule watching it, it reads the plain size and no warning dot', async () => {
    const { view } = open({ sizeBytes: 1_717_986_918 });
    const row = await rowReady(view, 'storage-usage');

    await waitFor(() => expect(within(row).getByTestId('storage-size').textContent).toBe('1.6 GB'));
    expect(row.querySelector('[data-cinder-status]')).toBeNull();
    expect(row.textContent).not.toContain('Open Health');
  });

  test('a host that cannot say how large the storage is says so', async () => {
    const { view } = open({ sizeBytes: null });
    const row = await rowReady(view, 'storage-usage');

    await waitFor(() =>
      expect(within(row).getByTestId('storage-size').textContent).toBe('Not reported yet'),
    );
  });
});

describe('Settings › Data and retention › Clean-up', () => {
  const STANDING = {
    schedule: { hour: 3, minute: 0, timeZone: 'America/Chicago' },
    last: null,
    skipped: null,
    nextAt: new Date(Date.now() + DAY).toISOString(),
  };
  const RUN = {
    at: new Date().toISOString(),
    trigger: 'manual',
    removed: 31,
    byKind: {
      audit: 31,
      reviews: 0,
      memories: 0,
      logs: 0,
      notifications: 0,
      hookDeliveries: 0,
      chats: 0,
    },
    failed: [],
  };

  /** A host that reports `standing` and answers a clean-up with `run`, counting the clean-ups. */
  function host(standing: object = STANDING, run: () => Response = () => Response.json(RUN)) {
    const cleanedUp: string[] = [];
    return {
      cleanedUp,
      answer: (method: 'GET' | 'POST'): Response => {
        if (method === 'GET') return Response.json(standing);
        cleanedUp.push(method);
        return run();
      },
    };
  }

  const buttonOf = (row: HTMLElement) => within(row).getByRole('button', { name: 'Clean up now' });

  test('is a section of its own with one row, whose action is a button on the row and not on the page', async () => {
    const { view } = open({ cleanUp: host().answer });
    const row = await rowReady(view, 'clean-up');

    const headings = within(view.container)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.at(-1)).toBe('Clean-up');
    expect(row.textContent).toContain('Remove expired records');
    await waitFor(() =>
      expect(row.textContent).toContain(
        'Interborough does this every night at 3:00 AM Central time.',
      ),
    );
    expect(buttonOf(row)).not.toBeNull();
    // Nothing on the page, outside the row, is a Clean up now.
    expect(within(view.container).getAllByRole('button', { name: 'Clean up now' })).toHaveLength(1);
  });

  test('says the last clean-up and the night the host was off for', async () => {
    const { view } = open({
      cleanUp: host({
        ...STANDING,
        last: { ...RUN, at: new Date(Date.now() - 3 * DAY).toISOString(), trigger: 'nightly' },
        skipped: { at: new Date().toISOString() },
      }).answer,
    });
    const row = await rowReady(view, 'clean-up');

    await waitFor(() => expect(row.textContent).toContain('Last cleaned up'));
    expect(row.textContent).toContain('Skipped');
    expect(row.textContent).toContain('while Interborough was off.');
  });

  test('Clean up now reports on its own row what was removed, and the button stays', async () => {
    const served = host();
    const { view } = open({ cleanUp: served.answer });
    const row = await rowReady(view, 'clean-up');
    await waitFor(() => expect(row.textContent).toContain('every night at 3:00 AM'));

    await fireEvent.click(buttonOf(row));

    await waitFor(() =>
      expect(row.textContent).toContain('Cleaned up just now. Removed 31 records.'),
    );
    expect(served.cleanedUp).toEqual(['POST']);
    // The description is the schedule alone now; the result carries the rest.
    expect(row.textContent).toContain(
      'Interborough does this every night at 3:00 AM Central time.',
    );
    expect(row.textContent).not.toContain('Last cleaned up');
    expect(buttonOf(row).hasAttribute('disabled')).toBe(false);
    // It does not write a setting.
    expect(updates()).toEqual([]);
  });

  test('can be pressed again, and reports the new result', async () => {
    const counts = [31, 2];
    const served = host(STANDING, () => Response.json({ ...RUN, removed: counts.shift() ?? 0 }));
    const { view } = open({ cleanUp: served.answer });
    const row = await rowReady(view, 'clean-up');

    await fireEvent.click(buttonOf(row));
    await waitFor(() => expect(row.textContent).toContain('Removed 31 records.'));
    await fireEvent.click(buttonOf(row));
    await waitFor(() => expect(row.textContent).toContain('Removed 2 records.'));
    expect(served.cleanedUp).toHaveLength(2);
  });

  test('a clean-up the host refuses says so on the row, with a way to try again', async () => {
    let refuse = true;
    const served = host(STANDING, () =>
      refuse ? new Response('No', { status: 500 }) : Response.json(RUN),
    );
    const { view } = open({ cleanUp: served.answer });
    const row = await rowReady(view, 'clean-up');

    await fireEvent.click(buttonOf(row));
    await waitFor(() =>
      expect(row.textContent).toContain('Couldn’t clean up. Nothing was removed.'),
    );

    refuse = false;
    await fireEvent.click(within(row).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(row.textContent).toContain('Cleaned up just now. Removed 31 records.'),
    );
  });

  test('a clean-up that could not remove one kind says which', async () => {
    const served = host(STANDING, () => Response.json({ ...RUN, removed: 4, failed: ['chats'] }));
    const { view } = open({ cleanUp: served.answer });
    const row = await rowReady(view, 'clean-up');

    await fireEvent.click(buttonOf(row));

    await waitFor(() =>
      expect(row.textContent).toContain(
        'Cleaned up just now, but chats could not be removed. Removed 4 records.',
      ),
    );
  });
});
