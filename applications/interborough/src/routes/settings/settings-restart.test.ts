/**
 * Restarting from `/settings` (`shell:restart-flow`): the summary of the settings that wait for a
 * restart offers Restart now, which asks first, restarts the host, and, once the host reports
 * nothing waiting, says what applied. The Bureau is a stub (`settings-fixtures.test-support.ts`) and
 * the host's restart route is layered over it; the real route is exercised by
 * `src/host/host-plugins.test.ts`.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { RESTART_COPY } from '../../app/copy.ts';
import { restartProbing } from '../../app/restart/host-restart-flow.svelte.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';
import { settingLabel } from './settings-controls.ts';
import {
  installSettingsBureau,
  servedSettings,
  type SettingsServed,
} from './settings-fixtures.test-support.ts';

const KEY = 'engine.workflowClaimRenewInterval';

let stub: BureauStub | undefined;
let restoreFetch: (() => void) | undefined;
const probing = { ...restartProbing };

beforeEach(() => {
  restartProbing.delayMs = 0;
  restartProbing.retryDelayMs = () => 0;
});

afterEach(() => {
  cleanup();
  restoreFetch?.();
  restoreFetch = undefined;
  stub?.restore();
  stub = undefined;
  Object.assign(restartProbing, probing);
});

/** How the host behaves when it is asked to restart. */
type HostBehaviour = {
  /** Reads of the settings that fail after the restart before the host answers again. */
  downFor: number;
  /** The command the host says it was launched with. */
  launch: string;
};

function open(served: SettingsServed, behaviour: Partial<HostBehaviour> = {}) {
  const hostBehaviour: HostBehaviour = { downFor: 2, launch: 'bun run start', ...behaviour };
  let down = 0;
  let restarting = false;
  const requests: string[] = [];
  stub = installSettingsBureau(served, {
    'bureau.settings.get': () => {
      if (restarting && down < hostBehaviour.downFor) {
        down += 1;
        throw new TypeError('Failed to fetch');
      }
      if (restarting) {
        // The host started again: what was stored is what runs.
        restarting = false;
        served.pendingRestart.clear();
      }
      return {
        values: served.values,
        effective: { ...served.values },
        running: { ...served.values },
        revision: served.revision,
        persisted: served.persisted,
        keys: Object.fromEntries(
          Object.keys(served.values).map((key) => [
            key,
            {
              apply: key === KEY ? 'restart' : 'live',
              locked: false,
              pendingRestart: served.pendingRestart.has(key),
            },
          ]),
        ),
      };
    },
  });
  const underneath = globalThis.fetch;
  restoreFetch = installFetchImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    if (url.pathname !== '/host/restart') return underneath(input, init);
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    if (method === 'GET') {
      return Response.json({
        available: true,
        launch: { command: hostBehaviour.launch, directory: '/home/steve/app' },
      });
    }
    restarting = true;
    return Response.json({ restarting: true }, { status: 202 });
  });
  landAt('/settings');
  const view = render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  return { view, requests };
}

/**
 * The open dialog that says `text`. A role query would walk the whole settings form, which is
 * slow; the dialog is the one `<dialog>` that is open.
 */
async function openDialog(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = [...document.body.querySelectorAll<HTMLElement>('dialog[open]')].find((dialog) =>
      dialog.textContent?.includes(text),
    );
    expect(found === undefined).toBe(false);
    return found!;
  });
}

describe('settingLabel', () => {
  test('words a key as a person reads it', () => {
    expect(settingLabel(KEY)).toBe('Workflow claim renew interval');
    expect(settingLabel('durable')).toBe('Durable');
    expect(settingLabel('tools.humanInput')).toBe('Human input');
  });
});

describe('Restart now on Settings', () => {
  test('asks first, restarts the host, and says what applied once nothing waits for a restart', async () => {
    const served = servedSettings({ pendingRestart: new Set([KEY]) });
    const { view, requests } = open(served);
    const summary = await view.findByTestId('settings-restart-summary');

    await fireEvent.click(within(summary).getByRole('button', { name: 'Restart now' }));
    const question = await openDialog(RESTART_COPY.confirm.title);
    expect(question.textContent).toContain(RESTART_COPY.confirm.description(1));
    // Nothing has been asked of the host yet.
    expect(requests).toEqual([]);
    await fireEvent.click(
      within(question).getByRole('button', { name: RESTART_COPY.confirm.confirm }),
    );

    const back = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-testid="restart-back"]');
      expect(found === null).toBe(false);
      return found!;
    });
    expect(requests).toEqual(['GET /host/restart', 'POST /host/restart']);
    expect(back.textContent).toContain('Back up');
    expect(back.textContent).toContain(
      '1 change applied: Workflow claim renew interval. Running work picked up where it stopped; reviews stayed waiting.',
    );
    // Nothing waits any more, so the summary is gone, and the dialog with it.
    await waitFor(() =>
      expect(
        view.container.querySelector('[data-testid="settings-restart-summary"]') === null,
      ).toBe(true),
    );
    expect(document.body.querySelector('dialog[open]')).toBeNull();
    // The row that waited now says since when it has been in effect (row 48b).
    const status = () =>
      view.container
        .querySelector(`[data-setting="${KEY}"] .cinder-setting-row__status`)
        ?.textContent?.trim() ?? '';
    await waitFor(() => expect(status()).toMatch(/^In effect since \d{1,2}:\d{2} (AM|PM)$/));

    await fireEvent.click(within(back).getByRole('button', { name: RESTART_COPY.back.dismiss }));
    await waitFor(() =>
      expect(view.container.querySelector('[data-testid="restart-back"]') === null).toBe(true),
    );
  });

  test('shows the failed state when the host does not answer, with the command and Keep waiting', async () => {
    const served = servedSettings({ pendingRestart: new Set([KEY]) });
    const { view } = open(served, { downFor: 1_000 });
    const summary = await view.findByTestId('settings-restart-summary');
    await fireEvent.click(within(summary).getByRole('button', { name: 'Restart now' }));
    const question = await openDialog(RESTART_COPY.confirm.title);
    await fireEvent.click(
      within(question).getByRole('button', { name: RESTART_COPY.confirm.confirm }),
    );

    const card = await waitFor(() => {
      const found = document.body.querySelector<HTMLElement>(
        '.cinder-restart-state__card[data-cinder-phase="failed"]',
      );
      expect(found === null).toBe(false);
      return found!;
    });
    expect(card.textContent).toContain(RESTART_COPY.failed.description(1, undefined));
    expect(card.textContent).toContain(RESTART_COPY.failed.check);
    expect(card.querySelector('.cinder-restart-state__command-text')?.textContent).toBe(
      'bun run start',
    );
    expect(within(card).getByRole('button', { name: 'Keep waiting' })).not.toBeNull();
    expect(within(card).queryByRole('button', { name: /restart/i })).toBeNull();
  });
});
