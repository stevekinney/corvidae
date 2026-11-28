import { pressDelete, selectAsChromium } from '@lostgradient/testing/text-control';
import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';
import { blur, cleanupNumberInput, focus, getInput, type } from './number-input-test-helpers.ts';
import NumberInput from './number-input.svelte';
afterEach(cleanupNumberInput);

describe('External updates and edge cases', () => {
  test('external value change during focus discards in-progress edit', async () => {
    const { container, rerender } = render(NumberInput, {
      props: { id: 'n', value: 1, locale: 'en-US' },
    });
    const input = getInput(container);
    await focus(input);
    await type(input, '999');
    // While focused, parent updates value:
    await rerender({ id: 'n', value: 42, locale: 'en-US' });
    // Simulate blur (focus lost — parent change wins on re-format).
    await blur(input);
    expect(input.value).toBe('42');
  });

  test('locale prop change after mount re-formats', async () => {
    const { container, rerender } = render(NumberInput, {
      props: { id: 'n', value: 1234.5, locale: 'en-US' },
    });
    expect(getInput(container).value).toBe('1,234.5');
    await rerender({ id: 'n', value: 1234.5, locale: 'de-DE' });
    expect(getInput(container).value).toBe('1.234,5');
  });

  test('onValueChange commit semantics, not change semantics', async () => {
    const calls: Array<number | null> = [];
    const { container } = render(NumberInput, {
      props: {
        id: 'n',
        value: 5,
        max: 5,
        locale: 'en-US',
        onValueChange: (v: number | null) => calls.push(v),
      },
    });
    const input = getInput(container);
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(calls).toEqual([5]);
  });
});

describe('A field filled the way Playwright fills one: select(), focus(), then Delete', () => {
  // Playwright's `fill('')` runs `input.select(); input.focus()` and then presses Delete. Chromium
  // fires `focus` inside `select()`, before the range is applied, so a listener reads a caret at 0;
  // text it writes moves the range to the end. `selectAsChromium` does that, which happy-dom's
  // `select()` does not. The field shows `4,096` and edits as `4096`.
  test('the whole edit text is selected once a field whose shown text differs is focused', async () => {
    const { container } = render(NumberInput, { props: { id: 'n', value: 4096, locale: 'en-US' } });
    const input = getInput(container);
    expect(input.value).toBe('4,096');
    selectAsChromium(input);
    input.focus();
    await tick();
    expect(input.value).toBe('4096');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
  });

  test('Delete empties the field as an unsaved draft, and leaving it reports null', async () => {
    const calls: Array<number | null> = [];
    const { container } = render(NumberInput, {
      props: {
        id: 'n',
        value: 4096,
        locale: 'en-US',
        onValueChange: (next: number | null) => calls.push(next),
      },
    });
    const input = getInput(container);
    selectAsChromium(input);
    input.focus();
    await tick();
    pressDelete(input);
    await tick();
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-valuenow')).toBeNull();
    expect(calls).toEqual([]);
    await blur(input);
    expect(calls).toEqual([null]);
    expect(input.value).toBe('');
  });

  test('a field whose shown text is its edit text keeps the selection the script made', async () => {
    const { container } = render(NumberInput, { props: { id: 'n', value: 30, locale: 'en-US' } });
    const input = getInput(container);
    selectAsChromium(input);
    input.focus();
    await tick();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2]);
    pressDelete(input);
    await tick();
    expect(input.value).toBe('');
  });
});

describe('Malformed buffer preserved across re-focus', () => {
  test('user can re-focus a malformed field and still see/correct their text', async () => {
    const { container } = render(NumberInput, {
      props: { id: 'n', locale: 'en-US' },
    });
    const input = getInput(container);
    await focus(input);
    await type(input, '12abc');
    await blur(input);
    expect(input.value).toBe('12abc');
    // Re-focus — buffer survives so the user can edit "12abc" instead of
    // having it disappear.
    await focus(input);
    await tick();
    expect(input.value).toBe('12abc');
  });
});
