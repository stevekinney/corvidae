import { FIXTURE_ORIGIN } from '@lostgradient/testing/browser/fixture-port';
import { environmentConfiguration } from '@lostgradient/testing/environment-configuration';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * COR-2725, RunStates R6: the outcome of a turn that ends on its steps (no assistant message) is
 * drawn on Chat's anchor, and the anchor spans the transcript column exactly as a reply-carried
 * outcome does. The fixture is `fixtures/chat.svelte` behind `?turnOutcome=<kind>`: one Chat whose
 * run only called tools (`chat-turn-outcome-anchor`) and one whose assistant message carries the
 * same outcome (`chat-turn-outcome-reply`).
 *
 * The column (`.chat-timeline`'s content box) is the primary reference. The reply is a valid
 * reference for inline edges only: its content and its vertical rhythm are its own. A user row in
 * the anchor's Chat is the negative control: it must stay narrower than the column, or the
 * equalities would hold for any wrapper that fills the column.
 *
 * Run: `bun run --cwd components/chat test:browser --grep "turn outcome anchor"`
 */
const TOLERANCE = 1;
const KINDS = ['stopped', 'failed', 'empty', 'reconnecting'] as const;
type Kind = (typeof KINDS)[number];

async function open(page: Page, kind: string): Promise<void> {
  const url = new URL(
    fixtureRoute('chat'),
    environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  );
  url.searchParams.set('turnOutcome', kind);
  await page.goto(url.href);
}

interface Measure {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly direction: string;
  /** The content box of the element's parent: the column the element stands in. */
  readonly columnLeft: number;
  readonly columnRight: number;
  /** The element's own content box, for a row whose children are placed against it. */
  readonly contentLeft: number;
  readonly contentRight: number;
  readonly borderTopStyle: string;
  readonly parentMatchesTimeline: boolean;
}

/** Reads every named locator in one evaluation, so a page that is still moving cannot split them. */
async function measure<Names extends string>(
  page: Page,
  locators: Record<Names, Locator>,
): Promise<Record<Names, Measure>> {
  const entries = Object.entries<Locator>(locators);
  const handles = await Promise.all(
    entries.map(async ([name, locator]) => {
      const handle = await locator.first().elementHandle();
      if (handle === null) throw new Error(`${name} is not on the page.`);
      return handle;
    }),
  );
  const measured = await page.evaluate((elements) => {
    const pixels = (value: string): number => Number.parseFloat(value || '0') || 0;
    return elements.map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const parent = element.parentElement;
      const parentBox = parent?.getBoundingClientRect();
      const parentStyle = parent === null ? undefined : getComputedStyle(parent);
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        direction: style.direction,
        columnLeft:
          (parentBox?.left ?? 0) +
          pixels(parentStyle?.paddingLeft ?? '0') +
          pixels(parentStyle?.borderLeftWidth ?? '0'),
        columnRight:
          (parentBox?.right ?? 0) -
          pixels(parentStyle?.paddingRight ?? '0') -
          pixels(parentStyle?.borderRightWidth ?? '0'),
        contentLeft: box.left + pixels(style.paddingLeft) + pixels(style.borderLeftWidth),
        contentRight: box.right - pixels(style.paddingRight) - pixels(style.borderRightWidth),
        borderTopStyle: style.borderTopStyle,
        parentMatchesTimeline: parent?.matches('.chat-timeline') ?? false,
      };
    });
  }, handles);
  return Object.fromEntries(entries.map(([name], index) => [name, measured[index]!])) as Record<
    Names,
    Measure
  >;
}

function near(actual: number, expected: number, label: string): void {
  expect(
    Math.abs(actual - expected),
    `${label}: ${String(actual)} vs ${String(expected)}`,
  ).toBeLessThanOrEqual(TOLERANCE);
}

async function expectCell(page: Page, kind: Kind, width: number): Promise<void> {
  const steps = page.getByTestId('chat-turn-outcome-anchor');
  const reply = page.getByTestId('chat-turn-outcome-reply');
  // A refused Retry now is what keeps a reconnecting anchor on screen: it says so, once.
  if (kind === 'reconnecting') {
    await steps.getByRole('button', { name: 'Retry now' }).click();
    await expect(steps.locator('.chat-turn-command-failure')).toHaveCount(1);
  }
  const anchorRow = steps.locator('.chat-message-wrapper[data-turn-anchor]');
  await expect(anchorRow).toBeVisible();
  const replyRow =
    kind === 'reconnecting'
      ? reply.locator('.chat-message-wrapper[data-role="assistant"]')
      : reply.locator('.chat-message-wrapper:has(.chat-turn-outcome)');
  await expect(replyRow).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const m = await measure(page, {
    anchor: anchorRow,
    reply: replyRow,
    user: steps.locator('.chat-message-wrapper[data-role="user"]'),
    group: steps.locator('.chat-tool-call-group'),
  });

  // 1. Both rows stand in the transcript column, and the two columns are the same width.
  expect(m.anchor.parentMatchesTimeline).toBe(true);
  expect(m.reply.parentMatchesTimeline).toBe(true);
  near(
    m.anchor.columnRight - m.anchor.columnLeft,
    m.reply.columnRight - m.reply.columnLeft,
    'the two columns are equally wide',
  );
  if (width === 1280) near(m.anchor.columnRight - m.anchor.columnLeft, 768, 'the column at 1280');
  // 2 and 3. The reply and the anchor span the column on both edges.
  near(m.reply.left, m.reply.columnLeft, 'the reply fills the column at its left');
  near(m.reply.right, m.reply.columnRight, 'the reply fills the column at its right');
  near(m.anchor.left, m.anchor.columnLeft, 'the anchor fills the column at its left');
  near(m.anchor.right, m.anchor.columnRight, 'the anchor fills the column at its right');
  // 4. The anchor and the reply share both inline edges.
  near(m.anchor.left, m.reply.left, 'the anchor and the reply share a left edge');
  near(m.anchor.right, m.reply.right, 'the anchor and the reply share a right edge');
  // 5. Negative control: the person's row is narrower than the column and ends at its inline end.
  expect(m.user.right - m.user.left).toBeLessThan(m.anchor.columnRight - m.anchor.columnLeft - 8);
  near(
    m.user.direction === 'rtl' ? m.user.left : m.user.right,
    m.user.direction === 'rtl' ? m.anchor.columnLeft : m.anchor.columnRight,
    'the person’s row ends at the column’s inline end',
  );
  // 6. The anchor lines up with the steps above it and stands below them.
  near(m.anchor.left, m.group.left, 'the anchor and the steps share a left edge');
  near(m.anchor.right, m.group.right, 'the anchor and the steps share a right edge');
  expect(m.anchor.top).toBeGreaterThanOrEqual(m.group.bottom - TOLERANCE);
  // 7. The anchor is no message: it has no bubble and no line of time or actions.
  await expect(anchorRow.locator('.chat-message')).toHaveCount(0);
  await expect(anchorRow.locator('.chat-message-line')).toHaveCount(0);

  if (kind === 'reconnecting') {
    // After the refused Retry now, the one line it says spans the column.
    const line = await measure(page, {
      line: steps.locator('.chat-turn-command-failure'),
      anchor: anchorRow,
    });
    near(line.line.left, line.anchor.columnLeft, 'the failure line starts at the column');
    near(line.line.right, line.anchor.columnRight, 'the failure line ends at the column');
    return;
  }

  // Stopped, failed and empty: the outcome box has its wrapper's edges, in both Chats.
  const box = await measure(page, {
    anchorWrapper: anchorRow,
    anchorOutcome: steps.locator(`.chat-turn-outcome[data-kind="${kind}"]`),
    replyWrapper: replyRow,
    replyOutcome: reply.locator(`.chat-turn-outcome[data-kind="${kind}"]`),
  });
  near(
    box.anchorOutcome.left,
    box.anchorWrapper.left,
    'the anchor’s outcome starts at its wrapper',
  );
  near(
    box.anchorOutcome.right,
    box.anchorWrapper.right,
    'the anchor’s outcome ends at its wrapper',
  );
  near(box.replyOutcome.left, box.replyWrapper.left, 'the reply’s outcome starts at its wrapper');
  near(box.replyOutcome.right, box.replyWrapper.right, 'the reply’s outcome ends at its wrapper');

  if (kind === 'empty') {
    for (const [name, scope] of [
      ['anchor', steps],
      ['reply', reply],
    ] as const) {
      const row = scope.locator('.chat-turn-empty-row');
      const wrapper = name === 'anchor' ? anchorRow : replyRow;
      const empty = await measure(page, {
        row,
        wrapper,
        text: row.locator('.chat-turn-text'),
        button: row.getByRole('button', { name: 'Try again' }),
      });
      // 1. The dashed row spans its wrapper, 2. with its time and its words.
      near(empty.row.left, empty.wrapper.left, `the ${name} row starts at its wrapper`);
      near(empty.row.right, empty.wrapper.right, `the ${name} row ends at its wrapper`);
      expect(empty.row.borderTopStyle).toBe('dashed');
      await expect(row.locator('time')).toHaveCount(1);
      await expect(row).toContainText('The agent finished without writing an answer.');
      // 3. Try again ends where the row's content ends, in the row's own direction.
      const rtl = empty.row.direction === 'rtl';
      near(
        rtl ? empty.button.left : empty.button.right,
        rtl ? empty.row.contentLeft : empty.row.contentRight,
        `Try again of the ${name} row is at the row’s inline end`,
      );
      // 4. The words start where the row's content starts.
      near(
        rtl ? empty.text.right : empty.text.left,
        rtl ? empty.row.contentRight : empty.row.contentLeft,
        `the words of the ${name} row are at the row’s inline start`,
      );
      // 5. Where the row has room for one line, the button is centred on it.
      if (width >= 768) {
        const centre = (empty.button.top + empty.button.bottom) / 2;
        expect(centre).toBeGreaterThanOrEqual(empty.text.top - TOLERANCE);
        expect(centre).toBeLessThanOrEqual(empty.text.bottom + TOLERANCE);
      }
    }
  }

  if (kind === 'failed') {
    const callouts = await measure(page, {
      anchorCallout: steps.locator('.chat-turn-outcome[data-kind="failed"] .cinder-callout'),
      anchorWrapper: anchorRow,
      replyCallout: reply.locator('.chat-turn-outcome[data-kind="failed"] .cinder-callout'),
      replyWrapper: replyRow,
      anchorRetry: steps.getByRole('button', { name: 'Retry' }),
      replyRetry: reply.getByRole('button', { name: 'Retry' }),
    });
    near(
      callouts.anchorCallout.left,
      callouts.anchorWrapper.left,
      'the alert starts at the anchor',
    );
    near(
      callouts.anchorCallout.right,
      callouts.anchorWrapper.right,
      'the alert ends at the anchor',
    );
    near(callouts.replyCallout.left, callouts.replyWrapper.left, 'the alert starts at the reply');
    near(callouts.replyCallout.right, callouts.replyWrapper.right, 'the alert ends at the reply');
    near(
      callouts.anchorRetry.right,
      callouts.replyRetry.right,
      'Retry has the same right edge in both Chats',
    );
  }

  if (kind === 'stopped') {
    // R4: the neutral pill at the wrapper's inline start, and Discard then Continue (the primary
    // choice, trailing-most) at its inline end. The pill's words differ on purpose: a turn the run
    // only called tools in has no partial answer ("Stopped before an answer."). The actions are the
    // same in both rows, wherever the pill ends.
    const stopped = await measure(page, {
      anchorBadge: steps.locator('.chat-turn-outcome[data-kind="stopped"] .cinder-badge'),
      replyBadge: reply.locator('.chat-turn-outcome[data-kind="stopped"] .cinder-badge'),
      anchorWrapper: anchorRow,
      replyWrapper: replyRow,
      anchorContinue: steps.getByRole('button', { name: 'Continue' }),
      replyContinue: reply.getByRole('button', { name: 'Continue' }),
      anchorDiscard: steps.getByRole('button', { name: 'Discard' }),
      replyDiscard: reply.getByRole('button', { name: 'Discard' }),
    });
    await expect(steps.locator('.chat-turn-outcome[data-kind="stopped"] .cinder-badge')).toHaveText(
      'Stopped before an answer.',
    );
    await expect(reply.locator('.chat-turn-outcome[data-kind="stopped"] .cinder-badge')).toHaveText(
      'Stopped by you, partial answer',
    );
    for (const [name, badge, discard, resume, wrapper] of [
      [
        'anchor',
        stopped.anchorBadge,
        stopped.anchorDiscard,
        stopped.anchorContinue,
        stopped.anchorWrapper,
      ],
      [
        'reply',
        stopped.replyBadge,
        stopped.replyDiscard,
        stopped.replyContinue,
        stopped.replyWrapper,
      ],
    ] as const) {
      near(badge.left, wrapper.left, `the ${name} pill starts at the wrapper`);
      // Discard first, Continue last, and Continue ends where the wrapper's content ends.
      expect(discard.right, `${name}: Discard comes before Continue`).toBeLessThanOrEqual(
        resume.left + TOLERANCE,
      );
      const rtl = wrapper.direction === 'rtl';
      near(
        rtl ? resume.left : resume.right,
        rtl ? wrapper.contentLeft : wrapper.contentRight,
        `${name}: Continue is at the wrapper's inline end`,
      );
      if (width >= 768) {
        // One row: the pill, then Discard, then Continue, centred on one line.
        expect(badge.right).toBeLessThanOrEqual(discard.left + TOLERANCE);
        near(
          (discard.top + discard.bottom) / 2,
          (resume.top + resume.bottom) / 2,
          `${name}: the actions share a line`,
        );
        near(
          (badge.top + badge.bottom) / 2,
          (resume.top + resume.bottom) / 2,
          `${name}: the pill is on the actions' line`,
        );
      }
    }
    // The same buttons in the same places in both Chats, whatever the pill says.
    for (const [label, anchorButton, replyButton] of [
      ['Continue', stopped.anchorContinue, stopped.replyContinue],
      ['Discard', stopped.anchorDiscard, stopped.replyDiscard],
    ] as const) {
      near(anchorButton.left, replyButton.left, `${label} has the same left edge in both Chats`);
      near(anchorButton.right, replyButton.right, `${label} has the same right edge in both Chats`);
    }
  }
}

for (const width of [1280, 768, 375, 320]) {
  test.describe(`turn outcome anchor at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const kind of KINDS) {
      test(`the ${kind} outcome spans the transcript column as a reply-carried one does`, async ({
        page,
      }) => {
        await open(page, kind);
        await expectCell(page, kind, width);
      });
    }
  });
}

for (const width of [1280, 375]) {
  test.describe(`turn outcome anchor, right to left, at ${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const kind of ['empty', 'failed', 'stopped'] as const) {
      test(`the ${kind} outcome spans the transcript column right to left`, async ({ page }) => {
        await open(page, kind);
        await page.evaluate(() => {
          document.documentElement.dir = 'rtl';
        });
        await expectCell(page, kind, width);
      });
    }
  });
}
