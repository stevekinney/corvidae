import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  FIXTURE_PENDING_HIGHLIGHT_REGION_SELECTOR,
  PENDING_HIGHLIGHT_SELECTOR,
} from './component-sweep.ts';

test('waits for ordinary highlighters while excluding a fixture-controlled pending region', () => {
  const document = new Window().document;
  document.body.innerHTML = `
    <section data-cinder-fixture-highlight-pending>
      <code data-cinder-highlight-state="pending"></code>
    </section>
    <code data-cinder-highlight-state="pending"></code>
  `;

  const uncontrolled = [...document.querySelectorAll(PENDING_HIGHLIGHT_SELECTOR)].filter(
    (element) => element.closest(FIXTURE_PENDING_HIGHLIGHT_REGION_SELECTOR) === null,
  );
  expect(uncontrolled).toHaveLength(1);
});
