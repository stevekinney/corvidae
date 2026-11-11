/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Input } = await import('./input.svelte');

describe('Input bare variant (an editable title)', () => {
  test('sets data-cinder-variant on the input and on the field wrapper', () => {
    const { container } = render(Input, {
      props: { id: 'title', value: 'Plan', label: 'Title', labelVisible: false, variant: 'bare' },
    });
    expect(container.querySelector('input')?.getAttribute('data-cinder-variant')).toBe('bare');
    expect(
      container.querySelector('.cinder-input-field')?.getAttribute('data-cinder-variant'),
    ).toBe('bare');
  });

  test('stylesheet draws a title with no border at rest, a hover tint and a control-fill focus', async () => {
    const css = await Bun.file(new URL('./input.css', import.meta.url)).text();
    expect(css).toMatch(
      /\.cinder-input\[data-cinder-variant='bare'\]\s*\{[^}]*font-weight:\s*var\(--cinder-font-semibold\)/s,
    );
    expect(css).toMatch(
      /\.cinder-input\[data-cinder-variant='bare'\]\s*\{[^}]*border-color:\s*transparent/s,
    );
    expect(css).toMatch(
      /\.cinder-input\[data-cinder-variant='bare'\]:hover[^{]*\{[^}]*background:\s*var\(--cinder-surface-hover\)/s,
    );
    expect(css).toMatch(
      /\.cinder-input\[data-cinder-variant='bare'\]:focus-visible\s*\{[^}]*background:\s*var\(--cinder-control-background\)/s,
    );
  });

  test('field-sizing only applies where the platform supports it', async () => {
    const css = await Bun.file(new URL('./input.css', import.meta.url)).text();
    expect(css).toMatch(
      /@supports \(field-sizing: content\) \{\s*\.cinder-input\[data-cinder-variant='bare'\]\s*\{[^}]*field-sizing:\s*content/s,
    );
  });
});
