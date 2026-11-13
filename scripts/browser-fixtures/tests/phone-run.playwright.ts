/**
 * COR-2288, row P1 (PhoneRun): what a phone keeps of an approval and its composer. At 390 px the
 * approval's command wraps, its risk glyph sits beside the question, Deny and Approve are equal
 * 44 px targets, and the composer's Attach and Send are 44 px targets on both sides.
 */
import { loadManifest, type Viewport } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const phone = { name: 'mobile', width: 390, height: 844 } as const satisfies Viewport;

function requiredEntry(slug: string) {
  const entry = loadManifest().find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`Cached testing manifest does not include "${slug}".`);
  return entry;
}

const approvalEntry = requiredEntry('approval-card');
const chatEntry = requiredEntry('chat');

test.describe('Phone run approval', () => {
  test('wraps the command and keeps the risk glyph beside the question', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({ entry: approvalEntry, theme: 'dark', viewport: phone });
    const card = page.locator('.cinder-approval-card').first();

    await expect(card.locator('.cinder-code-block--wrap')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const header = card.locator('.cinder-approval-card__header');
    await expect(header).toHaveCSS('display', 'grid');
    const glyph = await card.locator('.cinder-approval-card__risk-tip').boundingBox();
    const title = await card.locator('.cinder-approval-card__title').boundingBox();
    expect(glyph).not.toBeNull();
    expect(title).not.toBeNull();
    expect(glyph!.x + glyph!.width).toBeLessThanOrEqual(title!.x + 0.5);

    // A pending approval with a callback has no status badge, so the group draws no row and the
    // question starts level with the top of the risk glyph. A zero-height group that kept its
    // bottom margin would pass `toBeHidden()` yet push the question down, so compare positions.
    await expect(card.locator('.cinder-approval-card__badges')).toHaveCSS('display', 'none');
    expect(Math.abs(title!.y - glyph!.y)).toBeLessThanOrEqual(1);
  });

  test('draws Deny and Approve as equal 44px targets', async ({ componentPage }) => {
    const page = await componentPage.open({ entry: approvalEntry, theme: 'dark', viewport: phone });
    const card = page.locator('.cinder-approval-card').first();

    const deny = await card.getByRole('button', { name: 'Deny', exact: true }).boundingBox();
    const approve = await card.getByRole('button', { name: 'Approve', exact: true }).boundingBox();
    expect(deny).not.toBeNull();
    expect(approve).not.toBeNull();
    expect(deny!.height).toBeGreaterThanOrEqual(43.5);
    expect(approve!.height).toBeGreaterThanOrEqual(43.5);
    expect(Math.abs(deny!.width - approve!.width)).toBeLessThanOrEqual(1);
    // Secondary on the left, primary on the right.
    expect(deny!.x).toBeLessThan(approve!.x);
  });
});

test.describe('Phone run composer', () => {
  test('reaches Attach and Send by 44px hit areas around compact faces and pads the area for the safe area', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: chatEntry,
      theme: 'dark',
      viewport: phone,
      fixtureName: 'assertion',
      hasTouch: true,
    });
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    // No default chat fixture enables attachments, so reload the same fixture with the gated
    // instance. The route keeps its fixture name and hash: without them the page serves the chat
    // harness, which has no attachments instance.
    const gated = new URL(page.url());
    gated.searchParams.set('attachments', '1');
    await page.goto(gated.toString(), { waitUntil: 'load' });
    const attachmentsChat = page.getByTestId('chat-attachments-enabled');
    await expect(
      attachmentsChat.getByRole('button', { name: 'Attach file', exact: true }),
    ).toBeVisible();

    const attachButton = attachmentsChat.getByRole('button', { name: 'Attach file', exact: true });
    const sendButton = attachmentsChat.getByRole('button', { name: /^Send/ }).first();
    // A point is only hit-testable inside the viewport.
    await attachButton.scrollIntoViewIfNeeded();
    await sendButton.scrollIntoViewIfNeeded();
    const attach = await attachButton.boundingBox();
    const send = await sendButton.boundingBox();
    expect(attach).not.toBeNull();
    expect(send).not.toBeNull();
    // The painted face is compact; the 44px target is a pseudo-element hit area that takes no
    // layout. A point 21px out from the centre on each axis (inside 22px) resolves to the control.
    for (const [name, box] of [
      ['Attach file', attach!],
      ['Send', send!],
    ] as const) {
      expect(box.height, `${name} paints compact`).toBeLessThan(40);
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      for (const [dx, dy] of [
        [-21, 0],
        [21, 0],
        [0, -21],
        [0, 21],
      ] as const) {
        const owner = await page.evaluate(
          ([x, y]) => {
            const hit = document.elementFromPoint(x, y);
            const control = hit?.closest('button');
            if (control === null || control === undefined) {
              return `no button; hit ${hit?.tagName.toLowerCase()}.${hit?.className}`;
            }
            return control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
          },
          [centre.x + dx, centre.y + dy] as const,
        );
        expect(owner, `${name}: point (${dx}, ${dy}) from its centre`).toMatch(
          name === 'Send' ? /^Send/ : /^Attach file$/,
        );
      }
    }

    // Chromium reports no safe-area inset, so the area's bottom padding equals its top padding;
    // on a device with a home indicator it grows by the inset.
    const padding = await attachmentsChat
      .locator('.chat-input-area')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { top: style.paddingTop, bottom: style.paddingBottom };
      });
    expect(padding.bottom).toBe(padding.top);
  });
});
