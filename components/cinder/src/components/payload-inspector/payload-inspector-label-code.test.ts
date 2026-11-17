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
  test('reads "Output, notes" with the name in code, and names the card the same', () => {
    const view = render(PayloadInspector, {
      value: { content: 'Release notes for 1.3.0' },
      label: 'Output',
      labelCode: 'notes',
    });
    const label = view.container.querySelector('.cinder-payload-inspector__label');
    expect(label?.textContent).toBe('Output, notes');
    expect(label?.querySelector('code')?.textContent).toBe('notes');
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
