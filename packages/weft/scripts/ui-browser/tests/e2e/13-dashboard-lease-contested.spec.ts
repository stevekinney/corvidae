/**
 * COR-124: the Dashboard's "Engine lease contested" chip.
 *
 * The E2E server's `Engine.create({ workflows })` runs without an ownership
 * lease, so `weft.system.lease` truthfully reports `disabled`; deposing a
 * real lease holder would stop the shared engine every other spec depends on.
 * This spec therefore uses the suite's existing response-control mechanism
 * (`page.route('**\/jsonrpc')`, as in `09-preload-dynamic-source.spec.ts`):
 * the real `weft.system.lease` JSON-RPC request still reaches the server, and
 * only its `result` is replaced with a contested reading in the operation's
 * exact output shape. Every other JSON-RPC call passes through untouched.
 */
import type { Page, Route } from '@playwright/test';

import { expect, test } from './auth-fixtures.ts';

const CONTESTED_LEASE = {
  mode: 'lease',
  status: 'contested',
  holdsLease: false,
  holderId: 'engine-e2e-deposed',
  heldSince: 1_700_000_000_000,
  lastRenewedAt: 1_700_000_030_000,
  fencingEpoch: 4,
  lossReason: 'deposed',
} as const;

const CHIP_LABEL = 'Engine lease contested · deposed';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
}

function asMessages(value: unknown): JsonRpcMessage[] {
  return (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is JsonRpcMessage => typeof entry === 'object' && entry !== null,
  );
}

async function contestLease(route: Route): Promise<void> {
  const requestBody = route.request().postData() ?? '';
  if (!requestBody.includes('weft.system.lease')) {
    await route.continue();
    return;
  }
  const leaseIds = new Set(
    asMessages(JSON.parse(requestBody))
      .filter((message) => message.method === 'weft.system.lease')
      .map((message) => message.id),
  );
  const response = await route.fetch();
  const payload: unknown = await response.json();
  const rewrite = (message: JsonRpcMessage) =>
    leaseIds.has(message.id) && 'result' in message
      ? { ...message, result: CONTESTED_LEASE }
      : message;
  const body = Array.isArray(payload)
    ? asMessages(payload).map(rewrite)
    : rewrite(asMessages(payload)[0] ?? {});
  await route.fulfill({ response, json: body });
}

async function contestLeaseResponses(page: Page): Promise<void> {
  await page.route('**/jsonrpc', contestLease);
}

test('a contested engine lease raises a labeled dashboard chip that links to lease health', async ({
  page,
  checkA11y,
}) => {
  await contestLeaseResponses(page);
  await page.goto('/');

  const chip = page.getByRole('link', { name: CHIP_LABEL });
  await expect(chip).toBeVisible();
  // Tone is decoration; the label alone says what is wrong.
  await expect(chip).toHaveAttribute('data-tone', 'danger');
  await checkA11y('dashboard—engine lease contested');

  await chip.click();
  await expect(page).toHaveURL(/\/system\?tab=health/);
  await expect(page.getByText('Contested', { exact: true }).first()).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the lease contested chip fits every supported width in the ${theme} theme`, async ({
    page,
    checkA11y,
  }) => {
    await contestLeaseResponses(page);
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('weft-ui-theme', selectedTheme);
    }, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const label = `dashboard lease chip (${theme}, ${viewport.width}px)`;
      const chip = page.getByRole('link', { name: CHIP_LABEL });
      await expect(chip).toBeVisible();
      const chipOverflow = await chip.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(chipOverflow, `${label} chip overflows`).toBeLessThanOrEqual(0);
      const box = await chip.boundingBox();
      expect(box, `${label} chip box`).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0), `${label} chip right edge`).toBeLessThanOrEqual(
        viewport.width,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} page width`,
      ).toBe(true);
      await checkA11y(label);
    }
  });
}
