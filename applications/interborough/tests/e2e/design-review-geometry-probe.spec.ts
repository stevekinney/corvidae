/**
 * The geometry probe (`design-review-geometry-probe.ts`) on a page built to break the rules a real
 * page rarely does, so each has a positive control: the probe has to see the defect, and the audit
 * (`scripts/design-review-geometry.ts`) has to name it. The page needs no server.
 */
import { expect, test } from '@playwright/test';

import { auditCapture, type GeometryCapture } from '@lostgradient/testing/design-review-geometry';
import { measureGeometry } from '@lostgradient/testing/design-review-geometry-probe';

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

/**
 * A phone page with a finger on it: each rule that reads the hit area, what covers what, the edges
 * siblings share, a box's insets and the fixed chrome has one element built to break it and one
 * beside it built to pass.
 */
const TOUCH_PAGE = `
  <style>
    :root { --cinder-space-0: 0; --cinder-space-2: 0.5rem; --cinder-space-3: 0.75rem; --cinder-space-4: 1rem; }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body { display: flex; flex-direction: column; font: 14px/1.5 sans-serif; }
    button { font: inherit; margin: 0; }
    .scroller { flex: 1; min-height: 0; overflow-y: auto; position: relative; padding: 0 16px; }
    .scroller::after {
      content: ''; position: sticky; bottom: 0; display: block; height: 24px; margin-top: -24px;
      background: linear-gradient(to bottom, transparent, #fff); pointer-events: none;
    }
    .grown { height: 44px; padding: 0 24px; border: 1px solid #ccc; background: #fff; }
    .compact { position: relative; height: 32px; padding: 0 24px; border: 1px solid #ccc; background: #fff; }
    .compact::before { content: ''; position: absolute; inset: -7px 0; }
    /* The transparent-border hit target a Cinder Chat fix run gave Button: a compact face in a 44px box. */
    .padded { min-height: 44px; padding: 6px 8px; border: 8px solid transparent; background: #fff; background-clip: padding-box; font-size: 13px; line-height: 16px; }
    .bare { height: 28px; padding: 0 24px; border: 1px solid #ccc; background: #fff; }
    .icons { display: flex; margin: 8px 0; }
    .icons button { width: 48px; height: 44px; border: 0; background: none; padding: 0; }
    .icons.tight button { position: relative; width: 28px; height: 28px; }
    .icons.tight button::before { content: ''; position: absolute; inset: -8px; }
    .icons svg { width: 14px; height: 14px; display: block; margin: auto; }
    .code { position: relative; margin: 8px 0; }
    .code pre { margin: 0; white-space: pre; }
    .copy { position: absolute; top: 0; left: 0; height: 44px; width: 60px; border: 1px solid #ccc; background: #fff; }
    .steps > * { margin: 8px 0 0; }
    .steps .b { padding-left: 8px; }
    .steps .c { padding-left: 25px; }
    .steps .d { padding-left: 33px; }
    .aligned > * { margin: 8px 0 0; }
    .aligned .sent { margin-left: auto; width: 120px; }
    .alert { margin-top: 8px; padding: 26px 12px 12px; background: #fee; }
    .even { margin-top: 8px; padding: 12px; background: #eef; }
    .filler { height: 240px; }
    .last { height: 44px; padding: 0 24px; border: 1px solid #ccc; background: #fff; display: block; margin-top: 8px; }
    .dock { position: relative; height: 260px; padding: 12px 16px; background: #f4f4f4; }
    .docked { position: relative; display: block; height: 32px; width: 120px; border: 1px solid #ccc; background: #fff; }
    .docked::before { content: ''; position: absolute; inset: -7px 0; }
    .badge { position: absolute; top: 36px; left: 100px; width: 120px; height: 20px; background: #ddd; }
  </style>
  <div class="scroller">
    <button class="grown">Deny</button>
    <button class="compact">Allow</button>
    <button class="bare">Skip</button>
    <button class="padded">Hold</button>
    <div class="icons loose">
      <button aria-label="Copy"><svg viewBox="0 0 14 14"><rect width="14" height="14" /></svg></button>
      <button aria-label="Quote"><svg viewBox="0 0 14 14"><rect width="14" height="14" /></svg></button>
    </div>
    <div class="icons tight">
      <button aria-label="Like"><svg viewBox="0 0 14 14"><rect width="14" height="14" /></svg></button>
      <button aria-label="Share"><svg viewBox="0 0 14 14"><rect width="14" height="14" /></svg></button>
    </div>
    <div class="steps"><p class="a">One</p><p class="b">Two</p><p class="c">Three</p><p class="d">Four</p></div>
    <div class="aligned"><p>Received</p><p class="sent">Sent</p><p>Received again</p></div>
    <div class="alert">Answer incomplete</div>
    <div class="even">Even</div>
    <div class="filler"></div>
    <div class="code"><pre><code>select total from orders</code></pre><button class="copy">Copy</button></div>
    <button class="last">Approve</button>
  </div>
  <div class="dock">Composer<div><button class="docked">Send</button></div><span class="badge">Draft saved</span></div>
`;

test('the probe measures hit areas, covering, sibling edges, insets and fixed chrome under touch', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.setContent(TOUCH_PAGE);
  // The last button ends where the scroller does, under the fade.
  await page.locator('.scroller').evaluate((scroller) => {
    const last = scroller.querySelector('.last');
    if (last === null) throw new Error('The fixture has no last button.');
    scroller.scrollTop = 0;
    const visibleBottom = scroller.getBoundingClientRect().bottom;
    scroller.scrollTop = last.getBoundingClientRect().bottom - visibleBottom;
  });
  const facts = await measureGeometry(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  expect(facts.pointerCoarse).toBe(true);
  const hit = (selector: string): number | undefined =>
    facts.controls.find((control) => control.name === selector)?.hit.height;
  expect(hit('button.grown')).toBe(44);
  expect(hit('button.compact')).toBe(44);
  expect(hit('button.bare')).toBe(28);
  expect(facts.chrome).toEqual({ name: 'div.scroller', top: 0, bottom: 260 });

  const found = auditCapture(facts, { ...capture, width: 320 });
  const subjects = (rule: string): string[] =>
    found.filter((finding) => finding.rule === rule).map((finding) => finding.subject);

  // Drawn at the touch minimum is oversized; drawn compact with a taller hit area is the pattern.
  expect(subjects('target-oversized')).toEqual(['button.grown', 'button.copy', 'button.last']);
  expect(subjects('target-undersized')).toEqual(['button.bare']);
  // A transparent border is room the button takes, not face: size and padding are read inside it.
  const padded = facts.controls.find((control) => control.name === 'button.padded');
  expect(padded?.layout.height).toBe(44);
  expect(padded?.rect.height).toBe(28);
  expect(subjects('hit-takes-space')).toEqual(['button.padded', 'button', 'button']);
  expect(subjects('button-padding-ratio')).toEqual(['button.padded', 'button.copy']);
  expect(subjects('icon-pitch')).toEqual(['button and button']);
  expect(found.filter((finding) => finding.rule === 'icon-pitch')[0]?.measured).toContain(
    '"Copy" and "Quote"',
  );
  // The badge sits on the docked button; what the copy button hides inside the scroller, a swipe
  // reveals, so only its lying on the code counts there.
  expect(subjects('occluded')).toEqual([
    'button.docked under span.badge',
    'button.last under the fade of div.scroller',
    'button.copy over code',
  ]);
  // Four left edges break the rule; a sent message pushed to the trailing side is not an edge.
  expect(subjects('edge-many')).toEqual(['div.steps left edges']);
  expect(subjects('inset-uneven')).toEqual(['div.alert']);
  expect(subjects('chrome-share')).toEqual(['chrome below div.scroller']);
});

/**
 * Compact buttons whose styles claim a 44 pixel hit area, on a touch screen. Three lose part of it
 * the way a Cinder Chat fix run lost it (a parent that clips the overhang, the next row painted
 * over it, a bar on the last pixels of the face); the rest keep it or share it with a neighbor.
 */
const REACH_PAGE = `
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 24px; font: 14px/1.5 sans-serif; }
    button { font: inherit; margin: 0; }
    section { margin-bottom: 32px; }
    .compact { position: relative; display: block; height: 28px; padding: 0 24px; border: 1px solid #ccc; background: #fff; }
    .compact::before { content: ''; position: absolute; inset: -9px -1px; }
    .card { overflow: hidden; padding: 4px; background: #eee; }
    .line { height: 28px; }
    .next { position: relative; height: 28px; background: #eef; }
    .holder { position: relative; width: 120px; }
    .barred { display: block; width: 120px; height: 44px; border: 1px solid #ccc; background: #fff; }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #06c; }
    .icons { display: flex; }
    .icons button { position: relative; width: 28px; height: 28px; border: 0; background: none; padding: 0; }
    .icons button::before { content: ''; position: absolute; inset: -8px; }
    .icons svg { width: 14px; height: 14px; display: block; margin: auto; }
    .touching { display: flex; }
    .touching button { width: 44px; height: 44px; border: 0; background: #ddd; padding: 0; }
    .scroller { height: 80px; overflow-y: auto; }
    .scroller .filler { height: 200px; }
  </style>
  <section><button class="compact free">Free</button></section>
  <section class="card"><button class="compact clipped">Clipped</button></section>
  <section><div class="line"><button class="compact first">First</button></div><div class="next">Next row</div></section>
  <section class="holder"><button class="barred">Barred</button><div class="bar"></div></section>
  <section class="icons">
    <button aria-label="Like"><svg viewBox="0 0 14 14"><rect width="14" height="14" /></svg></button>
    <button aria-label="Share"><svg viewBox="0 0 14 14"><rect width="14" height="14" /></svg></button>
  </section>
  <section class="touching"><button aria-label="Back">‹</button><button aria-label="Forward">›</button></section>
  <section class="scroller"><button class="compact scrolled">Scrolled</button><div class="filler"></div></section>
`;

test('the probe asks the browser whether a tap reaches each hit area, and the audit names the ones it does not', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.setContent(REACH_PAGE);
  const facts = await measureGeometry(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  expect(facts.pointerCoarse).toBe(true);
  const unreached = Object.fromEntries(
    facts.controls.map((control) => [
      control.text === '' ? control.accessibleLabel : control.text,
      control.unreached,
    ]),
  );
  expect(unreached).toEqual({
    // Room around it, so every side answers.
    Free: [],
    // The card's 4 pixels of padding are less than the 9 pixel overhang, and it clips the rest.
    Clipped: ['above (reaches body)', 'below (reaches body)'],
    // The next row is positioned, so it paints over the overhang and takes the tap.
    First: ['below (reaches div.next)'],
    // A 2 pixel bar on the last pixels of the face, which the covering check's inset steps over.
    Barred: ['below (reaches div.bar)'],
    // Compact neighbors share their overhang, and two 44 pixel boxes meet at an edge.
    Like: [],
    Share: [],
    '‹': [],
    '›': [],
    // The point above it is outside the scroller's visible box, which a swipe changes.
    Scrolled: [],
  });
  const found = auditCapture(facts, { ...capture, width: 375 });
  expect(
    found.filter((finding) => finding.rule === 'hit-unreached').map((finding) => finding.subject),
  ).toEqual(['button.compact', 'button.compact', 'button.barred']);
  expect(found.some((finding) => finding.rule === 'occluded')).toBe(false);
});
