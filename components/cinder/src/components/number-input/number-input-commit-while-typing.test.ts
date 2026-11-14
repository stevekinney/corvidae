import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { blur, cleanupNumberInput, focus, getInput, type } from './number-input-test-helpers.ts';
import NumberInput from './number-input.svelte';
afterEach(cleanupNumberInput);

describe('commitWhileTyping', () => {
  test('reports nothing until the field is left, by default', async () => {
    const calls: Array<number | null> = [];
    const { container } = render(NumberInput, {
      props: { id: 'n', value: 1, locale: 'en-US', onValueChange: (v) => calls.push(v) },
    });
    const input = getInput(container);
    await focus(input);
    await type(input, '25');
    expect(calls).toEqual([]);
    await blur(input);
    expect(calls).toEqual([25]);
  });

  test('reports each number as it is typed, and again as it is left', async () => {
    const calls: Array<number | null> = [];
    const { container } = render(NumberInput, {
      props: {
        id: 'n',
        value: 1,
        locale: 'en-US',
        commitWhileTyping: true,
        onValueChange: (v) => calls.push(v),
      },
    });
    const input = getInput(container);
    await focus(input);
    await type(input, '2');
    await type(input, '25');
    expect(calls).toEqual([2, 25]);
    await blur(input);
    expect(calls).toEqual([2, 25, 25]);
  });

  test('reports an emptied field as null, without marking a required field invalid while it is focused', async () => {
    const calls: Array<number | null> = [];
    const { container } = render(NumberInput, {
      props: {
        id: 'n',
        value: 5,
        required: true,
        locale: 'en-US',
        commitWhileTyping: true,
        onValueChange: (v) => calls.push(v),
      },
    });
    const input = getInput(container);
    await focus(input);
    await type(input, '');
    expect(calls).toEqual([null]);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('#n-internal-error')).toBeNull();
    // Leaving it empty is the person's answer, and a required field says so then.
    await blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  test('leaves text that is not a number yet in the field, unreported and unflagged until it is left', async () => {
    const calls: Array<number | null> = [];
    const { container } = render(NumberInput, {
      props: {
        id: 'n',
        value: null,
        locale: 'en-US',
        commitWhileTyping: true,
        onValueChange: (v) => calls.push(v),
      },
    });
    const input = getInput(container);
    await focus(input);
    await type(input, '-');
    expect(calls).toEqual([]);
    expect(input.value).toBe('-');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    await type(input, '-3');
    expect(calls).toEqual([-3]);
    await type(input, '-3.');
    // A trailing separator is still the same number, and the text the person typed stays.
    expect(input.value).toBe('-3.');
    expect(calls.at(-1)).toBe(-3);
    await blur(input);
    expect(input.value).toBe('-3');
  });

  test('passes size to the field', () => {
    const { container } = render(NumberInput, { props: { id: 'n', value: 1, size: 'sm' } });
    expect(container.querySelector('.cinder-input')?.getAttribute('data-cinder-size')).toBe('sm');
  });
});
