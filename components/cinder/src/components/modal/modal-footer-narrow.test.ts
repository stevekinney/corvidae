/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { parse } from 'postcss';
import { createRawSnippet } from 'svelte';

import { resetScrollLock } from '../../_internal/overlay.ts';
import { DEFAULT_TEST_VIEWPORT, setTestViewportWidth } from '../../test/viewport.ts';
import { emptySnippet, installModalDialogStubs } from './modal-test-helpers.ts';

setupHappyDom();
installModalDialogStubs();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Modal } = await import('./modal.svelte');

const modalCss = await Bun.file(new URL('./modal.css', import.meta.url)).text();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  setTestViewportWidth(DEFAULT_TEST_VIEWPORT.width);
});

/** What the footer rule declares for a property, outside the media queries. */
function footerDeclaration(property: string): string | undefined {
  let value: string | undefined;
  parse(modalCss).walkRules((rule) => {
    if (!rule.selectors.includes('.cinder-modal__footer')) return;
    if (rule.parent?.type === 'atrule' && 'name' in rule.parent && rule.parent.name === 'media') {
      return;
    }
    rule.walkDecls(property, (declaration) => {
      value = declaration.value;
    });
  });
  return value;
}

const threeButtons = createRawSnippet(() => ({
  render: () =>
    '<span><button type="button">Remove key</button><button type="button">Replace key</button><button type="button">Save</button></span>',
  setup: () => {},
}));

// The Manage dialog of Interborough puts three buttons in the footer. A 320px dialog has no room for
// them on one line, and a footer that does not wrap clips the first (COR-2160).
describe('Modal footer at 320px with three buttons', () => {
  test('holds all three buttons, and its rule wraps them while keeping the end alignment and gap', async () => {
    setTestViewportWidth(320);
    const { container } = render(Modal, {
      open: true,
      title: 'Provider',
      children: emptySnippet,
      footer: threeButtons,
    });
    await waitUntil(() => container.querySelector('.cinder-modal__footer') !== null);

    const buttons = container.querySelectorAll('.cinder-modal__footer button');
    expect([...buttons].map((button) => button.textContent)).toEqual([
      'Remove key',
      'Replace key',
      'Save',
    ]);
    expect(footerDeclaration('display')).toBe('flex');
    expect(footerDeclaration('flex-wrap')).toBe('wrap');
    expect(footerDeclaration('justify-content')).toBe('flex-end');
    expect(footerDeclaration('gap')).toBe('var(--cinder-space-3)');
  });

  test('keeps the bottom sheet’s stacked footer one column, so the row wrap never reaches it', () => {
    const sheetFooter: Record<string, string> = {};
    parse(modalCss).walkRules((rule) => {
      if (
        !rule.selectors.includes(".cinder-modal[data-cinder-sheet='docked'] .cinder-modal__footer")
      ) {
        return;
      }
      rule.walkDecls((declaration) => {
        sheetFooter[declaration.prop] = declaration.value;
      });
    });
    expect(sheetFooter['flex-direction']).toBe('column-reverse');
    expect(sheetFooter['flex-wrap']).toBe('nowrap');
  });
});
