/**
 * COR-2312: a SegmentedControl is as wide as its options and no wider, never wraps, scrolls
 * sideways with no scrollbar when it runs out of room, and draws its selected segment with a ring
 * that clears 3:1 against the track. These pin the stylesheet that produces that, because
 * happy-dom has no layout engine.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { declarationsFor } from '../../test/css.ts';
import { CONTRAST_PAIRINGS } from '../../tokens/runtime/index.ts';

const css = readFileSync(new URL('./segmented-control.css', import.meta.url), 'utf8');

describe('SegmentedControl width', () => {
  test('the track is max-content, never wraps and never stretches in its column', () => {
    const track = declarationsFor(css, '.cinder-segmented-control');
    expect(track.get('inline-size')).toBe('max-content');
    expect(track.get('flex-wrap')).toBe('nowrap');
    expect(track.get('align-self')).toBe('flex-start');
  });

  test('the container scrolls sideways with its scrollbar hidden and keeps room for focus rings', () => {
    const container = declarationsFor(css, '.cinder-segmented-control-container');
    expect(container.get('inline-size')).toBe('fit-content');
    expect(container.get('overflow-x')).toBe('auto');
    expect(container.get('scrollbar-width')).toBe('none');
    expect(container.get('max-inline-size')).toBe(
      'calc(100% + 2 * var(--_cinder-segmented-control-ring-room))',
    );
    expect(container.get('padding')).toBe('var(--_cinder-segmented-control-ring-room)');
    expect(container.get('margin')).toBe('calc(-1 * var(--_cinder-segmented-control-ring-room))');
    expect(
      declarationsFor(css, '.cinder-segmented-control-container::-webkit-scrollbar').get('display'),
    ).toBe('none');
  });

  test('fullWidth is the one explicit opt-in that spans the container', () => {
    const track = declarationsFor(css, '.cinder-segmented-control[data-cinder-full-width]');
    expect(track.get('inline-size')).toBe('100%');
    expect(track.get('align-self')).toBe('stretch');
  });
});

describe('SegmentedControl selection indicator', () => {
  test('the selected and pressed segments draw a control-tier ring inside their edge', () => {
    for (const selector of [
      '.cinder-segmented-control-option[data-cinder-selected]',
      '.cinder-segmented-control-option[data-cinder-pressed]',
    ]) {
      expect(declarationsFor(css, selector).get('box-shadow')).toContain(
        'inset 0 0 0 1px var(--cinder-border-control)',
      );
    }
  });

  test('the ring is held to 3:1 against the track and the pill by the contrast pairings', () => {
    const pairings = CONTRAST_PAIRINGS.filter((pairing) =>
      pairing.id.startsWith('segmented-control:selected-indicator:'),
    );
    expect(pairings.map((pairing) => pairing.background).toSorted()).toEqual([
      '--cinder-surface-inset',
      '--cinder-surface-raised',
    ]);
    for (const pairing of pairings) {
      expect(pairing.foreground).toBe('--cinder-border-control');
      expect(pairing.classification).toBe('non-text-indicator');
      expect(pairing.scope).toBe('wcag');
    }
  });

  test('the off Toggle track is held to 3:1 on every surface by the contrast pairings', () => {
    const pairings = CONTRAST_PAIRINGS.filter((pairing) =>
      pairing.id.startsWith('toggle:track-off:'),
    );
    expect(pairings).toHaveLength(4);
    for (const pairing of pairings) {
      expect(pairing.foreground).toBe('--cinder-toggle-track-off-resting');
      expect(pairing.classification).toBe('non-text-indicator');
      expect(pairing.scope).toBe('wcag');
    }
  });
});
