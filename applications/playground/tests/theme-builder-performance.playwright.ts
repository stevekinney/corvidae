import { expect, test, type Page } from '@playwright/test';

import {
  openBuilder,
  previewFrame,
  trackConsoleProblems,
  waitForScene,
} from './support/theme-builder.ts';

/**
 * Input-to-render budget for the workbench: p95 of 20 samples, nearest rank (the 19th
 * sample of 20 in ascending order), after three unmeasured warm-ups, at most 200ms.
 *
 * A sample runs inside the page: it starts the clock, dispatches the input, and stops it
 * after the frame that shows the result has painted (two animation frames, so the new DOM
 * has been laid out and drawn). For the light/dark switch the result lives in the preview
 * iframe, so the clock also waits for the frame's document to take the new context.
 */
const WARMUPS = 3;
const SAMPLES = 20;
const BUDGET_MS = 200;

export function nearestRankP95(samples: readonly number[]): number {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

async function collect(sample: (index: number) => Promise<number>): Promise<number[]> {
  for (let index = 0; index < WARMUPS; index += 1) await sample(index);
  const measured: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) measured.push(await sample(WARMUPS + index));
  return measured;
}

function expectWithinBudget(name: string, samples: number[]): void {
  expect(samples).toHaveLength(SAMPLES);
  const p95 = nearestRankP95(samples);
  test.info().annotations.push({ type: 'p95', description: `${name}: ${p95.toFixed(1)}ms` });
  process.stdout.write(`  p95 ${name}: ${p95.toFixed(1)}ms (limit ${BUDGET_MS}ms)\n`);
  expect(p95, `${name} p95 (nearest rank, 19th of 20)`).toBeLessThanOrEqual(BUDGET_MS);
}

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
  await openBuilder(page, { width: 1440, height: 900 });
  await waitForScene(await previewFrame(page));
});

test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

async function openCategory(page: Page, label: string, expected: string): Promise<number> {
  return page.evaluate(
    async ({ label: wanted, expected: group }) => {
      const button = [
        ...document.querySelectorAll('nav[aria-label="Token categories"] button'),
      ].find((candidate) => candidate.textContent?.includes(wanted)) as
        HTMLButtonElement | undefined;
      if (button === undefined) throw new Error(`no category ${wanted}`);
      const start = performance.now();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const elapsed = performance.now() - start;
      const count = document.querySelector('[data-testid="catalogue-count"]')?.textContent ?? '';
      if (!count.includes(group)) throw new Error(`catalogue still shows: ${count}`);
      return elapsed;
    },
    { label, expected },
  );
}

async function setFilter(page: Page, value: string, measure: boolean): Promise<number> {
  return page.evaluate(
    async ({ value: next, measure: timed }) => {
      const input = document.querySelector('#theme-builder-token-filter') as HTMLInputElement;
      const start = performance.now();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const elapsed = performance.now() - start;
      const count = document.querySelector('[data-testid="catalogue-count"]')?.textContent ?? '';
      if (timed && !/\d+ tokens? in/.test(count)) throw new Error(`catalogue count: ${count}`);
      return elapsed;
    },
    { value, measure },
  );
}

async function switchColorMode(page: Page, target: 'light' | 'dark'): Promise<number> {
  return page.evaluate(async (mode) => {
    const select = document.querySelector('#theme-builder-color-mode') as HTMLSelectElement;
    const frameDocument = (document.querySelector('iframe') as HTMLIFrameElement).contentDocument!;
    const start = performance.now();
    select.value = mode;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = start + 5000;
    while (frameDocument.documentElement.dataset['theme'] !== mode) {
      if (performance.now() > deadline) throw new Error(`the frame never took ${mode}`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, target);
}

test.describe('input to render', () => {
  test('opening a category', async ({ page }) => {
    const groups = [
      ['Components', 'components'],
      ['Foundations', 'foundations'],
      ['Semantic', 'semantic'],
    ] as const;
    const samples = await collect((index) => {
      const [label, group] = groups[index % groups.length]!;
      return openCategory(page, label, group);
    });
    expectWithinBudget('open category', samples);
  });

  test('filtering radius', async ({ page }) => {
    await openCategory(page, 'Foundations', 'foundations');
    const samples = await collect(async () => {
      const elapsed = await setFilter(page, 'radius', true);
      await setFilter(page, '', false);
      return elapsed;
    });
    expectWithinBudget('filter radius', samples);
  });

  test('switching light and dark', async ({ page }) => {
    const samples = await collect((index) =>
      switchColorMode(page, index % 2 === 0 ? 'dark' : 'light'),
    );
    expectWithinBudget('switch light/dark', samples);
  });

  test('committing a radius edit', async ({ page }) => {
    await selectToken(page, 'Foundations', 'radius.medium');
    const samples = await collect((index) =>
      commitEdit(page, {
        field: '#theme-builder-value-radius-medium',
        text: `{"value": ${2 + (index % 9)}, "unit": "px"}`,
        property: '--cinder-radius-md',
        expected: `${2 + (index % 9)}px`,
      }),
    );
    expectWithinBudget('commit radius edit', samples);
  });

  test('committing an accent edit', async ({ page }) => {
    await selectToken(page, 'Semantic', 'accent.solid');
    const samples = await collect((index) =>
      commitEdit(page, {
        field: '#theme-builder-value-accent-solid',
        text: `{"colorSpace": "srgb", "components": [${(0.1 + (index % 8) * 0.1).toFixed(1)}, 0.4, 0.8]}`,
        property: '--cinder-accent-solid',
        expected: null,
      }),
    );
    expectWithinBudget('commit accent edit', samples);
  });
});

async function selectToken(page: Page, group: string, path: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Token categories' }).getByText(group).click();
  await page.locator(`[data-token-path="${path}"]`).click();
  await expect(page.getByTestId('selected-token-path')).toHaveText(path);
}

/**
 * Type a value into the generic editor, press Apply, and time the click until the preview
 * frame has the new property and has painted twice. With `expected: null` the value must
 * merely differ from the one before the click.
 */
async function commitEdit(
  page: Page,
  edit: { field: string; text: string; property: string; expected: string | null },
): Promise<number> {
  await page.evaluate(
    ({ field, text }) => {
      const input = document.querySelector(field) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    { field: edit.field, text: edit.text },
  );
  return page.evaluate(async ({ property, expected }) => {
    const root = (document.querySelector('iframe') as HTMLIFrameElement).contentDocument!
      .documentElement;
    const read = () => root.style.getPropertyValue(property);
    const before = read();
    const apply = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Apply',
    ) as HTMLButtonElement;
    const start = performance.now();
    apply.click();
    const deadline = start + 5000;
    while (expected === null ? read() === before : read() !== expected) {
      if (performance.now() > deadline) throw new Error(`the frame never took ${property}`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, edit);
}
