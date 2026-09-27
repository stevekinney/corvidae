/**
 * COR-511 / DR-8: automated coverage for review states this project's
 * ratified contract requires but that no prior issue's browser fixtures
 * exercised — light/dark theming, a 320-CSS-pixel stacked layout with every
 * control reachable, and automated axe checks on the composed `DiffReview`
 * shell. Range selection, Shift-click, the annotation keyboard model, focus
 * return, live-region copy announcements, and two-instance isolation for the
 * underlying viewers are already covered by `diff-review.playwright.ts`,
 * `diff-viewer-annotation.playwright.ts`, and
 * `source-diff-viewer-annotation.playwright.ts`; this file does not repeat
 * them.
 *
 * Human design/accessibility acceptance for this component is reserved for
 * Steve Kinney by the ratified contract (SHA-256 `ac837e3a…`) and is not
 * performed here — see `diff-review.a11y.md` for the recorded provenance of
 * the reported COR-511 waiver. VoiceOver was not driven in this session;
 * announcements below are verified with DOM/live-region assertions only.
 */
import { loadManifest, runAxe, type ComponentEntry } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const desktopViewport = { name: 'desktop', width: 1440, height: 1080 } as const;
// `name` is only an artifact-path label (`ViewportName` is a closed union of
// the manifest's own bucket names) -- the real, load-bearing 320px width the
// contract requires is `width` below, independent of that label.
const narrowViewport = { name: 'mobile', width: 320, height: 900 } as const;

function getDiffReviewEntry(): ComponentEntry {
  const entry = loadManifest().find((candidate) => candidate.slug === 'diff-review');
  if (!entry) throw new Error('Component manifest is missing slug: diff-review');
  return entry;
}

function getAssertionFixtureHash(entry: ComponentEntry): string {
  const hash = entry.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error('DiffReview manifest entry has no assertion fixture.');
  return hash;
}

function expectNoViolations(label: string, buckets: Awaited<ReturnType<typeof runAxe>>): void {
  const violations = Object.values(buckets).flat();
  expect(violations, `${label} should have no scoped axe violations`).toHaveLength(0);
}

test.describe('Diff review — light and dark themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`the ${theme} theme renders the review regions with no axe violations`, async ({
      componentPage,
    }) => {
      const entry = getDiffReviewEntry();
      const fixtureContentHash = getAssertionFixtureHash(entry);
      const page = await componentPage.open({
        entry,
        theme,
        viewport: desktopViewport,
        fixtureName: 'assertion',
        fixtureContentHash,
      });

      const mount = page.locator('#example-mount-markdown-pair');
      await expect(mount.getByRole('navigation', { name: 'File navigation' })).toBeVisible();
      await expect(mount.getByRole('main', { name: 'Diff' })).toBeVisible();
      await expect(mount.getByRole('complementary', { name: 'Review' })).toBeVisible();

      const buckets = await runAxe(
        page,
        { slug: 'diff-review', theme, viewport: desktopViewport.name, fixture: 'assertion' },
        { include: '#example-mount-markdown-pair' },
      );
      expectNoViolations(`diff-review/markdown-pair (${theme})`, buckets);
    });
  }
});

test.describe('Diff review — 320px narrow layout', () => {
  test('every File navigation, Diff, and Review control stays reachable with no horizontal overflow', async ({
    componentPage,
  }) => {
    const entry = getDiffReviewEntry();
    const fixtureContentHash = getAssertionFixtureHash(entry);
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: narrowViewport,
      fixtureName: 'assertion',
      fixtureContentHash,
    });

    const mount = page.locator('#example-mount-multi-file-source');

    // The three named regions must each still be present and individually
    // reachable -- a stacked layout, not one clipped or hidden off-canvas.
    await expect(mount.getByRole('navigation', { name: 'File navigation' })).toBeVisible();
    await expect(mount.getByRole('main', { name: 'Diff' })).toBeVisible();
    await expect(mount.getByRole('complementary', { name: 'Review' })).toBeVisible();

    // Every named control a reviewer needs is present and enabled at 320px.
    await expect(mount.getByLabel('Filter files by path')).toBeVisible();
    await expect(mount.getByText('Copy review')).toBeEnabled();
    await expect(mount.getByText('Download Markdown')).toBeEnabled();
    await expect(mount.getByText('Download JSON')).toBeEnabled();

    // No element on the page forces a horizontal scrollbar at this width --
    // a stacked layout must reflow, not clip.
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const buckets = await runAxe(
      page,
      {
        slug: 'diff-review',
        theme: 'light',
        viewport: narrowViewport.name,
        fixture: 'assertion',
      },
      { include: '#example-mount-multi-file-source' },
    );
    expectNoViolations('diff-review/multi-file-source (320px)', buckets);
  });
});

test.describe('Diff review — read-only state accessibility', () => {
  test('the read-only session has no axe violations and exposes no mutating controls', async ({
    componentPage,
  }) => {
    const entry = getDiffReviewEntry();
    const fixtureContentHash = getAssertionFixtureHash(entry);
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: desktopViewport,
      fixtureName: 'assertion',
      fixtureContentHash,
    });

    const mount = page.locator('#example-mount-readonly');
    await expect(mount.getByRole('button', { name: 'Add file comment' })).toHaveCount(0);

    const buckets = await runAxe(
      page,
      {
        slug: 'diff-review',
        theme: 'light',
        viewport: desktopViewport.name,
        fixture: 'assertion',
      },
      { include: '#example-mount-readonly' },
    );
    expectNoViolations('diff-review/readonly', buckets);
  });
});
