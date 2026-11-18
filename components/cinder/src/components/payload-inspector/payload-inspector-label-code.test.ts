/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: PayloadInspector } = await import('./payload-inspector.svelte');

beforeEach(() => document.body.replaceChildren());
afterEach(() => cleanup());

describe('a name after the label (labelCode)', () => {
  test('sets the name in code a space after the label, with no comma, and names the card with a pause', () => {
    const view = render(PayloadInspector, {
      value: { content: 'Release notes for 1.3.0' },
      label: 'Output',
      labelCode: 'notes',
    });
    const label = view.container.querySelector('.cinder-payload-inspector__label');
    // The visible pieces are a space apart, the name a weight lighter (stylesheet): no comma.
    expect(label?.textContent).toBe('Output notes');
    expect(label?.textContent).not.toContain(',');
    expect(label?.querySelector('code')?.textContent).toBe('notes');
    // The accessible name keeps the pause.
    expect(view.getByRole('group').getAttribute('aria-label')).toBe('Output, notes');
  });

  test('leaves the label as it is without one, or with an empty one', () => {
    for (const labelCode of [undefined, '']) {
      const view = render(PayloadInspector, {
        value: { content: 'x' },
        label: 'Output',
        ...(labelCode === undefined ? {} : { labelCode }),
      });
      expect(view.container.querySelector('.cinder-payload-inspector__label')?.textContent).toBe(
        'Output',
      );
      expect(view.container.querySelector('.cinder-payload-inspector__label code')).toBeNull();
      cleanup();
    }
  });
});
