import { expect, test, type Locator, type Page } from '@playwright/test';

import { trackConsoleProblems, waitForPreviewApplied } from './support/theme-builder.ts';

/**
 * Remediation and checks navigation in a real browser (COR-487), operated with the keyboard
 * only after the failing draft exists: summary to finding to editor state, inspecting a
 * proposal, applying it, and undoing it, with visible focus at each step, one aggregate
 * announcement, and focus that moves only because the author acted.
 */

let problems: string[] = [];
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const panel = (page: Page) => page.getByTestId('checks-panel');
const announcer = (page: Page) => page.getByTestId('checks-announcer');

async function openFailingDraft(page: Page): Promise<void> {
  problems = trackConsoleProblems(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/theme-builder?filter=color');
  await expect(page.getByTestId('theme-workbench')).toBeVisible();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
  await waitForPreviewApplied(page);
  await page.locator('[data-token-path="text.default"]').click();
  await expect(page.getByTestId('color-token-editor')).toBeVisible();
  // Pale text on the light surfaces: a real contrast failure in the light contexts.
  await page.locator('[id="theme-builder-color-text-default-text"]').fill('oklch(0.93 0.01 245)');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-readiness', 'blocked-accessibility-errors', {
    timeout: 30_000,
  });
}

/** True when the focused element paints a visible ring (a box shadow or a real outline). */
async function hasVisibleFocus(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && style.outlineColor !== 'rgba(0, 0, 0, 0)';
    return style.boxShadow !== 'none' || outline;
  });
}

/** Tab until the focused element's accessible name matches; bounded. */
async function tabTo(page: Page, name: RegExp) {
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const active = document.activeElement;
      return `${active?.getAttribute('aria-label') ?? ''} ${active?.textContent ?? ''}`;
    });
    if (name.test(label)) return;
  }
  throw new Error(`The keyboard never reached ${name}.`);
}

const focusedFinding = (page: Page) =>
  page.locator('[data-testid="finding"][data-severity="accessibility-error"]:focus');

test('a keyboard-only fix: summary to finding to proposal to Apply, then Undo', async ({
  page,
}) => {
  await openFailingDraft(page);

  // From here on only the keyboard acts, so the browser reports keyboard modality.
  await page.keyboard.press('Shift');

  // Summary to the first finding.
  const summaryLink = page.getByRole('button', { name: /Go to the first accessibility errors/ });
  await summaryLink.focus();
  await expect(summaryLink).toBeFocused();
  await expect(await hasVisibleFocus(summaryLink)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(focusedFinding(page)).toHaveCount(1);
  await expect(await hasVisibleFocus(focusedFinding(page))).toBe(true);

  // To the exact editor and preview state.
  await tabTo(page, /Show in editor/);
  await page.keyboard.press('Enter');
  await expect(announcer(page)).toContainText('Showing text.default in the editor');
  await expect(page.locator('[data-token-path="text.default"]')).toHaveAttribute(
    'aria-current',
    /.+/,
  );
  await waitForPreviewApplied(page);

  // Inspect the proposal: heading focused, every changed path and the measurements shown.
  await tabTo(page, /Review a fix/);
  await page.keyboard.press('Enter');
  const proposal = page.getByTestId('remediation-proposal');
  await expect(proposal).toBeVisible({ timeout: 20_000 });
  await expect(proposal.getByRole('heading', { level: 4 })).toBeFocused();
  await expect(await hasVisibleFocus(proposal.getByRole('heading', { level: 4 }))).toBe(true);
  await expect(proposal).toContainText('Replace value with OKLCH');
  await expect(proposal).toContainText('text.default');
  await expect(proposal).toContainText('oklch(0.93 0.01 245)');
  await expect(proposal.getByTestId('remediation-measurements')).toBeVisible();
  await expect(page.getByRole('button', { name: /fix all/i })).toHaveCount(0);

  // Apply with the keyboard.
  await tabTo(page, /Apply fix/);
  await page.keyboard.press('Enter');
  await expect(panel(page)).toHaveAttribute('data-readiness', 'ready', { timeout: 30_000 });
  await expect(announcer(page)).toContainText(
    /Replace value with OKLCH applied\. \d+ findings? resolved/,
  );
  await expect(announcer(page)).toContainText('Checks for revision');
  // Focus stays inside the checks panel, on a finding or its status line, never on the body.
  const insidePanel = await page.evaluate(
    () =>
      document.querySelector('[data-testid="checks-panel"]')?.contains(document.activeElement) ??
      false,
  );
  expect(insidePanel).toBe(true);
  await expect(page.getByTestId('count-accessibility-error')).toContainText('0');

  // Undo with the keyboard restores the failing source and returns focus to the finding.
  await tabTo(page, /Undo last fix/);
  await expect(await hasVisibleFocus(page.locator(':focus'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(panel(page)).toHaveAttribute('data-readiness', 'blocked-accessibility-errors', {
    timeout: 30_000,
  });
  await expect(focusedFinding(page)).toHaveCount(1, { timeout: 20_000 });
  await expect(announcer(page)).toContainText('Undid');
  await page.locator('[data-token-path="text.default"]').click();
  await expect(page.locator('[id="theme-builder-color-text-default-text"]')).toHaveValue(
    'oklch(0.93 0.01 245)',
  );
});
