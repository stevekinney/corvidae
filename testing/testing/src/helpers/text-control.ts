/// <reference lib="dom" />
/**
 * What a browser does to a text input that happy-dom does not, in the order Chromium does it, so a
 * test can do what Playwright's `fill` does (`select()`, `focus()`, then a key press) and end with
 * the text a browser ends with.
 */

function nativeDescriptor(input: HTMLInputElement, name: string): PropertyDescriptor {
  for (
    let owner: object | null = Object.getPrototypeOf(input);
    owner;
    owner = Object.getPrototypeOf(owner)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return descriptor;
  }
  throw new Error(`An input has no ${name}.`);
}

/**
 * `input.select()` as Chromium runs it on a field that is not focused
 * (`TextControlElement::select`): the range is recorded, the field takes focus, and its `focus`
 * listeners run while the field holds no selection yet, so they read a caret at 0. Only then is the
 * recorded range applied. A listener that writes other text moves the recorded range to the end of
 * that text, and a listener that sets a range replaces it.
 */
export function selectAsChromium(input: HTMLInputElement): void {
  if (input.ownerDocument.activeElement === input) {
    input.select();
    return;
  }
  const value = nativeDescriptor(input, 'value');
  const setSelectionRange = nativeDescriptor(input, 'setSelectionRange')
    .value as HTMLInputElement['setSelectionRange'];
  const select = nativeDescriptor(input, 'select').value as HTMLInputElement['select'];
  const read = (): string => value.get?.call(input) as string;
  let recorded: [number, number] = [0, read().length];

  // No selection is in the field while its focus listeners run.
  setSelectionRange.call(input, 0, 0);
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: read,
    set(next: string) {
      const before = read();
      value.set?.call(input, next);
      if (read() !== before) recorded = [read().length, read().length];
    },
  });
  Object.defineProperty(input, 'setSelectionRange', {
    configurable: true,
    value(start: number, end: number, direction?: 'forward' | 'backward' | 'none') {
      setSelectionRange.call(input, start, end, direction);
      recorded = [input.selectionStart ?? 0, input.selectionEnd ?? 0];
    },
  });
  Object.defineProperty(input, 'select', {
    configurable: true,
    value() {
      select.call(input);
      recorded = [0, read().length];
    },
  });
  try {
    input.focus();
  } finally {
    Reflect.deleteProperty(input, 'value');
    Reflect.deleteProperty(input, 'setSelectionRange');
    Reflect.deleteProperty(input, 'select');
  }
  input.setSelectionRange(recorded[0], recorded[1]);
}

/**
 * A press of Delete on a focused text input: `keydown`, then what the key does unless a listener
 * prevented it, then `keyup`. It removes the selected range, or the one character after a caret,
 * and reports that with an `input` event. A caret at the end of the text has nothing after it, so
 * the text stays as it was and no `input` event is sent.
 */
export function pressDelete(input: HTMLInputElement): void {
  const view = input.ownerDocument.defaultView;
  if (!view) throw new Error('The input is not in a document.');
  const key = { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true };
  if (input.dispatchEvent(new view.KeyboardEvent('keydown', key))) {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const text = input.value;
    const next = `${text.slice(0, start)}${text.slice(start === end ? start + 1 : end)}`;
    if (next !== text) {
      input.value = next;
      input.setSelectionRange(start, start);
      input.dispatchEvent(
        new view.InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'deleteContentForward',
        }),
      );
    }
  }
  input.dispatchEvent(new view.KeyboardEvent('keyup', key));
}
