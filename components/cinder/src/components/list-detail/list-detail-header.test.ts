/// <reference lib="dom" />
/**
 * ListDetail's pane header is the same height with and without actions (COR-2388): its actions
 * draw at the compact control height, and the header is never shorter than a row of them, so
 * rendering them does not grow it. happy-dom has no layout engine, so these read what the
 * stylesheet and the rendered buttons declare.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte/pure');
const { default: Harness } = await import('./list-detail-header-actions.test.svelte');

const stylesheet = readFileSync(new URL('./list-detail.css', import.meta.url), 'utf8');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ListDetail pane header with actions', () => {
  test('its buttons draw at the compact height, so they never grow the header', () => {
    const { getByRole } = render(Harness, { props: { withActions: true } });
    const button = getByRole('button', { name: 'New chat' });
    expect(button.getAttribute('data-cinder-size')).toBe('xs');
    expect(button.hasAttribute('data-cinder-compact')).toBe(true);
  });

  test('the header is at least a row of compact actions tall, with or without them', () => {
    const header = declarationsFor(stylesheet, '.cinder-list-detail__header');
    expect(header.get('min-block-size')).toBe(
      'calc(var(--cinder-space-4) * 2 + var(--_cinder-compact-control-height))',
    );
    expect(header.get('box-sizing')).toBe('border-box');
    expect(header.get('padding')).toBe('var(--cinder-space-4)');
    for (const withActions of [false, true]) {
      const { container } = render(Harness, { props: { withActions } });
      expect(container.querySelectorAll('.cinder-list-detail__header')).toHaveLength(1);
      cleanup();
    }
  });
});
