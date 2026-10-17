/**
 * Primary COR-162 operator flow against the seeded real Weft server: open a
 * worker, then a registry entry, and read the contract verification status
 * the dashboard computes from the worker's accepted manifest and the active
 * registry snapshot.
 *
 * The seeded `e2e-fleet-worker-1` (`e2e-server.ts`) advertises
 * `order-processing` with `chargeCard` and `reserveInventory` and no
 * generated contract, so its revision and contract hash differ from the
 * registry's active revision, which also declares `sendConfirmationEmail`.
 * Its activity hashes are declared-shape placeholders, so each shared
 * activity's hash differs from the `sha256:` hash the registry's schema pair
 * produces, exactly as `weft worker verify` would report it. That drift is
 * the real state of the fixture, and the spec asserts it.
 *
 * The ledger-evidence worker (`ledger-evidence-seed.ts`, COR-124) also
 * serves `order-processing`, so a registry entry lists two drifting workers;
 * per-worker assertions are scoped to the fleet worker's own table.
 */
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './auth-fixtures.ts';

test('operator reads a worker’s contract verification status', async ({ page, checkA11y }) => {
  await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');

  const verification = page.getByRole('region', { name: 'Contract verification' });
  await expect(verification).toBeVisible();
  await expect(verification.getByText('Drift · manifest differs from registry')).toBeVisible();
  await expect(
    verification.getByText('Revision differs from the active registry revision'),
  ).toBeVisible();
  await expect(
    verification.getByText('Contract hash differs from the active registry revision'),
  ).toBeVisible();

  const activities = verification.getByRole('table', {
    name: 'order-processing activity verification',
  });
  await expect(
    activities.getByRole('row', { name: /sendConfirmationEmail Missing from worker/ }),
  ).toBeVisible();
  // Per-activity drift: the worker's hash and the registry's are both shown.
  await expect(
    activities.getByRole('row', {
      name: /^chargeCard Contract hash differs from registry declared-shape:\S+ sha256:[0-9a-f]{64}$/,
    }),
  ).toBeVisible();
  await expect(
    activities.getByRole('row', {
      name: /^reserveInventory Contract hash differs from registry declared-shape:\S+ sha256:[0-9a-f]{64}$/,
    }),
  ).toBeVisible();

  await expect(
    verification.getByText(
      /^weft worker verify --manifest checkout-worker-fleet-e2e-build-1\.manifest\.json --from registry-v\d+\.json$/,
    ),
  ).toBeVisible();
  await expect(
    verification.getByRole('button', { name: 'Copy weft worker verify command' }),
  ).toBeVisible();
  await expect(
    verification.getByRole('button', { name: 'Copy weft codegen command' }),
  ).toBeVisible();

  await checkA11y('workers — contract verification');
});

async function openRegistryVerification(page: Page): Promise<Locator> {
  await page.goto('/system?tab=registry');
  await page.getByRole('button', { name: /order-processing/ }).click();
  return page.getByRole('region', { name: 'Worker contract verification' });
}

test('operator reads every serving worker’s verification from a registry entry', async ({
  page,
  checkA11y,
}) => {
  const verification = await openRegistryVerification(page);
  await expect(verification).toBeVisible();
  await expect(verification.getByText('Drift · 2 of 2 workers')).toBeVisible();
  await expect(verification.getByText('checkout-worker-fleet · e2e-build-1')).toBeVisible();
  await expect(verification.getByText('ledger-evidence-fleet · e2e-ledger-build-1')).toBeVisible();
  const fleetActivities = verification.getByRole('table', {
    name: 'e2e-fleet-worker-1 order-processing activity verification',
  });
  await expect(
    fleetActivities.getByRole('row', { name: /^sendConfirmationEmail Missing from worker/ }),
  ).toBeVisible();
  await expect(
    fleetActivities.getByRole('row', { name: /^chargeCard Contract hash differs from registry/ }),
  ).toBeVisible();

  await checkA11y('system — registry contract verification');
});

/**
 * Failure states, each reached by answering one of the panel's two reads with
 * a JSON-RPC fault (or, for the malformed state, a result the Console's
 * validator rejects), so every notice is checked for text (not color alone)
 * and by `checkA11y`. Most answer the worker-manifest read; the permission
 * denial answers the registry read instead, because a 403 on the manifest read
 * also locks the whole Workers route behind `system:read`.
 */
const FAILURES = [
  {
    name: 'strict payload rejection',
    error: {
      code: -32602,
      message: 'Unprocessable',
      data: {
        httpStatus: 422,
        name: 'WorkerJsonValidationError',
        path: 'activity result.total',
        message: 'activity result.total: number must be finite',
      },
    },
    title: 'Strict payload boundary rejected a value',
  },
  {
    // No `WorkerJsonValidationError` name, so only the message matches the
    // strict-payload shape and the notice stays unconfirmed.
    name: 'unconfirmed strict payload rejection',
    error: {
      code: -32602,
      message: 'activity result.total: number must be finite',
      data: { httpStatus: 422 },
    },
    title: 'Possible strict payload rejection',
  },
  {
    name: 'contract mismatch',
    error: {
      code: -32000,
      message: 'Conflict',
      data: {
        httpStatus: 409,
        weftCode: 'Conflict',
        compatibilityReasons: ['contract-hash-mismatch'],
      },
    },
    title: 'Contract mismatch',
  },
  {
    name: 'server fault',
    error: {
      code: -32004,
      message: 'Worker manifest unavailable',
      data: { httpStatus: 404, weftCode: 'NotFound' },
    },
    title: 'Not found',
  },
  {
    name: 'permission denied',
    method: 'weft.system.registry',
    error: {
      code: -32003,
      message: 'Forbidden',
      data: { httpStatus: 403, weftCode: 'Forbidden' },
    },
    title: 'Permission denied',
  },
  {
    name: 'malformed response',
    result: { worker: 'not-a-worker-record' },
    title: 'Malformed server response',
    // An unclassified error is retried (three times, with backoff) before
    // the panel leaves its loading state.
    timeout: 20_000,
  },
] as const;

type JsonRpcReply = Readonly<{ error: unknown }> | Readonly<{ result: unknown }>;

async function answerJsonRpc(page: Page, method: string, reply: JsonRpcReply): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const request: unknown = route.request().postDataJSON();
    const body = request as { id?: unknown; method?: unknown } | null;
    if (body?.method !== method) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, ...reply }),
    });
  });
}

for (const failure of FAILURES) {
  test(`the ${failure.name} state reads in text and passes accessibility checks`, async ({
    page,
    checkA11y,
  }) => {
    await answerJsonRpc(
      page,
      'method' in failure ? failure.method : 'weft.workers.diagnostics',
      'error' in failure ? { error: failure.error } : { result: failure.result },
    );
    await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');

    const verification = page.getByRole('region', { name: 'Contract verification' });
    await expect(verification.getByText(failure.title, { exact: true })).toBeVisible(
      'timeout' in failure ? { timeout: failure.timeout } : {},
    );
    await expect(verification.getByText('Verified · manifest matches registry')).toHaveCount(0);

    await checkA11y(`workers — contract verification ${failure.name}`);
  });
}

const SURFACES = [
  {
    name: 'worker detail',
    verdict: 'Drift · manifest differs from registry',
    open: async (page: Page): Promise<Locator> => {
      await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');
      return page.getByRole('region', { name: 'Contract verification' });
    },
  },
  { name: 'registry detail', verdict: 'Drift · 2 of 2 workers', open: openRegistryVerification },
] as const;

for (const surface of SURFACES) {
  test(`${surface.name} contract verification remains usable across supported widths and themes`, async ({
    page,
  }) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [
        { width: 375, height: 812 },
        { width: 768, height: 1024 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem('weft-ui-theme', selectedTheme);
        }, theme);

        const verification = await surface.open(page);
        await expect(verification).toBeVisible();
        await expect(verification.getByText(surface.verdict)).toBeVisible();
        await expect(verification.getByText('Missing from worker').first()).toBeVisible();
        const copy = verification.getByRole('button', { name: 'Copy weft worker verify command' });
        await copy.focus();
        await expect(copy).toBeFocused();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
  });
}
