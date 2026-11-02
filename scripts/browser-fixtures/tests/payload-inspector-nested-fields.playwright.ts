import { loadManifest, VIEWPORTS } from '@lostgradient/testing';

import { expect, test } from './component-page-fixture.ts';

// A nested field sits inside its parent's value column. The label column's 8rem minimum used to
// compound with each level, so at the review editor's front-matter width a nested row ran past the
// panel's edge and the panel became a scroll region with nothing focusable in it (axe
// `scrollable-region-focusable`). The fields view must fit its panel at every nesting depth.
test('payload inspector fields fit their panel in the review editor front matter', async ({
  componentPage,
}) => {
  const entry = loadManifest().find((candidate) => candidate.slug === 'review-editor');
  if (entry === undefined) throw new Error('Missing review-editor manifest entry.');
  const viewport = VIEWPORTS.find((candidate) => candidate.name === 'desktop');
  if (viewport === undefined) throw new Error('Missing desktop viewport.');
  const page = await componentPage.open({
    entry,
    theme: 'light',
    viewport,
    fixtureName: 'assertion',
  });

  const panels = page.locator('.cinder-payload-inspector__panel');
  await expect(panels.first()).toBeVisible();
  const overflow = await panels.evaluateAll((elements) =>
    elements.map((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    })),
  );
  expect(overflow.length).toBeGreaterThan(0);
  for (const panel of overflow) expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
});
