/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Sparkbar } = await import('./sparkbar.svelte');

describe('Sparkbar', () => {
  test('renders a labeled meter with fractional values by default', () => {
    const { container } = render(Sparkbar, {
      value: 0.31,
      label: 'Draft weekly changelog',
      trailing: '$0.31',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-label')).toBe('Draft weekly changelog, 31%');
    expect(el?.getAttribute('aria-valuemin')).toBe('0');
    expect(el?.getAttribute('aria-valuemax')).toBe('1');
    expect(el?.getAttribute('aria-valuenow')).toBe('0.31');
    expect(el?.getAttribute('aria-valuetext')).toBe('$0.31');
    expect(el?.textContent).toContain('Draft weekly changelog');
    expect(el?.textContent).toContain('$0.31');
  });

  test('clamps values to the configured range', () => {
    const { container } = render(Sparkbar, {
      value: 12,
      max: 10,
      label: 'Token budget',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.getAttribute('aria-valuemax')).toBe('10');
    expect(el?.getAttribute('aria-valuenow')).toBe('10');
    expect(el?.getAttribute('aria-valuetext')).toBeNull();
  });

  test('omits value text for blank trailing values', () => {
    const { container } = render(Sparkbar, {
      value: 4,
      max: 8,
      label: 'Token budget',
      trailing: '   ',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.getAttribute('aria-valuetext')).toBeNull();
    expect(container.querySelector('.cinder-sparkbar__trailing')).toBeNull();
  });

  test('uses explicit accessible value text ahead of trailing text', () => {
    const { container } = render(Sparkbar, {
      value: 4,
      max: 8,
      label: 'Token budget',
      trailing: '4k / 8k',
      ariaValueText: '4,000 of 8,000 tokens',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.getAttribute('aria-valuetext')).toBe('4,000 of 8,000 tokens');
  });

  test('forwards size, variant, class, and accessible name override', () => {
    const { container } = render(Sparkbar, {
      value: 2,
      max: 8,
      label: 'Cost',
      size: 'lg',
      variant: 'warning',
      ariaLabel: 'Session cost usage',
      class: 'custom-sparkbar',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.classList.contains('custom-sparkbar')).toBe(true);
    expect(el?.getAttribute('data-cinder-size')).toBe('lg');
    expect(el?.getAttribute('data-cinder-variant')).toBe('warning');
    expect(el?.getAttribute('aria-label')).toBe('Session cost usage');
  });

  test('resolves theme defaults through currentColor and transparent', () => {
    const { container } = render(Sparkbar, {
      value: 0.5,
      label: 'Usage',
    });

    const style = container.querySelector('[role="meter"]')?.getAttribute('style') ?? '';
    expect(style).toContain('--_cinder-chart-foreground: currentColor');
    expect(style).toContain('--_cinder-chart-muted: currentColor');
    expect(style).toContain('--_cinder-chart-background: transparent');
    expect(style).toContain('--_cinder-chart-accent: var(--cinder-chart-series-1)');
  });

  test('uses custom theme colors for foreground, background, and accent', () => {
    const { container } = render(Sparkbar, {
      value: 0.5,
      label: 'Usage',
      theme: {
        foreground: 'CanvasText',
        muted: 'GrayText',
        background: 'Canvas',
        palette: ['rebeccapurple'],
      },
    });

    const style = container.querySelector('[role="meter"]')?.getAttribute('style') ?? '';
    expect(style).toContain('--_cinder-chart-foreground: CanvasText');
    expect(style).toContain('--_cinder-chart-muted: GrayText');
    expect(style).toContain('--_cinder-chart-background: Canvas');
    expect(style).toContain('--_cinder-chart-accent: rebeccapurple');
  });

  test('paints the themed background on the root', async () => {
    const cssText = await Bun.file(new URL('./sparkbar.css', import.meta.url)).text();

    expect(cssText).toMatch(
      /\.cinder-sparkbar\s*\{[^}]*background: var\(--_cinder-chart-background, transparent\)/s,
    );
  });

  test('falls back to zero when value is not finite', () => {
    const { container } = render(Sparkbar, {
      value: NaN,
      label: 'Usage',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.getAttribute('aria-valuenow')).toBe('0');
  });

  test('falls back to a max of 1 when max is zero or negative', () => {
    const { container } = render(Sparkbar, {
      value: 0.5,
      max: -5,
      label: 'Usage',
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.getAttribute('aria-valuemax')).toBe('1');
  });

  test('keeps computed meter semantics authoritative', () => {
    const { container } = render(Sparkbar, {
      value: 3,
      max: 10,
      label: 'Usage',
      ariaLabel: '   ',
      role: 'presentation',
      'aria-valuenow': 99,
      'aria-valuemax': 99,
    });

    const el = container.querySelector('[role="meter"]');
    expect(el?.getAttribute('aria-label')).toBe('Usage, 30%');
    expect(el?.getAttribute('aria-valuenow')).toBe('3');
    expect(el?.getAttribute('aria-valuemax')).toBe('10');
  });
});

describe('Sparkbar line arm (COR-2010, row 76n)', () => {
  const storage = [1.4, 1.42, 1.45, 1.49, 1.53, 1.57, 1.6, 1.62];

  test('renders an image named by its label, with no meter semantics', () => {
    const { container } = render(Sparkbar, {
      points: storage,
      label: 'Storage use over the last 24 hours, rising to 1.6 GB',
      startLabel: '1.4 GB, 24 hours ago',
      endLabel: 'Now',
    });

    const root = container.querySelector('.cinder-sparkbar');
    expect(root?.getAttribute('role')).toBe('img');
    expect(root?.getAttribute('aria-label')).toBe(
      'Storage use over the last 24 hours, rising to 1.6 GB',
    );
    expect(root?.getAttribute('data-cinder-kind')).toBe('line');
    expect(container.querySelector('[role="meter"]')).toBeNull();
    expect(root?.hasAttribute('aria-valuenow')).toBe(false);
    // The sentence is the name; nothing inside the image is read separately.
    expect(container.querySelector('.cinder-sparkbar__label')).toBeNull();
    expect(container.querySelector('.cinder-sparkbar__plot')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(container.querySelector('.cinder-sparkbar__axis')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  test('draws a rising line that ends on a dot at the right edge, with a label at each end', () => {
    const { container } = render(Sparkbar, {
      points: storage,
      label: 'Storage use',
      startLabel: '1.4 GB, 24 hours ago',
      endLabel: 'Now',
    });

    const path = container.querySelector('.cinder-sparkbar__path');
    const coordinates = (path?.getAttribute('points') ?? '')
      .split(' ')
      .map((pair) => pair.split(',').map(Number) as [number, number]);
    expect(coordinates).toHaveLength(storage.length);
    expect(coordinates[0]?.[0]).toBe(0);
    expect(coordinates.at(-1)?.[0]).toBe(100);
    // Rising means the y of the last point is above (smaller than) the first, and stays inside the plot.
    expect(coordinates.at(-1)![1]).toBeLessThan(coordinates[0]![1]);
    for (const [, y] of coordinates) {
      expect(y).toBeGreaterThanOrEqual(12);
      expect(y).toBeLessThanOrEqual(88);
    }

    const endpoint = container.querySelector<HTMLElement>('.cinder-sparkbar__endpoint');
    expect(endpoint).not.toBeNull();
    expect(endpoint?.style.insetBlockStart).toBe(`${coordinates.at(-1)![1]}%`);

    expect(container.querySelector('.cinder-sparkbar__axis-start')?.textContent).toBe(
      '1.4 GB, 24 hours ago',
    );
    expect(container.querySelector('.cinder-sparkbar__axis-end')?.textContent).toBe('Now');
  });

  test('a flat series sits on the middle of the plot', () => {
    const { container } = render(Sparkbar, { points: [3, 3, 3], label: 'Flat' });
    const ys = (container.querySelector('.cinder-sparkbar__path')?.getAttribute('points') ?? '')
      .split(' ')
      .map((pair) => Number(pair.split(',')[1]));
    expect(ys).toEqual([50, 50, 50]);
  });

  test('skips values that are not finite and draws only the baseline for fewer than two', () => {
    const { container } = render(Sparkbar, {
      points: [Number.NaN, 2, Number.POSITIVE_INFINITY],
      label: 'One usable value',
    });
    expect(container.querySelector('.cinder-sparkbar__path')).toBeNull();
    expect(container.querySelector('.cinder-sparkbar__endpoint')).toBeNull();
    expect(container.querySelector('.cinder-sparkbar__plot')).not.toBeNull();
  });

  test('draws no axis row when neither end is labelled, and trims blank labels', () => {
    const { container } = render(Sparkbar, {
      points: storage,
      label: 'Storage use',
      startLabel: '  ',
    });
    expect(container.querySelector('.cinder-sparkbar__axis')).toBeNull();
  });

  test('an explicit ariaLabel wins over the label', () => {
    const { container } = render(Sparkbar, {
      points: storage,
      label: 'Storage use',
      ariaLabel: 'Storage rose across the day',
    });
    expect(container.querySelector('.cinder-sparkbar')?.getAttribute('aria-label')).toBe(
      'Storage rose across the day',
    );
  });

  test('size sets the plot height class hook on the root', () => {
    const { container } = render(Sparkbar, { points: storage, label: 'Storage use', size: 'lg' });
    expect(container.querySelector('.cinder-sparkbar')?.getAttribute('data-cinder-size')).toBe(
      'lg',
    );
  });
});

describe('Sparkbar line colour (COR-2010, row 76n)', () => {
  test('the line and its end dot are the accent, unless a theme palette names a colour', () => {
    const { container, unmount } = render(Sparkbar, { points: [1, 2, 3], label: 'Trend' });
    const root = container.querySelector<HTMLElement>('.cinder-sparkbar');
    expect(root?.style.getPropertyValue('--_cinder-sparkbar-line-color')).toBe('');
    unmount();

    const themed = render(Sparkbar, {
      points: [1, 2, 3],
      label: 'Trend',
      theme: { palette: ['rebeccapurple'] },
    });
    expect(
      themed.container
        .querySelector<HTMLElement>('.cinder-sparkbar')
        ?.style.getPropertyValue('--_cinder-sparkbar-line-color'),
    ).toBe('rebeccapurple');
  });
});
