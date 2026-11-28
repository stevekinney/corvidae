/// <reference lib="dom" />
import { beforeAll, describe, expect, test } from 'bun:test';

import { setupHappyDom } from './happy-dom.ts';
import { pressDelete, selectAsChromium } from './text-control.ts';

beforeAll(() => {
  setupHappyDom();
});

function inputWith(value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.value = value;
  document.body.append(input);
  return input;
}

describe('selectAsChromium', () => {
  test('lets a focus listener read a caret at 0, then selects the whole text', () => {
    const input = inputWith('4,096');
    const seen: Array<[number | null, number | null]> = [];
    input.addEventListener('focus', () => seen.push([input.selectionStart, input.selectionEnd]));
    selectAsChromium(input);
    expect(seen).toEqual([[0, 0]]);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
    input.remove();
  });

  test('moves the selection to the end of text a focus listener writes', () => {
    const input = inputWith('4,096');
    input.addEventListener('focus', () => {
      input.value = '4096';
    });
    selectAsChromium(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
    input.remove();
  });

  test('keeps a range a focus listener sets', () => {
    const input = inputWith('4,096');
    input.addEventListener('focus', () => {
      input.value = '4096';
      input.setSelectionRange(0, 4);
    });
    selectAsChromium(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
    input.remove();
  });
});

describe('pressDelete', () => {
  test('removes the selection and sends an input event', () => {
    const input = inputWith('4096');
    input.setSelectionRange(0, 4);
    const inputs: string[] = [];
    input.addEventListener('input', () => inputs.push(input.value));
    pressDelete(input);
    expect(input.value).toBe('');
    expect(inputs).toEqual(['']);
    input.remove();
  });

  test('removes nothing from a caret at the end, and sends no input event', () => {
    const input = inputWith('4096');
    input.setSelectionRange(4, 4);
    let inputs = 0;
    input.addEventListener('input', () => (inputs += 1));
    pressDelete(input);
    expect(input.value).toBe('4096');
    expect(inputs).toBe(0);
    input.remove();
  });

  test('does nothing when a keydown listener prevents it', () => {
    const input = inputWith('4096');
    input.setSelectionRange(0, 4);
    input.addEventListener('keydown', (event) => event.preventDefault());
    pressDelete(input);
    expect(input.value).toBe('4096');
    input.remove();
  });
});
