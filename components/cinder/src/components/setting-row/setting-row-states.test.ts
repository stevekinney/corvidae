/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Fixture } = await import('./setting-row-states-fixture.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function statusRegion(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-setting-row__status'), HTMLElement);
}

describe('SettingRow status (rows 47i, 47j, 47l)', () => {
  test('a setting at rest has no status line, but keeps the live region mounted', () => {
    const { container } = render(Fixture);
    const region = statusRegion(container);
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent?.trim()).toBe('');
    expect(container.querySelector('.cinder-setting-row__status-line')).toBeNull();
  });

  test.each([
    ['saving', 'Saving…', 'lucide-loader-circle'],
    ['saved', 'Saved just now', 'lucide-circle-check'],
    ['restart', 'Applies after restart', 'lucide-rotate-cw'],
  ] as const)('%s reads %s with its glyph', (status, words, glyph) => {
    const { container } = render(Fixture, { props: { status } });
    const line = requiredInstance(
      container.querySelector('.cinder-setting-row__status-line'),
      HTMLElement,
    );
    expect(line.textContent?.trim()).toBe(words);
    expect(line.getAttribute('data-cinder-status')).toBe(status);
    expect(line.querySelector('svg')?.classList.contains(glyph)).toBe(true);
    expect(line.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('saved-restart reads "Saved, waiting for a restart" with an amber dot', () => {
    const { container } = render(Fixture, { props: { status: 'saved-restart' } });
    const line = requiredInstance(
      container.querySelector('.cinder-setting-row__status-line'),
      HTMLElement,
    );
    expect(line.textContent?.trim()).toBe('Saved, waiting for a restart');
    expect(line.querySelector('.cinder-setting-row__dot')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(line.querySelector('svg')).toBeNull();
  });

  test('reverted reads "Reverted · in effect now" with no glyph or dot', () => {
    const { container } = render(Fixture, { props: { status: 'reverted' } });
    const line = requiredInstance(
      container.querySelector('.cinder-setting-row__status-line'),
      HTMLElement,
    );
    expect(line.textContent?.trim()).toBe('Reverted · in effect now');
    expect(line.getAttribute('data-cinder-status')).toBe('reverted');
    expect(line.querySelector('svg')).toBeNull();
    expect(line.querySelector('.cinder-setting-row__dot')).toBeNull();
  });

  test('statusLabel replaces the words and keeps the glyph and tone', () => {
    const { container } = render(Fixture, {
      props: { status: 'saved', statusLabel: 'Saved 2 minutes ago' },
    });
    const line = requiredInstance(
      container.querySelector('.cinder-setting-row__status-line'),
      HTMLElement,
    );
    expect(line.textContent?.trim()).toBe('Saved 2 minutes ago');
    expect(line.getAttribute('data-cinder-status')).toBe('saved');
  });

  test('the status line comes after the description and before the error', () => {
    const { container } = render(Fixture, {
      props: { status: 'saving', description: 'How long finished runs are kept.' },
    });
    const field = requiredInstance(
      container.querySelector('.cinder-setting-row__field'),
      HTMLElement,
    );
    const order = [...field.children].map((child) =>
      child.classList.contains('cinder-form-field__description')
        ? 'description'
        : child.classList.contains('cinder-setting-row__status')
          ? 'status'
          : child.classList.contains('cinder-form-field__error')
            ? 'error'
            : 'other',
    );
    expect(order.indexOf('description')).toBeLessThan(order.indexOf('status'));
    expect(order.indexOf('status')).toBeLessThan(order.indexOf('error'));
  });
});

describe('SettingRow label, key, error and lock (rows 47k, 47l, 47m, 47n)', () => {
  test('the raw key sits beside the label, outside it, so it stays out of the accessible name', () => {
    const { container } = render(Fixture, { props: { identifier: 'engine.maxConcurrentRuns' } });
    const row = requiredInstance(
      container.querySelector('.cinder-form-field__label-row'),
      HTMLElement,
    );
    expect(row.querySelector('label')?.textContent?.trim()).toBe('Max concurrent runs');
    expect(row.querySelector('.cinder-setting-row__identifier')?.textContent).toBe(
      'engine.maxConcurrentRuns',
    );
    expect(
      row.querySelector('label')?.contains(row.querySelector('.cinder-setting-row__identifier')),
    ).toBe(false);
  });

  test('an invalid value fails at its own field with a warning glyph and no Retry', () => {
    const { container } = render(Fixture, {
      props: { error: 'Enter a number from 1 to 3650. Nothing was saved.' },
    });
    const input = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const error = requiredInstance(
      container.querySelector('.cinder-setting-row__field > .cinder-form-field__error'),
      HTMLElement,
    );
    expect(error.textContent).toBe('Enter a number from 1 to 3650. Nothing was saved.');
    expect(error.getAttribute('aria-live')).toBe('polite');
    expect(error.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.cinder-setting-row__retry')).toBeNull();
  });

  test('a failed save keeps the typed value, announces itself, and offers a quiet Retry', async () => {
    const onRetry = mock();
    const { container } = render(Fixture, {
      props: { error: 'Couldn’t save. Your value is still in the field.', onRetry, value: '45' },
    });
    const input = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(input.value).toBe('45');
    const error = requiredInstance(
      container.querySelector('.cinder-setting-row__field > .cinder-form-field__error'),
      HTMLElement,
    );
    expect(error.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Couldn’t save. Your value is still in the field. Retry',
    );
    await fireEvent.click(requiredInstance(error.querySelector('button'), HTMLButtonElement));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('retryLabel renames the action', () => {
    const { container } = render(Fixture, {
      props: { error: 'Couldn’t save.', onRetry: () => undefined, retryLabel: 'Try again' },
    });
    expect(container.querySelector('.cinder-setting-row__retry')?.textContent?.trim()).toBe(
      'Try again',
    );
  });

  test('without an error there is no Retry, even with onRetry set', () => {
    const { container } = render(Fixture, { props: { onRetry: () => undefined } });
    expect(container.querySelector('.cinder-setting-row__retry')).toBeNull();
  });

  test('a locked setting says why with the lock glyph, and its control is read-only', () => {
    const { container } = render(Fixture, {
      props: {
        managed: {
          message:
            'Locked by your deployment (remote mode). Change it in the deployment’s configuration.',
        },
        readonly: true,
      },
    });
    const managed = requiredInstance(
      container.querySelector('.cinder-form-field__managed'),
      HTMLElement,
    );
    expect(managed.querySelector('svg')?.classList.contains('lucide-lock')).toBe(true);
    expect(managed.textContent?.trim()).toContain('Locked by your deployment');
    expect(container.querySelector('input')?.readOnly).toBe(true);
  });

  test('the control is a direct child of the row field, so the stacked layout can place it', () => {
    const { container } = render(Fixture, { props: { identifier: 'retention.runs' } });
    const field = requiredInstance(
      container.querySelector('.cinder-setting-row__field'),
      HTMLElement,
    );
    const control = field.querySelector(':scope > .cinder-input, :scope > input, :scope > div');
    expect(control).not.toBeNull();
    expect(field.firstElementChild?.classList.contains('cinder-form-field__label-row')).toBe(true);
  });

  test('stacked, the description leads, the control follows and the error sits directly under it (row 50i)', async () => {
    const css = await Bun.file(new URL('./setting-row.css', import.meta.url)).text();
    const narrow = css.slice(css.indexOf('@container'));
    const orders = [...narrow.matchAll(/\{\s*(?:[^{}]*?;\s*)?order: (\d+);\s*\}/g)].map((match) =>
      Number(match[1]),
    );
    // As the rules are written: the control (2), the description (1), status and managed (3), the error (4).
    expect(orders).toEqual([2, 1, 3, 4]);
  });

  test('the row grid outranks the form field’s flex column, whichever stylesheet loads last', async () => {
    const css = await Bun.file(new URL('./setting-row.css', import.meta.url)).text();
    // `.cinder-form-field { display: flex }` has one class; the row's layout rules need two, or a
    // bundle that loads form-field.css after this file draws every row as one column.
    const rules = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
    const layouts = [...rules.matchAll(/([^{}]+)\{[^{}]*display: (?:grid|flex);/g)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((selector) => selector.endsWith('cinder-setting-row__field'));
    expect(layouts).toEqual([
      '.cinder-form-field.cinder-setting-row__field',
      '.cinder-form-field.cinder-setting-row__field',
    ]);
  });

  test('the control keeps a size it sets itself, so a switch is never drawn zero wide', async () => {
    const css = await Bun.file(new URL('./setting-row.css', import.meta.url)).text();
    const control =
      /\.cinder-setting-row__field\s*>\s*:not\([^)]*\)\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(control).toContain('justify-self: end');
    expect(control).not.toMatch(/(^|[^-])inline-size:/m);
  });

  test('Retry is an accent link, not the error red (row 47k)', async () => {
    const css = await Bun.file(new URL('./setting-row.css', import.meta.url)).text();
    const retry = /\.cinder-setting-row__retry \{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(retry).toContain('color: var(--cinder-accent-text)');
  });
});

describe('SettingRow control width', () => {
  test('is the column the control sits in, set on the row and left alone when not given', () => {
    const { container, unmount } = render(Fixture, { props: { controlWidth: '25rem' } });
    const row = requiredInstance(container.querySelector('.cinder-setting-row'), HTMLElement);
    expect(row.style.getPropertyValue('--cinder-setting-row-control-width')).toBe('25rem');
    unmount();
    const plain = render(Fixture);
    const plainRow = requiredInstance(
      plain.container.querySelector('.cinder-setting-row'),
      HTMLElement,
    );
    expect(plainRow.getAttribute('style')).toBeNull();
  });
});
