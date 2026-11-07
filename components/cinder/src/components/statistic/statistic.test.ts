/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Statistic } = await import('./statistic.svelte');
const { default: statVariables } = await import('./statistic.variables.ts');
const { createRawSnippet } = await import('svelte');

afterEach(() => cleanup());

function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

describe('Statistic', () => {
  test('loading keeps the label, stands a placeholder where the value was, and leaves the caption out', () => {
    const { container } = render(Statistic, {
      label: 'Running now',
      value: 0,
      caption: 'Nothing is running',
      attention: false,
      loading: true,
    });
    const group = container.querySelector('.cinder-statistic');
    expect(group?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.cinder-statistic__label')?.textContent).toBe('Running now');
    expect(container.querySelectorAll('.cinder-statistic__value .cinder-skeleton')).toHaveLength(1);
    // Never a zero while the figure is being read, and no caption describing one.
    expect(container.querySelector('.cinder-statistic__value')?.textContent?.trim()).toBe('');
    expect(container.querySelector('.cinder-statistic__caption')).toBeNull();
    expect(group?.getAttribute('aria-describedby')).toBeNull();
    // The group is named by its label alone while the value is a placeholder.
    expect(group?.getAttribute('aria-labelledby')).toBe(
      container.querySelector('.cinder-statistic__label')?.id,
    );
  });

  test('is not busy by default, and a value shows as before', () => {
    const { container } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    expect(container.querySelector('.cinder-statistic')?.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('.cinder-statistic__value')?.textContent).toBe('$1,000');
  });

  test('renders a .cinder-statistic element with role="group"', () => {
    const { container } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    const el = container.querySelector('.cinder-statistic');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('role')).toBe('group');
  });

  test('resolves unthemed defaults to the text tokens, keeping the muted hierarchy', () => {
    // Regression pin. These previously resolved to `currentColor` (the shared
    // chart default), and because the component writes them as INLINE custom
    // properties, the `var(--_cinder-chart-*, …)` fallbacks in statistic.css
    // could never apply — so an unthemed Statistic painted its label, icon,
    // and change description at full text colour, identical to the value.
    // `muted` must stay a distinct, contrast-tuned token, not `currentColor`
    // and not an opacity multiplier (this is text, held to 4.5:1).
    const { container } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    const style = container.querySelector('.cinder-statistic')?.getAttribute('style') ?? '';
    expect(style).toContain('--_cinder-chart-foreground: var(--cinder-text-default)');
    expect(style).toContain('--_cinder-chart-muted: var(--cinder-text-muted)');
    expect(style).toContain('--_cinder-chart-background: transparent');
  });

  test('a partial theme keeps currentColor inheritance for the fields it omits', () => {
    // The token substitution is all-or-nothing on `theme`'s presence. A
    // per-field fallback would drop the application-wide (light-theme: dark)
    // `--cinder-text-muted` onto this caller's black panel, making the label
    // unreadable — and would contradict the documented partial-theme contract
    // that omitted fields inherit the surrounding application.
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      theme: { foreground: 'white', background: 'black' },
    });
    const root = container.querySelector<HTMLElement>('.cinder-statistic');
    expect(root?.style.getPropertyValue('--_cinder-chart-foreground')).toBe('white');
    expect(root?.style.getPropertyValue('--_cinder-chart-muted')).toBe('currentColor');
    expect(root?.style.getPropertyValue('--_cinder-chart-background')).toBe('black');
  });

  test('an explicit currentColor theme opts back into ancestor colour inheritance', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      theme: { foreground: 'currentColor', muted: 'currentColor' },
    });
    const root = container.querySelector<HTMLElement>('.cinder-statistic');
    expect(root?.style.getPropertyValue('--_cinder-chart-foreground')).toBe('currentColor');
    expect(root?.style.getPropertyValue('--_cinder-chart-muted')).toBe('currentColor');
  });

  test('preserves consumer inline styles while applying theme variables', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      style: 'border: 1px solid red;',
    });
    const root = container.querySelector<HTMLElement>('.cinder-statistic');
    expect(root?.getAttribute('style')).toContain('border: 1px solid red');
    expect(root?.style.getPropertyValue('--_cinder-chart-foreground')).toBe(
      'var(--cinder-text-default)',
    );
  });

  test('applies custom theme colors without removing change direction cues', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      theme: {
        foreground: 'CanvasText',
        muted: 'GrayText',
        background: 'Canvas',
      },
      change: { direction: 'up', value: '4.75%' },
    });

    const root = container.querySelector('.cinder-statistic');
    const style = root?.getAttribute('style') ?? '';
    expect(style).toContain('--_cinder-chart-foreground: CanvasText');
    expect(style).toContain('--_cinder-chart-muted: GrayText');
    expect(style).toContain('--_cinder-chart-background: Canvas');
    expect(
      root?.querySelector('.cinder-statistic__change')?.getAttribute('data-cinder-direction'),
    ).toBe('up');
    expect(root?.querySelector('.cinder-statistic__change-icon')?.textContent).toBe('↑');
    expect(root?.querySelector('.cinder-statistic__change-value')?.textContent).toBe('4.75%');
  });

  test('aria-labelledby references both the label and value element ids', () => {
    const { container } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    const root = container.querySelector('.cinder-statistic');
    const ariaLabelledby = root?.getAttribute('aria-labelledby') ?? '';
    // A statistic is announced as label + value together (see stat.a11y.md):
    // aria-labelledby points at both the label span and the value span so a
    // screen reader user hears "Revenue $1,000" as one atomic accessible name.
    const ids = ariaLabelledby.split(' ').filter(Boolean);
    expect(ids).toHaveLength(2);
    expect(container.querySelector('#' + ids[0])?.textContent).toContain('Revenue');
    expect(container.querySelector('#' + ids[1])?.textContent).toContain('$1,000');
  });

  test('renders the label and value text', () => {
    const { container } = render(Statistic, { label: 'Monthly Revenue', value: '$42,000' });
    expect(container.querySelector('.cinder-statistic__label')?.textContent).toBe(
      'Monthly Revenue',
    );
    expect(container.querySelector('.cinder-statistic__value')?.textContent).toBe('$42,000');
  });

  test('numeric value is formatted via formatNumber', () => {
    const { container } = render(Statistic, { label: 'Users', value: 1234567 });
    expect(container.querySelector('.cinder-statistic__value')?.textContent).toBe('1,234,567');
  });

  test('string value is rendered verbatim', () => {
    const { container } = render(Statistic, { label: 'ARR', value: '$1.2M' });
    expect(container.querySelector('.cinder-statistic__value')?.textContent).toBe('$1.2M');
  });

  test('numeric value with valueFormatOptions renders correctly (percent style multiplies by 100)', () => {
    const { container } = render(Statistic, {
      label: 'Conversion',
      value: 0.123,
      valueFormatOptions: { style: 'percent', maximumFractionDigits: 1 },
    });
    expect(container.querySelector('.cinder-statistic__value')?.textContent).toBe('12.3%');
  });

  test('numeric value respects valueLocale', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: 1234.5,
      valueLocale: 'de-DE',
    });
    expect(container.querySelector('.cinder-statistic__value')?.textContent).toBe('1.234,5');
  });

  test('change element is not rendered when change prop is omitted', () => {
    const { container } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    expect(container.querySelector('.cinder-statistic__change')).toBeNull();
  });

  test('icon wrapper is not rendered when icon prop is omitted', () => {
    const { container } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    expect(container.querySelector('.cinder-statistic__icon')).toBeNull();
  });

  test('change without label or description synthesizes sr-only text for up direction', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction: 'up', value: '4.75%' },
    });
    const srOnly = container.querySelector('.cinder-statistic__change .cinder-sr-only');
    expect(srOnly?.textContent).toBe('increased by 4.75%');
  });

  test('change without label or description synthesizes sr-only text for down direction', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction: 'down', value: '12' },
    });
    const srOnly = container.querySelector('.cinder-statistic__change .cinder-sr-only');
    expect(srOnly?.textContent).toBe('decreased by 12');
  });

  test('change without label or description synthesizes sr-only text for neutral direction', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction: 'neutral', value: '0' },
    });
    const srOnly = container.querySelector('.cinder-statistic__change .cinder-sr-only');
    expect(srOnly?.textContent).toBe('no change, 0');
  });

  test.each([
    ['up', '↑'],
    ['down', '↓'],
    ['neutral', '→'],
  ] as const)('change direction %s renders the expected visible glyph', (direction, glyph) => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction, value: '1%' },
    });
    expect(container.querySelector('.cinder-statistic__change-icon')?.textContent).toBe(glyph);
  });

  test('change with description appends description to synthesized sr-only text', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction: 'up', value: '4.75%', description: 'from last month' },
    });
    const srOnly = container.querySelector('.cinder-statistic__change .cinder-sr-only');
    expect(srOnly?.textContent).toBe('increased by 4.75% from last month');
    const descEl = container.querySelector('.cinder-statistic__change-description');
    expect(descEl?.textContent).toBe('from last month');
    expect(descEl?.getAttribute('aria-hidden')).toBe('true');
  });

  test('change.label is used verbatim in the sr-only span', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: {
        direction: 'up',
        value: '4.75%',
        description: 'from last month',
        label: 'Revenue increased significantly',
      },
    });
    const srOnly = container.querySelector('.cinder-statistic__change .cinder-sr-only');
    expect(srOnly?.textContent).toBe('Revenue increased significantly');
    // Visible content still renders unchanged
    expect(container.querySelector('.cinder-statistic__change-value')?.textContent).toBe('4.75%');
    expect(container.querySelector('.cinder-statistic__change-description')?.textContent).toBe(
      'from last month',
    );
  });

  test('consumer role prop does not override component role="group"', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      role: 'presentation',
    });
    const root = container.querySelector('.cinder-statistic');
    expect(root?.getAttribute('role')).toBe('group');
  });

  test('consumer aria-labelledby does not override component aria-labelledby', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      'aria-labelledby': 'custom-id',
    });
    const root = container.querySelector('.cinder-statistic');
    const ariaLabelledby = root?.getAttribute('aria-labelledby') ?? '';
    expect(ariaLabelledby).not.toBe('custom-id');
    // The component owns aria-labelledby and points it at its own label + value
    // spans, so a consumer-forwarded value cannot break the statistic's name.
    const ids = ariaLabelledby.split(' ').filter(Boolean);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(container.querySelector('#' + id)).not.toBeNull();
    }
  });

  test('data-cinder-direction on change element reflects change.direction', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction: 'down', value: '5%' },
    });
    const changeEl = container.querySelector('.cinder-statistic__change');
    expect(changeEl?.getAttribute('data-cinder-direction')).toBe('down');
  });

  test('glyph, visible value, and description spans inside change are aria-hidden', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      change: { direction: 'up', value: '10%', description: 'vs last quarter' },
    });
    expect(
      container.querySelector('.cinder-statistic__change-icon')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      container.querySelector('.cinder-statistic__change-value')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(
      container.querySelector('.cinder-statistic__change-description')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  test('icon snippet renders inside .cinder-statistic__icon with aria-hidden="true"', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      icon: textSnippet('$'),
    });
    const iconWrapper = container.querySelector('.cinder-statistic__icon');
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(iconWrapper?.textContent).toContain('$');
  });

  test('class prop is merged with cinder-statistic on the root', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      class: 'my-custom-class',
    });
    const root = container.querySelector('.cinder-statistic');
    expect(root?.getAttribute('class')).toContain('cinder-statistic');
    expect(root?.getAttribute('class')).toContain('my-custom-class');
  });

  test('benign rest props are forwarded to the root element', () => {
    const { container } = render(Statistic, {
      label: 'Revenue',
      value: '$1,000',
      'data-testid': 'revenue-stat',
    });
    const root = container.querySelector('.cinder-statistic');
    expect(root?.getAttribute('data-testid')).toBe('revenue-stat');
  });

  test('explicit id prop sets the base for labelId', () => {
    const { container } = render(Statistic, {
      id: 'my-revenue-stat',
      label: 'Revenue',
      value: '$1,000',
    });
    const root = container.querySelector('.cinder-statistic');
    expect(root?.getAttribute('id')).toBe('my-revenue-stat');
    const ariaLabelledby = root?.getAttribute('aria-labelledby') ?? '';
    // aria-labelledby derives both ids from the explicit id base
    expect(ariaLabelledby).toBe('my-revenue-stat-label my-revenue-stat-value');
    expect(container.querySelector('#my-revenue-stat-label')?.textContent).toContain('Revenue');
    expect(container.querySelector('#my-revenue-stat-value')?.textContent).toContain('$1,000');
  });

  test('two Statistic instances without an id prop get different auto-generated ids', () => {
    const { container: c1 } = render(Statistic, { label: 'Revenue', value: '$1,000' });
    const { container: c2 } = render(Statistic, { label: 'Revenue', value: '$2,000' });
    const id1 = c1.querySelector('.cinder-statistic')?.getAttribute('aria-labelledby');
    const id2 = c2.querySelector('.cinder-statistic')?.getAttribute('aria-labelledby');
    // $props.id() ensures each instance gets unique IDs even with the same label.
    expect(id1).not.toBe(id2);
  });

  test('public CSS variables cover compact metric typography and spacing', async () => {
    expect(statVariables).toEqual([
      '--cinder-statistic-change-font-size',
      '--cinder-statistic-change-gap',
      '--cinder-statistic-column-gap',
      '--cinder-statistic-label-font-size',
      '--cinder-statistic-row-gap',
      '--cinder-statistic-value-font-size',
      '--cinder-statistic-value-font-weight',
      '--cinder-statistic-value-line-height',
    ]);

    const css = await Bun.file(new URL('./statistic.css', import.meta.url)).text();
    expect(css).toContain('row-gap: var(--cinder-statistic-row-gap,');
    expect(css).toContain('column-gap: var(--cinder-statistic-column-gap,');
    expect(css).toContain('font-size: var(--cinder-statistic-label-font-size,');
    expect(css).toContain('font-size: var(--cinder-statistic-value-font-size,');
    expect(css).toContain('font-size: var(--cinder-statistic-change-font-size,');
  });
});

const statisticCss = await Bun.file(new URL('./statistic.css', import.meta.url)).text();

describe('Statistic attention dot', () => {
  test('draws no dot by default, so a zero or healthy count stays plain', () => {
    const { container } = render(Statistic, { label: 'Failed in 24 hours', value: 0 });
    expect(container.querySelector('.cinder-statistic__attention')).toBeNull();
    expect(
      container.querySelector('.cinder-statistic')?.hasAttribute('data-cinder-attention'),
    ).toBe(false);
  });

  test('attention draws one decorative dot before the label text', () => {
    const { container } = render(Statistic, { label: 'Needs you', value: 2, attention: true });
    const label = container.querySelector('.cinder-statistic__label');
    const dot = label?.querySelector('.cinder-statistic__attention');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(label?.firstElementChild).toBe(dot as Element);
    expect(label?.textContent).toBe('Needs you');
    expect(
      container.querySelector('.cinder-statistic')?.hasAttribute('data-cinder-attention'),
    ).toBe(true);
  });

  test('the dot does not change the accessible name', () => {
    const { getByRole } = render(Statistic, { label: 'Needs you', value: 2, attention: true });
    expect(getByRole('group').getAttribute('aria-labelledby')).toContain('-label');
    expect(getByRole('group', { name: 'Needs you 2' })).not.toBeNull();
  });

  test('the dot is an 8px amber dot, Highlight under forced colors', () => {
    const dot = statisticCss.match(/\.cinder-statistic__attention \{([^}]*)\}/);
    expect(dot?.[1]).toContain('inline-size: 0.5rem');
    expect(dot?.[1]).toContain('block-size: 0.5rem');
    expect(dot?.[1]).toContain('background: var(--cinder-status-warning-solid)');
    const forced = statisticCss.slice(statisticCss.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('background: Highlight');
  });
});

describe('Statistic caption', () => {
  test('draws no caption by default', () => {
    const { container } = render(Statistic, { label: 'Running now', value: 0 });
    expect(container.querySelector('.cinder-statistic__caption')).toBeNull();
    expect(container.querySelector('.cinder-statistic')?.hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  test('a caption sits under the value and describes the group', () => {
    const { container, getByRole } = render(Statistic, {
      label: 'Running now',
      value: 0,
      caption: 'Nothing is running',
    });
    const caption = container.querySelector('.cinder-statistic__caption');
    expect(caption?.textContent).toBe('Nothing is running');
    const value = container.querySelector('.cinder-statistic__value');
    expect(value?.nextElementSibling).toBe(caption as Element);
    const group = getByRole('group', { name: 'Running now 0' });
    expect(group.getAttribute('aria-describedby')).toBe(caption?.id ?? '');
    expect(caption?.id).toContain('-caption');
  });

  test('a blank caption draws nothing', () => {
    const { container } = render(Statistic, { label: 'Running now', value: 0, caption: '   ' });
    expect(container.querySelector('.cinder-statistic__caption')).toBeNull();
  });

  test('a caption composes with the attention dot and a change line', () => {
    const { container } = render(Statistic, {
      label: 'Needs you',
      value: 2,
      attention: true,
      caption: 'An approval and a question',
      change: { value: '1', direction: 'up' },
    });
    expect(container.querySelector('.cinder-statistic__attention')).not.toBeNull();
    expect(container.querySelector('.cinder-statistic__caption')?.textContent).toBe(
      'An approval and a question',
    );
    expect(container.querySelector('.cinder-statistic__change')).not.toBeNull();
  });

  test('the caption is muted text', () => {
    const rule = statisticCss.match(/\.cinder-statistic__caption \{([^}]*)\}/);
    expect(rule?.[1]).toContain('color: var(--_cinder-chart-muted, currentColor)');
  });
});
