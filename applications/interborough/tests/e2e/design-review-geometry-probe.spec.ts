/**
 * The geometry probe (`design-review-geometry-probe.ts`) on a page built to break the rules a real
 * page rarely does, so each has a positive control: the probe has to see the defect, and the audit
 * (`scripts/design-review-geometry.ts`) has to name it. The page needs no server.
 */
import { expect, test } from '@playwright/test';

import { auditCapture, type GeometryCapture } from '../../scripts/design-review-geometry.ts';
import { measureGeometry } from './design-review-geometry-probe.ts';

const PAGE = `
  <style>
    :root { --cinder-space-0: 0; --cinder-space-2: 0.5rem; --cinder-space-3: 0.75rem; --cinder-space-4: 1rem; }
    body { margin: 0; font: 14px/1.5 sans-serif; }
    main { padding: 16px; }
    .wrapper { padding-left: 24px; }
    .row { display: flex; justify-content: flex-end; }
    .tall { height: 56px; padding: 0 44px; border: 1px solid #ccc; background: #fff; font-size: 13px; }
    .squat { height: 32px; padding: 0 9px; border: 1px solid #ccc; background: #fff; font-size: 13px; line-height: 1; }
    .thick { border: 2px solid #ddd; padding: 8px; }
    ul { list-style: none; margin: 16px 0 0; padding: 0; }
    li + li { margin-top: 8px; }
    li.item.late { margin-top: 12px; }
    .title { padding-left: 2px; }
  </style>
  <main>
    <section class="wrapper">
      <h2 class="heading">Refunds</h2>
      <div class="row"><span class="value">Open</span></div>
    </section>
    <button class="tall">Approve</button>
    <button class="squat">Save</button>
    <div class="thick">Boxed</div>
    <ul class="list"><li class="item">One</li><li class="item">Two</li><li class="item late">Three</li></ul>
    <p class="plain">First</p><p class="plain">Second</p>
    <p class="title">Third</p><p class="title">Fourth</p>
  </main>
`;

const capture: GeometryCapture = {
  route: '/fixture',
  state: 'ready',
  source: 'design-review-geometry-probe.spec.ts',
  width: 375,
  colorScheme: 'light',
  viewport: 'screens/fixture.png',
};

test('the probe sees each defect on a page built to hold it, and the audit names it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.setContent(PAGE);
  const facts = await measureGeometry(page);

  expect(facts.spaceScale).toEqual([0, 8, 12, 16]);
  expect(facts.pointerCoarse).toBe(false);

  const found = auditCapture(facts, capture);
  const subjects = (rule: string): string[] =>
    found.filter((finding) => finding.rule === rule).map((finding) => finding.subject);

  // The wrapper insets its heading 24 pixels, which passes; the row inside it is the one pushed right.
  expect(subjects('leading-space')).toEqual(['div.row']);
  expect(subjects('target-oversized')).toEqual(['button.tall']);
  expect(subjects('button-padding-ratio')).toEqual(['button.squat']);
  expect(subjects('border-thick')).toEqual(['div.thick']);
  expect(subjects('gap-uneven')).toEqual(['ul.list']);
  expect(subjects('edge-near-miss')).toEqual(['li.item and p.title']);
});
