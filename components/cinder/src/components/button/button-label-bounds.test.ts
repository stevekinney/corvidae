/**
 * COR-2339: a long label never widens a Button past its container. The button caps at the
 * container's inline size, the label truncates with an ellipsis, and the full words stay the
 * accessible name. happy-dom has no layout engine, so the "no horizontal overflow" half pins the
 * CSS that produces it (the cap, the shrinkable label box and the ellipsis) and the narrow
 * container half checks the rendered structure and name.
 */
import { setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { declarationsFor } from '../../test/css.ts';

setupHappyDom();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Button } = await import('./button.svelte');
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const css = readFileSync(new URL('./button.css', import.meta.url), 'utf8');
const LONG_LABEL = 'Schedule the weekly review for every Friday afternoon at four';

describe('a long Button label is bounded by its container', () => {
  test('the button caps at its container and its label truncates with an ellipsis', () => {
    expect(declarationsFor(css, '.cinder-button').get('max-inline-size')).toBe('100%');
    expect(declarationsFor(css, '.cinder-button').get('white-space')).toBe('nowrap');
    // A button holding a label may shrink below its words inside a flex or grid row.
    expect(
      declarationsFor(css, '.cinder-button:has(> .cinder-button__label)').get('min-inline-size'),
    ).toBe('0');

    const label = declarationsFor(css, '.cinder-button__label');
    expect(label.get('min-inline-size')).toBe('0');
    expect(label.get('overflow')).toBe('hidden');
    expect(label.get('text-overflow')).toBe('ellipsis');
    expect(label.get('white-space')).toBe('nowrap');
  });

  test('the icons and the shortcut hint keep their room while the label gives it up', () => {
    expect(declarationsFor(css, '.cinder-button__icon').get('flex-shrink')).toBe('0');
    expect(declarationsFor(css, '.cinder-button__shortcut').get('flex-shrink')).toBe('0');
  });

  test('the root itself does not clip, so the compact hit-area extension stays reachable', () => {
    expect(declarationsFor(css, '.cinder-button').has('overflow')).toBe(false);
  });

  test('in a narrow container the label sits in its own box and the name keeps every word', () => {
    const narrow = document.createElement('div');
    narrow.style.inlineSize = '120px';
    document.body.append(narrow);
    const { getByRole } = render(Button, { target: narrow, props: { label: LONG_LABEL } });

    const button = getByRole('button', { name: LONG_LABEL });
    const labelBox = button.querySelector('.cinder-button__label');
    expect(labelBox?.parentElement).toBe(button);
    expect(labelBox?.textContent).toBe(LONG_LABEL);
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(narrow.contains(button)).toBe(true);
  });

  test('an anchor button bounds its label the same way', () => {
    const { getByRole } = render(Button, { props: { label: LONG_LABEL, href: '/reviews' } });
    const link = getByRole('link', { name: LONG_LABEL });
    expect(link.querySelector('.cinder-button__label')?.textContent).toBe(LONG_LABEL);
  });
});
