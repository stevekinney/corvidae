/**
 * COR-2327 (owner, 2026-11-16): on a 320px phone the waiting approval's input started about 55px
 * in, past a chevron column and an "Input" column, and wrapped in a narrow column. The input is now
 * rows in the open at the card's content edge, each label over its value: the first value starts on
 * the title's left edge, and a short input (three pairs) draws no "Show all".
 */
import { loadManifest, type Viewport } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const narrowPhone = { name: 'mobile', width: 320, height: 640 } as const satisfies Viewport;

function requiredEntry(slug: string) {
  const entry = loadManifest().find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`Cached testing manifest does not include "${slug}".`);
  return entry;
}

const approvalEntry = requiredEntry('approval-card');

test.describe('Approval input rows at 320px', () => {
  test('the first input value starts on the title’s left edge, and three pairs draw no Show all', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: narrowPhone,
    });
    const card = page.locator('#approval-card-row-chat');
    await expect(card.getByRole('group', { name: 'Input' })).toBeVisible();

    // Both edges in one read, so a layout pass between two reads cannot skew the comparison.
    const edges = await page.evaluate(() => {
      const card = document.querySelector('#approval-card-row-chat');
      const title = card?.querySelector('.cinder-approval-card__row-question');
      const value = card?.querySelector('.cinder-approval-card__input-row dd');
      const label = card?.querySelector('.cinder-approval-card__input-row dt');
      if (title == null || value == null || label == null) return null;
      const valueBox = value.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      return {
        title: title.getBoundingClientRect().left,
        value: valueBox.left,
        label: labelBox.left,
        valueTop: valueBox.top,
        labelBottom: labelBox.bottom,
      };
    });

    expect(edges).not.toBeNull();
    expect(Math.abs(edges!.value - edges!.title)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(edges!.label - edges!.title)).toBeLessThanOrEqual(0.5);
    // The value sits under its label: no column of labels beside a column of values.
    expect(edges!.valueTop).toBeGreaterThanOrEqual(edges!.labelBottom - 0.5);
    await expect(card.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: /^Input/ })).toHaveCount(0);
  });

  test('a long input shows four rows and Show all 9 opens the rest in place', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: narrowPhone,
    });
    const card = page.locator('#approval-card-decision-long');
    const input = card.getByRole('group', { name: 'Input' });
    const toggle = card.getByRole('button', { name: 'Show all 9' });

    await expect(input.locator('.cinder-approval-card__input-row:visible')).toHaveCount(4);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(input.locator('.cinder-approval-card__input-row:visible')).toHaveCount(9);
    await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
