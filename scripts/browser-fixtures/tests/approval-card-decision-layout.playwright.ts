/**
 * The decision layout's owner decisions and board rows, measured in Chromium:
 * - COR-2440 AC12: the command panel is inset to the card's text column, not hung toward the border.
 * - COR-2288 (COR-2439 AC19): a narrow decision card puts its status above its title.
 * - COR-2280 A7 (COR-2438 AC10): an expired approval is a quiet dashed neutral row.
 * - COR-2440 A4: a settled receipt folds to one row at 30rem and wider.
 * - COR-2282 A3 (COR-2440 AC2): a batch is one bordered group of compact rows.
 */
import { loadManifest, type Viewport } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const narrowPhone = { name: 'mobile', width: 320, height: 640 } as const satisfies Viewport;
const desktop = { name: 'desktop', width: 1280, height: 900 } as const satisfies Viewport;

function requiredEntry(slug: string) {
  const entry = loadManifest().find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`Cached testing manifest does not include "${slug}".`);
  return entry;
}

const approvalEntry = requiredEntry('approval-card');
const groupEntry = requiredEntry('approval-group');

test.describe('ApprovalCard decision layout', () => {
  for (const viewport of [narrowPhone, desktop]) {
    test(`the command panel is inset to the card's text column at ${viewport.width}px (COR-2440 AC12)`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({ entry: approvalEntry, theme: 'light', viewport });
      const read = await page.evaluate(() => {
        const card = document.querySelector('#approval-card-decision-command');
        const title = card?.querySelector('.cinder-approval-card__decision-title');
        const panel = card?.querySelector('.cinder-approval-card__command .cinder-code-block');
        if (card == null || title == null || panel == null) return null;
        const cardBox = card.getBoundingClientRect();
        const style = getComputedStyle(card);
        return {
          textLeft:
            cardBox.left +
            Number.parseFloat(style.borderLeftWidth) +
            Number.parseFloat(style.paddingLeft),
          textRight:
            cardBox.right -
            Number.parseFloat(style.borderRightWidth) -
            Number.parseFloat(style.paddingRight),
          titleLeft: title.getBoundingClientRect().left,
          panelLeft: panel.getBoundingClientRect().left,
          panelRight: panel.getBoundingClientRect().right,
        };
      });
      expect(read).not.toBeNull();
      // The panel starts and ends on the text column, where the title starts.
      expect(Math.abs(read!.panelLeft - read!.titleLeft)).toBeLessThanOrEqual(0.5);
      expect(read!.panelLeft).toBeGreaterThanOrEqual(read!.textLeft - 0.5);
      expect(read!.panelRight).toBeLessThanOrEqual(read!.textRight + 0.5);
    });
  }

  test('a narrow decision card puts its status above its title (COR-2288)', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: narrowPhone,
    });
    const card = page.locator('#approval-card-decision-command');
    const facts = card.locator('.cinder-approval-card__facts-line');
    await expect(facts).toContainText('Expires');
    const factsBox = await facts.boundingBox();
    const titleBox = await card.locator('.cinder-approval-card__decision-title').boundingBox();
    expect(factsBox!.y + factsBox!.height).toBeLessThanOrEqual(titleBox!.y + 0.5);
  });

  test('an expired approval is a quiet dashed neutral row with Ask again (COR-2280 A7)', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: desktop,
    });
    const card = page.locator('#approval-card-decision-expired');
    await expect(card).toContainText('Expired before a decision');
    await expect(card.getByRole('button', { name: 'Ask again' })).toBeVisible();
    const style = await card.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { border: computed.borderTopStyle, background: computed.backgroundColor };
    });
    expect(style.border).toBe('dashed');
    expect(style.background).toBe('rgba(0, 0, 0, 0)');
  });

  test('a settled receipt is one line: status, action, who, when, chevron (COR-2440 A4)', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: desktop,
    });
    const card = page.locator('#approval-card-decision-receipt');
    const line = card.locator('.cinder-approval-card__receipt-line');
    const boxes = await line.evaluate((element) =>
      [...element.children].map((child) => {
        const box = child.getBoundingClientRect();
        return {
          name: child.className.split(' ').at(-1),
          top: box.top,
          bottom: box.bottom,
          left: box.left,
        };
      }),
    );
    expect(boxes.map((box) => box.name)).toEqual([
      'cinder-approval-card__receipt-status',
      'cinder-approval-card__receipt-action',
      'cinder-approval-card__receipt-by',
      'cinder-approval-card__receipt-time',
      'cinder-approval-card__receipt-toggle',
    ]);
    // One band, read left to right in A4's order, the chevron at the end.
    const band = boxes[1]!;
    for (const box of boxes) {
      expect(box.top).toBeLessThan(band.bottom);
      expect(box.bottom).toBeGreaterThan(band.top);
    }
    for (const [index, box] of boxes.entries()) {
      if (index > 0) expect(box.left).toBeGreaterThan(boxes[index - 1]!.left);
    }
    await expect(line).not.toContainText('?');
    await card.getByRole('button', { name: 'Details' }).click();
    await expect(card.locator('dl.cinder-approval-card__receipt-facts')).toBeVisible();
    await expect(card.locator('dl')).toHaveCount(1);
  });

  test('a narrow receipt puts its status above its action (owner decision)', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: narrowPhone,
    });
    const line = page.locator(
      '#approval-card-decision-receipt .cinder-approval-card__receipt-line',
    );
    const read = await line.evaluate((element) => {
      const status = element.querySelector('.cinder-approval-card__receipt-status');
      const action = element.querySelector('.cinder-approval-card__receipt-action');
      if (status == null || action == null) return null;
      return {
        statusBottom: status.getBoundingClientRect().bottom,
        actionTop: action.getBoundingClientRect().top,
      };
    });
    expect(read).not.toBeNull();
    expect(read!.statusBottom).toBeLessThanOrEqual(read!.actionTop + 0.5);
  });
});

test.describe('ApprovalGroup', () => {
  test('a batch is one bordered group of compact rows, the rows with no border of their own (A3)', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({ entry: groupEntry, theme: 'light', viewport: desktop });
    const group = page.getByRole('group', { name: '2 approvals waiting' });
    await expect(group).toBeVisible();
    const read = await group.evaluate((element) => ({
      groupBorder: getComputedStyle(element).borderTopStyle,
      rows: [...element.querySelectorAll('.cinder-approval-card')].map((card) => ({
        layout: card.getAttribute('data-cinder-layout'),
        border: getComputedStyle(card).borderTopWidth,
      })),
    }));
    expect(read.groupBorder).toBe('solid');
    expect(read.rows).toEqual([
      { layout: 'row', border: '0px' },
      { layout: 'row', border: '0px' },
    ]);
  });
});
