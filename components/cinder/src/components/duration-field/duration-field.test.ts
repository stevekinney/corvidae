/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: DurationField } = await import('./duration-field.svelte');
const { DURATION_UNITS, describeDuration, durationUnitFor, fromMilliseconds, toMilliseconds } =
  await import('./duration-units.ts');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function numberOf(container: HTMLElement): HTMLInputElement {
  return requiredInstance(container.querySelector('input'), HTMLInputElement);
}

function unitOf(container: HTMLElement): HTMLSelectElement {
  return requiredInstance(container.querySelector('select'), HTMLSelectElement);
}

describe('DurationField', () => {
  test('shows a stored value in the largest unit that holds it whole', () => {
    const { container } = render(DurationField, {
      props: { id: 'timeout', label: 'Timeout', value: 90_000 },
    });
    expect(numberOf(container).value).toBe('90');
    expect(unitOf(container).value).toBe('s');
  });

  test('reports milliseconds when the number or the unit changes', async () => {
    const onValueChange = mock();
    const { container } = render(DurationField, {
      props: { id: 'timeout', label: 'Timeout', value: 30_000, onValueChange },
    });
    const input = numberOf(container);
    await fireEvent.input(input, { target: { value: '45' } });
    await fireEvent.blur(input);
    expect(onValueChange).toHaveBeenLastCalledWith(45_000);
  });

  test('a unit chosen by the person survives their own edit coming back', async () => {
    const { container, rerender } = render(DurationField, {
      props: { id: 'timeout', label: 'Timeout', value: 60_000 },
    });
    expect(unitOf(container).value).toBe('min');
    await fireEvent.change(unitOf(container), { target: { value: 's' } });
    expect(unitOf(container).value).toBe('s');
    expect(numberOf(container).value).toBe('60');
    // The same value arriving again keeps the chosen unit; a different one picks the unit anew.
    await rerender({ value: 60_000 });
    expect(unitOf(container).value).toBe('s');
    await rerender({ value: 7_200_000 });
    expect(unitOf(container).value).toBe('h');
  });

  test('a fixed unit is text inside the number frame, with no select (row W68 settings)', () => {
    const { container } = render(DurationField, {
      props: {
        id: 'claim-renew',
        label: 'Renew interval',
        value: 15_000,
        unit: 's',
        unitSelectable: false,
      },
    });
    expect(container.querySelector('select')).toBeNull();
    expect(numberOf(container).value).toBe('15');
    expect(container.querySelector('.cinder-number-input__adornment')?.textContent).toBe('seconds');
  });

  test('the unit select has its own id and name, apart from the number', () => {
    const { container } = render(DurationField, {
      props: { id: 'timeout', label: 'Timeout', value: 1000 },
    });
    expect(unitOf(container).id).toBe('timeout-unit');
    expect(numberOf(container).id).toBe('timeout');
    expect(container.querySelector('[for="timeout-unit"]')?.textContent).toContain('Timeout unit');
  });

  test('marks the number invalid with its error', () => {
    const { container } = render(DurationField, {
      props: { id: 'timeout', label: 'Timeout', value: 1000, error: 'Enter a duration.' },
    });
    expect(numberOf(container).getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('#timeout-error')?.textContent?.trim()).toBe(
      'Enter a duration.',
    );
  });

  test('disables the number and the unit together', () => {
    const { container } = render(DurationField, {
      props: { id: 'timeout', label: 'Timeout', value: 1000, disabled: true },
    });
    expect(numberOf(container).disabled).toBe(true);
    expect(unitOf(container).disabled).toBe(true);
  });
});

describe('duration units', () => {
  test('pick, convert and round', () => {
    expect(durationUnitFor(3_600_000)).toBe('h');
    expect(durationUnitFor(1500)).toBe('ms');
    expect(durationUnitFor(null)).toBe('ms');
    expect(fromMilliseconds(90_000, 'min')).toBe(1.5);
    expect(toMilliseconds(1.5, 'min', true)).toBe(90_000);
    expect(toMilliseconds(0.0005, 's', true)).toBe(1);
    expect(DURATION_UNITS.map((unit) => unit.name)).toEqual([
      'milliseconds',
      'seconds',
      'minutes',
      'hours',
    ]);
  });

  test('a custom unit list picks from its own units', () => {
    const units = [
      { value: 's', label: 's', milliseconds: 1000 },
      { value: 'd', label: 'd', milliseconds: 86_400_000 },
    ];
    expect(durationUnitFor(172_800_000, units)).toBe('d');
    expect(durationUnitFor(500, units)).toBe('s');
    expect(fromMilliseconds(172_800_000, 'd', units)).toBe(2);
  });
});

describe('describeDuration', () => {
  test.each([
    [1000, '1 second'],
    [30_000, '30 seconds'],
    [120_000, '2 minutes'],
    [90_000, '1 minute 30 seconds'],
    [3_600_000, '1 hour'],
    [5_400_000, '1 hour 30 minutes'],
    [250, '250 milliseconds'],
    [1, '1 millisecond'],
    [0, '0 seconds'],
  ])('%d ms reads %s', (milliseconds, words) => {
    expect(describeDuration(milliseconds)).toBe(words);
  });
});
