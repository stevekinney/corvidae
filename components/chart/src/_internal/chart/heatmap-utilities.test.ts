import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_HEATMAP_RAMP,
  finiteNumbers,
  HEATMAP_EMPTY_FILL,
  HEATMAP_LABEL_LUMINANCE_SWITCH,
  heatmapCellFill,
  heatmapDomain,
  heatmapDomainOfRows,
  heatmapLabelFill,
  heatmapRamp,
  normalizeHeatmapValue,
  toFiniteOrNull,
} from './heatmap-utilities.ts';

describe('finiteNumbers', () => {
  test('drops NaN, Infinity, null, undefined', () => {
    expect(finiteNumbers([1, NaN, 2, Infinity, 3, -Infinity, null, undefined])).toEqual([1, 2, 3]);
  });

  test('returns empty for all-invalid input', () => {
    expect(finiteNumbers([NaN, Infinity, null])).toEqual([]);
  });
});

describe('toFiniteOrNull', () => {
  test('passes finite numbers, nulls everything else', () => {
    expect(toFiniteOrNull(5)).toBe(5);
    expect(toFiniteOrNull(0)).toBe(0);
    expect(toFiniteOrNull(NaN)).toBeNull();
    expect(toFiniteOrNull(Infinity)).toBeNull();
    expect(toFiniteOrNull('5')).toBeNull();
    expect(toFiniteOrNull(null)).toBeNull();
  });
});

describe('heatmapDomain', () => {
  test('ignores non-finite values', () => {
    expect(heatmapDomain([1, NaN, 5, Infinity, 3])).toEqual({ min: 1, max: 5, isEmpty: false });
  });

  test('reports empty when no finite values', () => {
    expect(heatmapDomain([NaN, null]).isEmpty).toBe(true);
  });
});

describe('heatmapDomainOfRows', () => {
  test('matches the flattened domain without materializing a flat array', () => {
    const rows = [
      [1, NaN, 5],
      [3, Infinity],
      [-2, 4],
    ];
    expect(heatmapDomainOfRows(rows)).toEqual({ min: -2, max: 5, isEmpty: false });
  });

  test('reports empty when every row is empty or all-non-finite', () => {
    expect(heatmapDomainOfRows([[], [NaN, Infinity], []]).isEmpty).toBe(true);
  });

  test('handles ragged rows (differing lengths)', () => {
    expect(
      heatmapDomainOfRows([
        [0.2, 0.4],
        [0.5, 0.6, 0.7, 0.8],
      ]),
    ).toEqual({
      min: 0.2,
      max: 0.8,
      isEmpty: false,
    });
  });
});

describe('normalizeHeatmapValue — sequential', () => {
  const domain = heatmapDomain([0, 100]);

  test('maps min→0, max→1, midpoint→0.5', () => {
    expect(normalizeHeatmapValue(0, domain)).toBe(0);
    expect(normalizeHeatmapValue(100, domain)).toBe(1);
    expect(normalizeHeatmapValue(50, domain)).toBe(0.5);
  });

  test('degenerate domain (min === max) maps everything to 0.5', () => {
    const flat = heatmapDomain([7, 7, 7]);
    expect(normalizeHeatmapValue(7, flat)).toBe(0.5);
  });

  test('clamps out-of-domain values into [0,1]', () => {
    expect(normalizeHeatmapValue(-50, domain)).toBe(0);
    expect(normalizeHeatmapValue(200, domain)).toBe(1);
  });

  test('non-finite value normalizes to neutral 0.5', () => {
    expect(normalizeHeatmapValue(NaN, domain)).toBe(0.5);
  });
});

describe('normalizeHeatmapValue — diverging (zero-centered)', () => {
  test('zero maps to 0.5 even for a lopsided domain', () => {
    // Regression: [-10, 30] must still map 0 → 0.5 (neutral), not blue.
    const domain = heatmapDomain([-10, 30]);
    expect(normalizeHeatmapValue(0, domain, 'diverging')).toBe(0.5);
    // +30 is the larger absolute bound → 1.0; -30-equivalent would be 0.
    expect(normalizeHeatmapValue(30, domain, 'diverging')).toBe(1);
    expect(normalizeHeatmapValue(-30, domain, 'diverging')).toBe(0);
  });

  test('all-zero domain maps to neutral', () => {
    const domain = heatmapDomain([0, 0]);
    expect(normalizeHeatmapValue(0, domain, 'diverging')).toBe(0.5);
  });
});

describe('heatmapCellFill', () => {
  test('runs the sequential ramp from the low tint to the strong end of the ramp tokens', () => {
    const domain = heatmapDomain([0, 10]);
    expect(heatmapCellFill(0, domain, 'sequential')).toBe(
      'color-mix(in oklch, var(--cinder-chart-ramp-high) 0%, var(--cinder-chart-ramp-low))',
    );
    expect(heatmapCellFill(10, domain, 'sequential')).toBe(
      'color-mix(in oklch, var(--cinder-chart-ramp-high) 100%, var(--cinder-chart-ramp-low))',
    );
  });

  test('runs the diverging ramp through the neutral middle to each end, in Oklab', () => {
    const domain = heatmapDomain([-10, 10]);
    expect(heatmapCellFill(-5, domain, 'diverging')).toBe(
      'color-mix(in oklab, var(--cinder-chart-ramp-negative) 50%, var(--cinder-chart-ramp-neutral))',
    );
    expect(heatmapCellFill(10, domain, 'diverging')).toBe(
      'color-mix(in oklab, var(--cinder-chart-ramp-positive) 100%, var(--cinder-chart-ramp-neutral))',
    );
  });

  test('an empty cell is the page canvas, never the lowest value', () => {
    expect(heatmapCellFill(null, heatmapDomain([0, 10]))).toBe(HEATMAP_EMPTY_FILL);
    expect(HEATMAP_EMPTY_FILL).toBe('var(--cinder-surface-canvas)');
  });

  test('uses a chart-local palette for sequential and diverging scales', () => {
    const ramp = heatmapRamp(['sequential', 'unused', 'warm', 'unused', 'cool']);
    const domain = heatmapDomain([-10, 10]);

    expect(heatmapCellFill(10, domain, 'sequential', ramp)).toContain('sequential');
    expect(heatmapCellFill(-5, domain, 'diverging', ramp)).toContain('cool');
    expect(heatmapCellFill(5, domain, 'diverging', ramp)).toContain('warm');
  });

  test('keeps diverging ends distinct for a two-color palette', () => {
    const ramp = heatmapRamp(['cool', 'warm']);
    const domain = heatmapDomain([-10, 10]);
    const cool = heatmapCellFill(-10, domain, 'diverging', ramp);
    const warm = heatmapCellFill(10, domain, 'diverging', ramp);

    expect(cool).toContain('cool');
    expect(warm).toContain('warm');
    expect(cool).not.toContain('warm');
  });

  test('without a palette the ramp is the shared ramp tokens', () => {
    expect(heatmapRamp(undefined)).toBe(DEFAULT_HEATMAP_RAMP);
    expect(heatmapRamp([])).toBe(DEFAULT_HEATMAP_RAMP);
  });
});

describe('heatmapLabelFill', () => {
  test("is white or black from the cell's own luminance, never a ramp colour", () => {
    const fill = heatmapLabelFill('oklch(50% 0.2 265)', 'muted');
    expect(fill).toBe(
      `color(from oklch(50% 0.2 265) xyz-d65 calc(0.9505 * clamp(0, (${HEATMAP_LABEL_LUMINANCE_SWITCH} - y) * 100000, 1)) calc(clamp(0, (${HEATMAP_LABEL_LUMINANCE_SWITCH} - y) * 100000, 1)) calc(1.089 * clamp(0, (${HEATMAP_LABEL_LUMINANCE_SWITCH} - y) * 100000, 1)))`,
    );
    expect(fill).not.toContain('--cinder-chart');
  });

  test('switches where both white and black keep 4.5:1', () => {
    const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    expect(contrast(1, HEATMAP_LABEL_LUMINANCE_SWITCH)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(0, HEATMAP_LABEL_LUMINANCE_SWITCH)).toBeGreaterThanOrEqual(4.5);
  });

  test('an empty cell takes the muted colour', () => {
    expect(heatmapLabelFill(null, 'muted')).toBe('muted');
  });
});
