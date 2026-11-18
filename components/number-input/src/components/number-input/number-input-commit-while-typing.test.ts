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

  test('reports each number once as it is typed, and nothing again as it is left', async () => {
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
    expect(calls).toEqual([2, 25]);
    expect(input.value).toBe('25');
  });

  test('leaving a number nobody typed reports nothing, so a value shown rounded is not changed by a visit', async () => {
    const calls: Array<number | null> = [];
    // 0.0166… is shown as 0.017; committing that text would change the value.
    const { container } = render(NumberInput, {
      props: {
        id: 'n',
        value: 1 / 60,
        locale: 'en-US',
        commitWhileTyping: true,
        onValueChange: (v) => calls.push(v),
      },
    });
    const input = getInput(container);
    expect(input.value).toBe('0.017');
    await focus(input);
    await blur(input);
    expect(calls).toEqual([]);

    // Without the prop, leaving the field reports its number, as it always has.
    const plain: Array<number | null> = [];
    const other = render(NumberInput, {
      props: { id: 'p', value: 1 / 60, locale: 'en-US', onValueChange: (v) => plain.push(v) },
    });
    const untouched = getInput(other.container, 'p');
    await focus(untouched);
    await blur(untouched);
    expect(plain).toEqual([0.017]);
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
