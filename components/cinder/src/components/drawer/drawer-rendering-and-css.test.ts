/// <reference lib="dom" />
import { setupHappyDom } from '@lostgradient/testing';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { parse } from 'postcss';
import { resetEscapeStack, resetScrollLock } from '../../_internal/overlay.ts';
import {
  emptySnippet,
  installDrawerDialogStubs,
  installDrawerStyleProbe,
} from './drawer-test-helpers.ts';

setupHappyDom();
installDrawerDialogStubs();
const restoreDrawerStyles = installDrawerStyleProbe();
const { cleanup, render } = await import('@testing-library/svelte');
const { default: Drawer } = await import('./drawer.svelte');
const drawerCss = await Bun.file(new URL('./drawer.css', import.meta.url)).text();

afterAll(() => {
  restoreDrawerStyles();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetScrollLock();
  resetEscapeStack();
});
describe('Drawer', () => {
  test('drag handle is absent by default (dragHandleVisible=false)', () => {
    const { container } = render(Drawer, {
      props: { open: true, placement: 'bottom', title: 'Test', children: emptySnippet },
    });
    expect(container.querySelector('.cinder-drawer__drag-handle')).toBeNull();
  });
  test('drag handle renders when dragHandleVisible=true with aria-hidden="true"', () => {
    const { container } = render(Drawer, {
      props: {
        open: true,
        placement: 'bottom',
        title: 'Test',
        dragHandleVisible: true,
        children: emptySnippet,
      },
    });
    const handle = container.querySelector('.cinder-drawer__drag-handle');
    expect(handle).not.toBeNull();
    expect(handle?.getAttribute('aria-hidden')).toBe('true');
  });
  test('drag handle never renders on side placements even when dragHandleVisible=true', () => {
    const { container } = render(Drawer, {
      props: {
        open: true,
        placement: 'right',
        title: 'Test',
        dragHandleVisible: true,
        children: emptySnippet,
      },
    });
    expect(container.querySelector('.cinder-drawer__drag-handle')).toBeNull();
  });
  test('drawer.css close button meets 44px touch target (2.75rem × 2.75rem)', async () => {
    const cssText = drawerCss;
    const closeRule = cssText.split('.cinder-drawer__close {')[1]?.split('}')[0];
    expect(closeRule).toContain('width: 2.75rem');
    expect(closeRule).toContain('height: 2.75rem');
  });
  test('drawer.css drag handle meets 44px touch target', async () => {
    const cssText = drawerCss;
    const handleRule = cssText.split('.cinder-drawer__drag-handle {')[1]?.split('}')[0];
    expect(handleRule).toMatch(/min-height:\s*(?:2\.75rem|var\(--cinder-touch-target-min\))/);
  });
  test('drawer.css caps the bottom panel and keeps overflow inside the body', async () => {
    const cssText = drawerCss;

    expect(cssText).toMatch(
      /\.cinder-drawer__panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s,
    );
    expect(cssText).toMatch(
      /\.cinder-drawer__panel\[data-cinder-placement='bottom'\]\s*\{[^}]*max-height:\s*90dvh;/s,
    );
    expect(cssText).not.toMatch(/max-block-size:\s*90dvh;/s);
    expect(cssText).toMatch(
      /\.cinder-drawer__body\s*\{[^}]*flex:\s*1;[^}]*min-block-size:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
    expect(cssText).toMatch(/\.cinder-drawer__header\s*\{[^}]*flex-shrink:\s*0;/s);
    expect(cssText).toMatch(/\.cinder-drawer__footer\s*\{[^}]*flex-shrink:\s*0;/s);
  });
  test('body uses the panel surface beneath header and footer', async () => {
    const cssText = drawerCss;
    expect(cssText).toMatch(
      /\.cinder-drawer__body\s*\{[^}]*background:\s*var\(--cinder-surface\)/s,
    );
  });

  // ---------------------------------------------------------------------------
  // Motion contract: every placement must have BOTH a closing rule and a
  // matching @starting-style rule, or that placement pops in with no from-state
  // while the backdrop fades (the asymmetric "eases out, pops in" defect).
  // ---------------------------------------------------------------------------
});

// COR-1552: a non-modal Drawer is a side panel, so it reads as a region of the page rather than a
// raised sheet: the panel is the inset surface, and the header, body and footer are transparent so
// that one surface shows through. Modal drawers keep the raised panel and the stacked surfaces.
describe('Drawer surfaces by mode (COR-1552)', () => {
  const NON_MODAL = ".cinder-drawer[data-cinder-modal='false']";

  /** The last value any rule with this exact selector gives the property. */
  function declared(selector: string, property: string): string | undefined {
    let value: string | undefined;
    parse(drawerCss).walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls(property, (declaration) => {
        value = declaration.value;
      });
    });
    return value;
  }

  test('a non-modal panel paints the inset surface', () => {
    expect(declared(`${NON_MODAL} .cinder-drawer__panel`, 'background')).toBe(
      'var(--cinder-surface-inset)',
    );
  });

  test('a non-modal header, body and footer paint transparent', () => {
    for (const part of ['header', 'body', 'footer']) {
      expect(declared(`${NON_MODAL} .cinder-drawer__${part}`, 'background'), part).toBe(
        'transparent',
      );
    }
  });

  test('a non-modal body fades its scroll edge into the inset surface', () => {
    expect(declared(`${NON_MODAL} .cinder-drawer__body`, '--_cinder-scroll-fade-color')).toBe(
      'var(--cinder-surface-inset)',
    );
  });

  test('a modal drawer is unchanged: raised panel, surface header, body and footer', () => {
    expect(declared('.cinder-drawer__panel', 'background')).toBe('var(--cinder-surface-raised)');
    expect(declared('.cinder-drawer__header', 'background')).toBe('var(--cinder-surface)');
    expect(declared('.cinder-drawer__body', 'background')).toBe('var(--cinder-surface)');
    expect(declared('.cinder-drawer__body', '--_cinder-scroll-fade-color')).toBe(
      'var(--cinder-surface)',
    );
    expect(declared('.cinder-drawer__footer', 'background')).toBe('var(--cinder-surface)');
  });
});
