import { expect, test, type Page } from '@playwright/test';

import { openBuilder, selectContext, trackConsoleProblems } from './support/theme-builder.ts';

/**
 * The foundation editors in a real browser: dimension, font family, font weight, number,
 * duration and cubic-bezier tokens, the spacing and radius scales and type specimen, the
 * Compact, Standard and Comfortable presets, motion contexts, and keyboard-only operation.
 */

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
  await openBuilder(page, { width: 1440, height: 900 });
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const id = (path: string) => path.replaceAll('.', '-');
const field = (page: Page, path: string, part = 'amount') =>
  page.locator(`#theme-builder-foundation-${id(path)}-${part}`);
const apply = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true });
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

async function select(page: Page, path: string): Promise<void> {
  await page.locator(`[data-token-path="${path}"]`).click();
  await expect(page.getByTestId('selected-token-path')).toHaveText(path);
  await expect(page.getByTestId('foundation-token-editor')).toBeVisible();
}

const frameVar = (page: Page, name: string) =>
  page.evaluate(
    (property) =>
      (
        document.querySelector('iframe') as HTMLIFrameElement
      ).contentDocument!.documentElement.style.getPropertyValue(property),
    name,
  );

test.describe('dimension tokens', () => {
  test('a numeric field with a px/rem unit edits the token and previews the scale', async ({
    page,
  }) => {
    await select(page, 'space.2');
    await expect(page.getByTestId('scale-preview').last()).toBeVisible();
    await expect(page.locator('[data-testid="token-preview"] [aria-current="true"]')).toContainText(
      'Space 2',
    );
    await field(page, 'space.2', 'unit').selectOption('px');
    await field(page, 'space.2').fill('12');
    await apply(page).click();
    await expect(page.getByTestId('draft-value')).toHaveText('12px');
    await expect.poll(() => frameVar(page, '--cinder-space-2')).toBe('12px');
    // The scale keeps its Cinder names.
    await expect(page.getByTestId('foundations-spacing')).toContainText('Space one');
    await expect(page.getByTestId('foundations-spacing')).not.toContainText('p-1');
  });

  test('partial and invalid input stays visible and flagged, and the preview keeps the last valid value', async ({
    page,
  }) => {
    await select(page, 'space.2');
    const before = await frameVar(page, '--cinder-space-2');
    for (const text of ['-', '1.2.3', '-4']) {
      await field(page, 'space.2').fill(text);
      await expect(field(page, 'space.2')).toHaveValue(text);
      await expect(field(page, 'space.2')).toHaveAttribute('aria-invalid', 'true');
    }
    await apply(page).click();
    await expect(field(page, 'space.2')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('stale-preview')).toBeVisible();
    expect(await frameVar(page, '--cinder-space-2')).toBe(before);
    await expect(page.getByTestId('preview-value')).toHaveText('0.5rem');
  });
});

test.describe('number, weight and bezier tokens', () => {
  test('opacity is bounded at 0 to 1 and its slider has a numeric twin and one undo per gesture', async ({
    page,
  }) => {
    await select(page, 'opacity.disabled');
    await field(page, 'opacity.disabled').fill('1.5');
    await expect(field(page, 'opacity.disabled')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Cinder limit', { exact: false }).first()).toBeVisible();
    await field(page, 'opacity.disabled').fill('0.55');
    const slider = page.getByRole('slider', { name: /Opacity disabled slider/ });
    await slider.focus();
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.down('ArrowLeft');
    await page.keyboard.up('ArrowLeft');
    await expect(field(page, 'opacity.disabled')).toHaveValue('0.53');
    await expect(page.getByTestId('draft-value')).toHaveText('0.53');
    await undo(page).click();
    await expect(page.getByTestId('draft-value')).not.toHaveText('0.53');
  });

  test('z-index takes a signed 32-bit integer and refuses a fraction', async ({ page }) => {
    await select(page, 'z.modal');
    await field(page, 'z.modal').fill('1.5');
    await expect(field(page, 'z.modal')).toHaveAttribute('aria-invalid', 'true');
    await field(page, 'z.modal').fill('-2147483648');
    await expect(field(page, 'z.modal')).not.toHaveAttribute('aria-invalid', 'true');
    await apply(page).click();
    await expect.poll(() => frameVar(page, '--cinder-z-modal')).toBe('-2147483648');
  });

  test('font weight accepts a DTCG name as well as 1 to 1000', async ({ page }) => {
    await select(page, 'font.bold');
    await field(page, 'font.bold').fill('1001');
    await expect(field(page, 'font.bold')).toHaveAttribute('aria-invalid', 'true');
    await field(page, 'font.bold').fill('extra-bold');
    await apply(page).click();
    await expect(field(page, 'font.bold')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('draft-value')).not.toHaveText('700');
  });

  test('a cubic-bezier keeps x in 0 to 1 and draws the committed curve', async ({ page }) => {
    await select(page, 'ease.standard');
    const curve = page.locator('[data-testid="bezier-curve"] path');
    const before = await curve.getAttribute('d');
    await field(page, 'ease.standard', 'x1').fill('2');
    await expect(field(page, 'ease.standard', 'x1')).toHaveAttribute('aria-invalid', 'true');
    await expect(curve).toHaveAttribute('d', before!);
    await field(page, 'ease.standard', 'x1').fill('0.5');
    await field(page, 'ease.standard', 'y1').fill('-0.25');
    await apply(page).click();
    await expect.poll(() => curve.getAttribute('d')).not.toBe(before);
    await expect.poll(() => frameVar(page, '--cinder-ease-standard')).toContain('0.5');
  });
});

test.describe('font stacks', () => {
  test('reorders with the keyboard and flags fonts this browser lacks', async ({ page }) => {
    await select(page, 'font.mono');
    await expect(page.getByTestId('environment-dependent').first()).toContainText(
      'Environment-dependent',
    );
    const names = () =>
      page
        .locator('input[id*="-font-mono-family-"]')
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    const first = await names();
    const down = page.getByRole('button', { name: `Move ${first[0]} down` });
    await down.focus();
    await page.keyboard.press('Enter');
    const reordered = await names();
    expect(reordered.slice(0, 2)).toEqual([first[1], first[0]]);
    await apply(page).click();
    await expect(page.getByTestId('stack-font.mono')).toContainText(first[1]!);
    const stack = page.getByRole('list', { name: 'Monospace family fallback order' });
    await expect(stack.locator('li').first()).toHaveText(first[1]!);
  });
});

test.describe('motion contexts', () => {
  test('a reduced-motion edit stays in that context; a mode-independent edit reaches both modes', async ({
    page,
  }) => {
    await select(page, 'motion.slow');
    await field(page, 'motion.slow').fill('333');
    await apply(page).click();
    await expect.poll(() => frameVar(page, '--cinder-duration-slow')).toBe('333ms');
    await selectContext(page, { colorMode: 'dark', motion: 'default' });
    await expect.poll(() => frameVar(page, '--cinder-duration-slow')).toBe('333ms');

    await selectContext(page, { colorMode: 'light', motion: 'reduced' });
    await page.getByLabel('Apply to', { exact: true }).selectOption('motion-mode');
    await field(page, 'motion.slow').fill('5');
    await apply(page).click();
    await expect.poll(() => frameVar(page, '--cinder-duration-slow')).toBe('5ms');
    await selectContext(page, { colorMode: 'light', motion: 'default' });
    await expect.poll(() => frameVar(page, '--cinder-duration-slow')).toBe('333ms');
  });
});

test.describe('the Foundations view', () => {
  test('draws the spacing and radius scales and the typography specimen', async ({ page }) => {
    await expect(page.getByTestId('foundations-view')).toBeVisible();
    await expect(page.locator('[data-testid="foundations-spacing"] li')).toHaveCount(19);
    await expect(page.locator('[data-testid="foundations-radius"] li')).toHaveCount(4);
    const specimen = page.getByTestId('typography-specimen');
    await expect(specimen.getByTestId('stack-font.sans')).toContainText('sans-serif');
    await expect(specimen.getByTestId('stack-font.mono')).toContainText('monospace');
    await expect(
      specimen.getByText('Cinder has no separate heading font', { exact: false }),
    ).toBeVisible();
    await expect(specimen.getByTestId('sample-heading-1')).toContainText('size');
    await expect(specimen.getByTestId('sample-body')).toContainText('letter spacing');
    await expect(specimen.getByTestId('sample-body')).toContainText('line height');
  });

  test('category reset removes every override of a foundation family in one step', async ({
    page,
  }) => {
    await select(page, 'motion.fast');
    await field(page, 'motion.fast').fill('50');
    await apply(page).click();
    await expect(page.getByTestId('draft-value')).toHaveText('50ms');
    await page.getByRole('button', { name: 'Reset motion', exact: true }).click();
    await expect(page.getByTestId('draft-value')).toHaveText('120ms');
    await undo(page).click();
    await expect(page.getByTestId('draft-value')).toHaveText('50ms');
  });
});

test.describe('scale presets', () => {
  const spacing = (page: Page) => page.getByTestId('presets-spacing');
  const proposal = (page: Page) => page.getByTestId('proposal-spacing');

  test('Compact, Standard and Comfortable are reviewed, applied once, and undone as one step', async ({
    page,
  }) => {
    await spacing(page).getByRole('button', { name: 'Compact (0.75)' }).click();
    await expect(proposal(page)).toContainText('Shared (all modes)');
    await expect(proposal(page).locator('tbody tr')).toHaveCount(19);
    await expect(proposal(page)).toContainText('0.1875rem');
    await expect(page.getByTestId('proposal-spacing-dependents')).toContainText('gap.stack');
    // Nothing has changed before Apply.
    expect(await frameVar(page, '--cinder-space-4')).toBe('1rem');
    await spacing(page).getByRole('button', { name: 'Apply proposal' }).click();
    await expect.poll(() => frameVar(page, '--cinder-space-4')).toBe('0.75rem');
    await expect(page.getByTestId('presets-spacing-active')).toContainText('Compact');

    // Applying it again is a no-op and adds no history entry.
    await spacing(page).getByRole('button', { name: 'Compact (0.75)' }).click();
    await spacing(page).getByRole('button', { name: 'Apply proposal' }).click();
    await expect(page.getByTestId('presets-spacing-result')).toContainText('No change');

    // Compact's values are now explicit overrides, so replacing them takes an explicit choice.
    await spacing(page).getByRole('button', { name: 'Comfortable (1.25)' }).click();
    await expect(proposal(page).locator('tr[data-status="overridden"]')).toHaveCount(18);
    await spacing(page).getByRole('button', { name: 'Select all rows' }).click();
    await spacing(page).getByRole('button', { name: 'Apply proposal' }).click();
    await expect.poll(() => frameVar(page, '--cinder-space-4')).toBe('1.25rem');

    await undo(page).click();
    await expect.poll(() => frameVar(page, '--cinder-space-4')).toBe('0.75rem');
    await undo(page).click();
    await expect.poll(() => frameVar(page, '--cinder-space-4')).toBe('1rem');
    await expect(undo(page)).toBeDisabled();
  });

  test('Standard writes base-equivalent values; Cancel changes nothing; radius has its own presets', async ({
    page,
  }) => {
    await spacing(page).getByRole('button', { name: 'Comfortable (1.25)' }).click();
    await spacing(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(proposal(page)).toHaveCount(0);
    await expect(undo(page)).toBeDisabled();

    const radius = page.getByTestId('presets-radius');
    await radius.getByRole('button', { name: 'Standard (1)' }).click();
    await radius.getByRole('button', { name: 'Apply proposal' }).click();
    await expect(page.getByTestId('presets-radius-active')).toContainText('Standard');
    await expect(undo(page)).toBeEnabled();
    await radius.getByRole('button', { name: 'Comfortable (1.25)' }).click();
    await radius.getByRole('button', { name: 'Select all rows' }).click();
    await radius.getByRole('button', { name: 'Apply proposal' }).click();
    await expect.poll(() => frameVar(page, '--cinder-radius-md')).toBe('0.625rem');
  });

  test('a locked token cannot be selected, an override needs its row selected, and a stale proposal cannot apply', async ({
    page,
  }) => {
    await select(page, 'space.4');
    await page.getByLabel('Lock Space 4 (space.4)').check();
    await spacing(page).getByRole('button', { name: 'Compact (0.75)' }).click();
    const locked = proposal(page).locator('tr[data-path="space.4"] input[type="checkbox"]');
    await expect(locked).toBeDisabled();
    await expect(locked).not.toBeChecked();
    // Changing the theme after the proposal was made makes it stale.
    await page.getByLabel('Lock Space 4 (space.4)').uncheck();
    await expect(page.getByTestId('proposal-spacing-stale')).toBeVisible();
    await expect(spacing(page).getByRole('button', { name: 'Apply proposal' })).toBeDisabled();
  });

  test('the whole preset flow works from the keyboard', async ({ page }) => {
    const compact = spacing(page).getByRole('button', { name: 'Compact (0.75)' });
    await compact.focus();
    await page.keyboard.press('Enter');
    const box = proposal(page).locator('tr[data-path="space.2"] input[type="checkbox"]');
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).not.toBeChecked();
    await spacing(page).getByRole('button', { name: 'Apply proposal' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => frameVar(page, '--cinder-space-4')).toBe('0.75rem');
    expect(await frameVar(page, '--cinder-space-2')).toBe('0.5rem');
    await expect(page.getByTestId('presets-spacing-active')).toContainText('No named preset');
  });
});

test.describe('labels and layout', () => {
  test('every editor control has a programmatic label naming the token and context', async ({
    page,
  }) => {
    for (const path of [
      'space.2',
      'font.mono',
      'ease.standard',
      'motion.fast',
      'opacity.disabled',
    ]) {
      await select(page, path);
      const names = await page.evaluate(() => {
        const editor = document.querySelector('[data-testid="foundation-token-editor"]')!;
        return [...editor.querySelectorAll('input, select, [role="slider"]')]
          .filter((control) => !/-(scope|locked)$/.test(control.id))
          .map((control) => {
            const element = control as HTMLInputElement;
            const fromLabels = [...(element.labels ?? [])].map((label) => label.textContent ?? '');
            return {
              id: control.id,
              name: [...fromLabels, element.getAttribute('aria-label') ?? ''].join(' ').trim(),
            };
          });
      });
      expect(names.length, path).toBeGreaterThan(0);
      for (const { id: controlId, name } of names) {
        expect(name, `${path}: ${controlId}`).toContain(path);
      }
    }
  });

  test('390px: the Foundations view and an editor fit without horizontal scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await select(page, 'font.sans');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
