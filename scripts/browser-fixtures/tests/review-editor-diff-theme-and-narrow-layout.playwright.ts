/**
 * COR-511 / DR-8: light/dark theming and a 320-CSS-pixel stacked layout for
 * `ReviewEditor`'s opt-in diff-review integration (DR-7). `diff-review-
 * theme-and-narrow-layout.playwright.ts` covers the standalone `DiffReview`
 * shell for exactly this gap; this file covers the same gap for the
 * `ReviewEditor` integration, which no prior DR-7/DR-8 browser fixture
 * exercised at any theme other than the harness default or at a narrow
 * viewport.
 *
 * VoiceOver was not driven in this session; see `review-editor.a11y.md` for
 * the recorded provenance of the reported COR-511 human-acceptance waiver.
 */
import { loadManifest, runAxe, type ComponentEntry } from '@lostgradient/testing';
import { expect, test } from './component-page-fixture.ts';

const desktopViewport = { name: 'desktop', width: 1440, height: 1080 } as const;
const narrowViewport = { name: 'mobile', width: 320, height: 900 } as const;

function getEntry(): ComponentEntry {
  const entry = loadManifest().find(
    (candidate) => candidate.slug === 'review-editor-diff-comments',
  );
  if (!entry) throw new Error('Component manifest is missing slug: review-editor-diff-comments');
  return entry;
}

function getAssertionFixtureHash(entry: ComponentEntry): string {
  const hash = entry.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined)
    throw new Error('review-editor-diff-comments manifest entry has no assertion fixture.');
  return hash;
}

function expectNoViolations(label: string, buckets: Awaited<ReturnType<typeof runAxe>>): void {
  const violations = Object.values(buckets).flat();
  expect(violations, `${label} should have no scoped axe violations`).toHaveLength(0);
}

test.describe('Diff review — ReviewEditor integration light and dark themes', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`the ${theme} theme renders the diff tab with a real comment and no axe violations`, async ({
      componentPage,
    }) => {
      const entry = getEntry();
      const fixtureContentHash = getAssertionFixtureHash(entry);
      const page = await componentPage.open({
        entry,
        theme,
        viewport: desktopViewport,
        fixtureName: 'assertion',
        fixtureContentHash,
      });

      const mount = page.locator('#example-mount-diff-comments');
      await mount.getByRole('tab', { name: 'Diff' }).click();
      const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
      const control = removedRow.locator(
        '[data-cinder-annotation-control][data-cinder-side="old"]',
      );
      await expect(control).toBeVisible();
      await control.click();
      await mount.getByLabel('Diff comment', { exact: true }).fill('Themed comment.');
      await mount.getByRole('button', { name: 'Save', exact: true }).click();

      const buckets = await runAxe(
        page,
        {
          slug: 'review-editor-diff-comments',
          theme,
          viewport: desktopViewport.name,
          fixture: 'assertion',
        },
        { include: '#example-mount-diff-comments' },
      );
      expectNoViolations(`review-editor-diff-comments (${theme})`, buckets);
    });
  }
});

test.describe('Diff review — ReviewEditor integration 320px narrow layout', () => {
  test('the diff tab, its comment controls, and the tab strip all stay reachable with no horizontal overflow', async ({
    componentPage,
  }) => {
    const entry = getEntry();
    const fixtureContentHash = getAssertionFixtureHash(entry);
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: narrowViewport,
      fixtureName: 'assertion',
      fixtureContentHash,
    });

    const mount = page.locator('#example-mount-diff-comments');
    await expect(mount.getByRole('tab', { name: 'Editor' })).toBeVisible();
    await expect(mount.getByRole('tab', { name: 'Diff' })).toBeVisible();

    await mount.getByRole('tab', { name: 'Diff' }).click();
    const removedRow = mount.locator('.diff-row', { has: page.locator('.diff-line-removed') });
    const control = removedRow.locator('[data-cinder-annotation-control][data-cinder-side="old"]');
    await expect(control).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const buckets = await runAxe(
      page,
      {
        slug: 'review-editor-diff-comments',
        theme: 'light',
        viewport: narrowViewport.name,
        fixture: 'assertion',
      },
      { include: '#example-mount-diff-comments' },
    );
    expectNoViolations('review-editor-diff-comments (320px)', buckets);
  });
});
