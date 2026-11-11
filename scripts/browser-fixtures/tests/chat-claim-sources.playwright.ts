/**
 * COR-2260: the browser half of the claim-source streaming probe. The Bun tests
 * (`components/chat/src/lib/components/chat/message/claim-source-fixture.test.ts`) replay the
 * stream and check markers, footers and focus in a DOM emulation; the two checks that need a real
 * layout engine run here, for both candidate shapes: a text selection across both claims, and the
 * preview opening and closing without a request.
 */
import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './editor-fixture.ts';

type Representation = 'structured' | 'positional';

const CLAIM_A = 'Revenue grew 12% in 2025.';
const CLAIM_B = 'Margins held at 31% for the year.';
const SOURCES = [
  {
    id: 'source-a',
    label: 'Annual report',
    detail: 'Page 4',
    url: 'https://example.test/annual-report',
  },
  { id: 'source-b', label: 'Investor call', detail: 'Transcript' },
];

async function send(page: Page, event: unknown): Promise<void> {
  await page.evaluate((next) => {
    const harnessWindow = window as unknown as {
      corvidaeChatHarnessClaimSourceEvent: (event: unknown) => void;
    };
    harnessWindow.corvidaeChatHarnessClaimSourceEvent(next);
  }, event);
}

async function openClaims(page: Page, representation: Representation): Promise<void> {
  await page.goto(fixtureRoute('chat'), { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      typeof (window as { corvidaeChatHarnessMountClaimSources?: unknown })
        .corvidaeChatHarnessMountClaimSources === 'function',
  );
  await page.evaluate((shape) => {
    const harnessWindow = window as unknown as {
      corvidaeChatHarnessMountClaimSources: (representation: string) => void;
    };
    harnessWindow.corvidaeChatHarnessMountClaimSources(shape);
  }, representation);
  await expect(page.getByTestId('claim-source-probe')).toBeAttached();
  await send(page, { type: 'sources', sources: SOURCES });
  // The same response, in the same chunks, whichever shape carries the evidence.
  const response = `${CLAIM_A} ${CLAIM_B}`;
  const claims = [
    { text: CLAIM_A, end: CLAIM_A.length, sourceId: 'source-a', claimId: 'claim-a' },
    { text: ` ${CLAIM_B}`, end: response.length, sourceId: 'source-b', claimId: 'claim-b' },
  ];
  for (const claim of claims) {
    for (let start = 0; start < claim.text.length; start += 9) {
      await send(page, { type: 'text', chunk: claim.text.slice(start, start + 9) });
    }
    await send(
      page,
      representation === 'structured'
        ? {
            type: 'structured-claim',
            claim: {
              claimId: claim.claimId,
              markdown: claim.text.trim(),
              sourceId: claim.sourceId,
            },
          }
        : { type: 'positional-claim', claim: { endUtf16: claim.end, sourceId: claim.sourceId } },
    );
  }
}

for (const representation of ['structured', 'positional'] as const) {
  test.describe(`claim source references (${representation})`, () => {
    test('a selection across both claims returns their text and none of the marker labels', async ({
      page,
    }) => {
      await openClaims(page, representation);
      const body = page.getByTestId('claim-source-body');
      await expect(body.locator('.cinder-citation__marker')).toHaveCount(2);
      // No preview is open: the selection covers the claims and the markers between and after them.
      await expect(page.locator('section[aria-label]')).toHaveCount(0);

      await body.selectText();
      const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
      expect(selected).toContain(CLAIM_A);
      expect(selected).toContain(CLAIM_B);
      expect(selected).not.toMatch(/\[\d\]/);
      expect(selected).not.toContain('Annual report');
      expect(selected).not.toContain('Investor call');
      // The marker is a real control with a name, though its number is generated content.
      await expect(
        body.getByRole('button', { name: 'Annual report (1)', exact: true }),
      ).toBeVisible();
    });

    test('a marker and a footer entry open their source, and closing returns focus to the same control', async ({
      page,
    }) => {
      const outbound: string[] = [];
      await openClaims(page, representation);
      const fixtureOrigin = new URL(page.url()).origin;
      page.on('request', (request) => {
        if (!request.url().startsWith(fixtureOrigin) && !request.url().startsWith('data:')) {
          outbound.push(request.url());
        }
      });
      const body = page.getByTestId('claim-source-body');
      const footer = page.getByTestId('claim-source-footer');
      const controls = [
        {
          control: body.getByRole('button', { name: 'Annual report (1)' }),
          label: 'Annual report',
        },
        {
          control: body.getByRole('button', { name: 'Investor call (1)' }),
          label: 'Investor call',
        },
        {
          control: footer.getByRole('button', { name: 'Annual report (1)' }),
          label: 'Annual report',
        },
        {
          control: footer.getByRole('button', { name: 'Investor call (1)' }),
          label: 'Investor call',
        },
      ];
      for (const { control, label } of controls) {
        await control.click();
        const preview = page.locator('section[aria-label]');
        await expect(preview).toHaveAttribute('aria-label', label);
        await expect(preview.locator('strong')).toHaveText(label);
        await page.keyboard.press('Escape');
        await expect(preview).toHaveCount(0);
        await expect(control).toBeFocused();
      }
      // The footer lists the sources in claim order.
      await expect(footer.locator('li')).toHaveText(['Annual report', 'Investor call']);
      // Opening a preview shows the source link but follows none, and loads nothing.
      expect(outbound).toEqual([]);
    });
  });
}
