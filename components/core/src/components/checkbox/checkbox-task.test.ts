/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import {
  accent,
  bg,
  surface,
  surfaceRaised,
} from '../../styles/check-token-contrast-test-values.ts';
import { NON_TEXT, contrastRatio, wcagLuminance } from '../../tokens/runtime/contrast/index.ts';

setupHappyDom();

const { cleanup, render, fireEvent } = await import('@testing-library/svelte');
const { default: Checkbox } = await import('./checkbox.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const checkboxStyles = readFileSync(new URL('./checkbox.css', import.meta.url), 'utf8');

describe('Checkbox task variant (COR-2316)', () => {
  test('the default variant carries no task class', () => {
    const { container } = render(Checkbox, { id: 'plain', label: 'Plain' });
    expect(container.querySelector('.cinder-checkbox--task')).toBeNull();
    expect(container.querySelector('.cinder-checkbox-row--task')).toBeNull();
    expect(container.querySelector('.cinder-checkbox-field--task')).toBeNull();
  });

  test('variant="task" marks the field, the row and the input', () => {
    const { container } = render(Checkbox, { id: 'task', label: 'Task', variant: 'task' });
    expect(
      container.querySelector('.cinder-checkbox-field.cinder-checkbox-field--task'),
    ).not.toBeNull();
    expect(
      container.querySelector('.cinder-checkbox-row.cinder-checkbox-row--task'),
    ).not.toBeNull();
    const input = requiredInstance(container.querySelector('#task'), HTMLInputElement);
    expect(input.classList.contains('cinder-checkbox--task')).toBe(true);
    expect(input.classList.contains('cinder-checkbox')).toBe(true);
  });

  test('variant="task" does not leak onto the native input as an attribute', () => {
    const { container } = render(Checkbox, { id: 'task-attribute', variant: 'task' });
    expect(container.querySelector('#task-attribute')?.hasAttribute('variant')).toBe(false);
  });

  test('the task variant is a 20px circle that keeps the checked fill', () => {
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox-row--task\s*\{[^}]*--_cinder-checkbox-size:\s*1\.25rem;/,
    );
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox\.cinder-checkbox--task\s*\{[^}]*border-radius:\s*var\(--cinder-radius-full\);/,
    );
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox:checked\s*\{[^}]*background:\s*var\(--cinder-accent-solid\);/,
    );
  });

  for (const arm of ['light', 'dark'] as const) {
    for (const [surfaceName, surfaceToken] of Object.entries({ bg, surface, surfaceRaised })) {
      test(`${arm}: the checked fill clears 3:1 on ${surfaceName}`, () => {
        expect(
          contrastRatio(wcagLuminance(accent[arm]), wcagLuminance(surfaceToken[arm])),
        ).toBeGreaterThanOrEqual(NON_TEXT);
      });
    }
  }
});

describe('Checkbox hit area (COR-2316)', () => {
  test('the row pads the box to 24px, and to 44px under a coarse pointer', () => {
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox-row\s*\{[^}]*--_cinder-checkbox-hit:\s*1\.5rem;/,
    );
    expect(checkboxStyles).toMatch(
      /@media \(any-pointer: coarse\)\s*\{\s*\.cinder-checkbox-row\s*\{\s*--_cinder-checkbox-hit:\s*2\.75rem;/,
    );
    expect(checkboxStyles).toContain('padding: var(--_cinder-checkbox-pad);');
    expect(checkboxStyles).toContain('margin-inline: calc(-1 * var(--_cinder-checkbox-pad));');
  });

  test('a press on the row outside the box toggles the checkbox once', async () => {
    const onValueChange = mock((_next: boolean) => {});
    const { container } = render(Checkbox, { id: 'row-press', label: 'Row', onValueChange });
    const input = requiredInstance(container.querySelector('#row-press'), HTMLInputElement);
    const row = requiredInstance(container.querySelector('.cinder-checkbox-row'), HTMLElement);

    await fireEvent.click(row);

    expect(input.checked).toBe(true);
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  test('a press on the input itself is not forwarded a second time', async () => {
    const onValueChange = mock((_next: boolean) => {});
    const { container } = render(Checkbox, { id: 'input-press', onValueChange });
    const input = requiredInstance(container.querySelector('#input-press'), HTMLInputElement);

    await fireEvent.click(input);

    expect(input.checked).toBe(true);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  test('a press on the row of a disabled checkbox changes nothing', async () => {
    const onValueChange = mock((_next: boolean) => {});
    const { container } = render(Checkbox, { id: 'row-disabled', disabled: true, onValueChange });
    const input = requiredInstance(container.querySelector('#row-disabled'), HTMLInputElement);
    const row = requiredInstance(container.querySelector('.cinder-checkbox-row'), HTMLElement);

    await fireEvent.click(row);

    expect(input.checked).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox first-line alignment (COR-2360)', () => {
  test('the field aligns its items to the start and the label takes the rest of the line', () => {
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox-field\.cinder-form-field\s*\{[^}]*align-items:\s*flex-start;/,
    );
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox-field > \.cinder-form-field__label\s*\{[^}]*flex:\s*1 1 0%;/,
    );
  });

  test('a labelled field tells the row the label line height', () => {
    expect(checkboxStyles).toMatch(
      /\.cinder-checkbox-field:has\(> \.cinder-form-field__label\)\s*\{\s*--_cinder-checkbox-line:\s*calc\(var\(--cinder-text-sm\) \* var\(--cinder-leading-normal\)\);/,
    );
  });
});
