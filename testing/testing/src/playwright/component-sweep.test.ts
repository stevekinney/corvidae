import { expect, test } from 'bun:test';
import { setupHappyDom } from '../helpers/happy-dom.ts';

import {
  FIXTURE_PENDING_HIGHLIGHT_REGION_SELECTOR,
  PENDING_HIGHLIGHT_SELECTOR,
  hasTouchForViewport,
} from './component-sweep.ts';

test('waits for ordinary highlighters while excluding a fixture-controlled pending region', () => {
  setupHappyDom();
  const fixture = document.createElement('div');
  fixture.innerHTML = `
    <section data-cinder-fixture-highlight-pending>
      <code data-cinder-highlight-state="pending"></code>
    </section>
    <code data-cinder-highlight-state="pending"></code>
  `;

  const uncontrolled = [...fixture.querySelectorAll(PENDING_HIGHLIGHT_SELECTOR)].filter(
    (element) => element.closest(FIXTURE_PENDING_HIGHLIGHT_REGION_SELECTOR) === null,
  );
  expect(uncontrolled).toHaveLength(1);
});

test('uses coarse-pointer emulation for the mobile fixture profile only', () => {
  expect(hasTouchForViewport({ name: 'mobile', width: 375, height: 900 })).toBe(true);
  expect(hasTouchForViewport({ name: 'tablet', width: 768, height: 900 })).toBe(false);
  expect(hasTouchForViewport({ name: 'desktop', width: 1280, height: 900 })).toBe(false);
});
