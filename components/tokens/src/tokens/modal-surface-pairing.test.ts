/**
 * COR-2448 AC6: in light, the Modal surface is the popover white, not the page gray.
 *
 * The pairing is by token: the dialog paints every one of its surfaces (panel, header, body,
 * footer, docked sheet) with the token a popover paints with, `--cinder-surface-raised`, and never
 * with the canvas or the inset band. The light theme's value for that token is read from the
 * resolved context, so the test fails if either side of the pairing drifts.
 */

import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

import { readJsonRecord } from '../styles/token-contrast-test-readers.ts';

const modalCss = await Bun.file(
  new URL('../../../core/src/components/modal/modal.css', import.meta.url),
).text();
const drawerCss = await Bun.file(
  new URL('../../../drawer/src/components/drawer/drawer.css', import.meta.url),
).text();
const popoverCss = await Bun.file(
  new URL('../../../core/src/components/popover/popover.css', import.meta.url),
).text();

/** Every `background` value a rule of `css` declares, keyed by its selector. */
function backgrounds(css: string): Map<string, string> {
  const result = new Map<string, string>();
  parse(css).walkRules((rule) => {
    rule.walkDecls('background', (declaration) => {
      result.set(rule.selector, declaration.value);
    });
  });
  return result;
}

function lightValue(property: string): number[] | undefined {
  const context = readJsonRecord(import.meta.dirname, 'resolved', 'light.json');
  for (const token of Object.values(context)) {
    const { $value: value, $extensions: extensions } = token as {
      $value?: { components?: number[] };
      $extensions?: { 'com.lostgradient.cinder'?: { cssProperty?: string } };
    };
    if (extensions?.['com.lostgradient.cinder']?.cssProperty === property) {
      return value?.components;
    }
  }
  return undefined;
}

describe('Modal surface pairing (COR-2448 AC6)', () => {
  test('the Modal paints with the token the popover paints with', () => {
    const popover = backgrounds(popoverCss).get('.cinder-popover');
    expect(popover).toBe('var(--cinder-surface-raised)');
    const modal = backgrounds(modalCss);
    for (const selector of [
      '.cinder-modal__panel',
      '.cinder-modal__header',
      '.cinder-modal__body',
      '.cinder-modal__footer',
      ".cinder-modal[data-cinder-sheet='docked'] .cinder-modal__panel",
    ]) {
      expect(modal.get(selector), selector).toBe(popover);
    }
  });

  // The Drawer is the same sheet in the same dark theme: a bottom drawer and a docked dialog must
  // not paint two different surfaces (header and body on the page surface under a lighter strip).
  test('the Drawer paints every one of its surfaces with the Modal token', () => {
    const popover = backgrounds(popoverCss).get('.cinder-popover');
    const drawer = backgrounds(drawerCss);
    for (const selector of [
      '.cinder-drawer__panel',
      '.cinder-drawer__header',
      '.cinder-drawer__body',
      '.cinder-drawer__footer',
      '.cinder-drawer__peek',
    ]) {
      expect(drawer.get(selector), selector).toBe(popover);
    }
  });

  test('in light that token is the popover white, apart from the page canvas', () => {
    expect(lightValue('--cinder-surface-raised')).toEqual([1, 0, 255]);
    expect(lightValue('--cinder-surface-raised')).not.toEqual(
      lightValue('--cinder-surface-canvas'),
    );
  });
});
